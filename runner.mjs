/**
 * INT Sync Runner — Node.js ESM orchestrator for Copado INT Sync
 *
 * Implements the full deploy-gated forward integration workflow:
 * Step 1  → Global preflight (git fetch, verify remote)
 * Step 2  → Per-target auth gate (sf org display)
 * Step 3  → Cut staging branch from INT tip (git worktree)
 * Step 4  → Merge source + content-first conflict resolution
 * Step 5  → Delta compute → org_ref_strip → progressive_deploy (THE GATE)
 * Step 6  → Promote INT branch (only after gate passes)
 * Step 7  → Cleanup worktree + staging branch
 *
 * Communicates with the panel via JSON lines on stdout.
 * Receives resolve-conflict commands from panel via stdin JSON lines.
 */

import { spawnSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { tmpdir, EOL } from 'os';

// ── Org config ──────────────────────────────────────────────────────────────
// Keys = sf CLI alias (case-insensitive lookup), values include the git branch name
const ORG_MAP_ENTRIES = [
  { aliases: ['RBKINT-CSADMN', 'rbkintcsad'],   branch: 'rbkintcsad',  suffix: 'csad' },
  { aliases: ['RBKINT-CPQAI',  'rbkintcpqa'],   branch: 'rbkintcpqa',  suffix: 'cpqa' },
  { aliases: ['RBKINT-SLSMKTG','rbkintslmk'],   branch: 'rbkintslmk',  suffix: 'slmk' },
];

// Custom alias→branch overrides passed via --branch-map (populated at runtime)
const CUSTOM_BRANCH_MAP = new Map(); // alias.toLowerCase() → { branch, suffix }

function lookupOrg(aliasOrBranch) {
  const key = aliasOrBranch.toLowerCase();
  // Pipeline-supplied branches win (Copado is authoritative)
  const custom = CUSTOM_BRANCH_MAP.get(key);
  if (custom) return { aliases: [aliasOrBranch], branch: custom.branch, suffix: custom.suffix };
  // Fall back to hardcoded map
  return ORG_MAP_ENTRIES.find(e => e.aliases.some(a => a.toLowerCase() === key)) || null;
}

// Types where divergent conflicts need human review (flagged) instead of auto-source
const SENSITIVE_TYPES = [
  'classes', 'triggers', 'components', 'pages', 'aura', 'lwc',
  'layouts', 'fields', 'recordTypes', 'labels', 'permissionsets',
  'flows', 'flexipages', 'objects', 'profiles', 'permissionsetgroups',
  'customMetadata', 'workflows',
];

// ── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1] ?? '';
  }

  // Populate CUSTOM_BRANCH_MAP from --branch-map alias1:branch1,alias2:branch2
  if (args['branch-map']) {
    for (const pair of args['branch-map'].split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 1) continue;
      const alias  = pair.slice(0, colonIdx).trim();
      const branch = pair.slice(colonIdx + 1).trim();
      if (alias && branch) {
        const suffix = branch.slice(-4); // last 4 chars as suffix
        CUSTOM_BRANCH_MAP.set(alias.toLowerCase(), { branch, suffix });
      }
    }
  }

  return {
    source:      args.source      || 'rbkqa',
    targets:    (args.targets     || 'rbkintcsad').split(',').map(s => s.trim()).filter(Boolean),
    repoPath:    args['repo-path']  || '',
    scriptsPath: args['scripts-path'] || '',
  };
}

// ── Emit events ───────────────────────────────────────────────────────────────
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(message, level = 'info', target = null) {
  emit({ type: 'log', level, message, target });
}
function logHtml(message, level = 'info', target = null) {
  emit({ type: 'log', level, message, target, html: true });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stepStart(step, title, target = null) {
  emit({ type: 'step-start', step, title, target });
}

function stepDone(step, target = null) {
  emit({ type: 'step-done', step, target });
}

function stepError(step, message, target = null) {
  emit({ type: 'step-error', step, message, target });
}

// ── Stdin listener (conflict resolutions from panel) ─────────────────────────
const pendingResolves = new Map(); // file+target → resolver fn

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const cmd = JSON.parse(line);
    if (cmd.command === 'resolve-conflict') {
      const key = `${cmd.target}::${cmd.file}`;
      const resolver = pendingResolves.get(key);
      if (resolver) {
        pendingResolves.delete(key);
        resolver(cmd.resolution); // 'source' | 'int'
      }
    }
  } catch { /* ignore malformed */ }
});

async function waitForResolve(file, target) {
  return new Promise((resolve) => {
    pendingResolves.set(`${target}::${file}`, resolve);
  });
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function gitSafe(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return ''; }
}

// Like git() but with a 10-minute timeout for slow operations (worktree checkout, large repos)
function gitSlow(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 600_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

// ── sf CLI helper ─────────────────────────────────────────────────────────────
function sf(args, cwd, timeoutMs = 30_000) {
  const result = spawnSync('sf', args, {
    cwd,
    encoding: 'utf8',
    shell: true, // needed on Windows to find sf.cmd
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ── Python helper ─────────────────────────────────────────────────────────────
function pythonExec() {
  for (const py of ['python3', 'python']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [py], { encoding: 'utf8', shell: false });
    if (r.status === 0 && r.stdout.trim()) return py;
  }
  return 'python3';
}

const PYTHON = pythonExec();

function runPython(scriptPath, args = [], cwd = process.cwd(), timeoutMs = 120_000) {
  const result = spawnSync(PYTHON, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ── Bash helper (for progressive_deploy.sh) ───────────────────────────────────
function findBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Try where
  const r = spawnSync('where', ['bash'], { encoding: 'utf8', shell: false, timeout: 5000 });
  const first = (r.stdout ?? '').split(/\r?\n/)[0].trim();
  if (first) return first;
  return 'bash';
}

const BASH = findBash();

// Convert Windows path to POSIX for bash scripts
function toUnixPath(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

// ── Conflict resolution helpers ───────────────────────────────────────────────

function normalizeForDiff(content) {
  // Remove whitespace differences and blank lines
  return content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
}

function toLineSet(content) {
  return new Set(content.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
}

function isSensitivePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return SENSITIVE_TYPES.some(t => normalized.includes(`/${t}/`));
}

const SIG_PATTERN = /^\s*(public|private|protected|global|static)\s|<fullName>|<members>|<field>|<label>|<value>/;

function extractSignatures(content) {
  return new Set(
    content.split(/\r?\n/)
      .filter(l => SIG_PATTERN.test(l))
      .map(l => l.trim())
  );
}

function droppedSignatures(winner, loser) {
  const winnerSigs = extractSignatures(winner);
  const loserSigs  = extractSignatures(loser);
  return [...loserSigs].filter(s => !winnerSigs.has(s));
}

// Read a file from the git index (stage 1=base, 2=ours/INT, 3=theirs/source)
function gitShow(wt, stage, file) {
  try {
    const result = spawnSync('git', ['show', `:${stage}:${file}`], {
      cwd: wt,
      encoding: 'buffer',
      shell: false,
      timeout: 15_000,
    });
    if (result.status !== 0) return '';
    return result.stdout.toString('utf8');
  } catch { return ''; }
}

async function resolveConflicts(wt, source, branch, target) {
  // Get list of conflicted files
  const conflictedRaw = git(wt, 'diff', '--name-only', '--diff-filter=U');
  // Also pick up AA (both added) and DD (both deleted)
  const addAddRaw = git(wt, 'diff', '--name-only', '--diff-filter=A', '--name-only', 'HEAD...MERGE_HEAD');

  const conflicted = conflictedRaw.split('\n').filter(Boolean);

  if (conflicted.length === 0) {
    log(`No conflicts to resolve for ${branch}`, 'info', target);
    return { flagged: [] };
  }

  log(`Resolving ${conflicted.length} conflicts for ${branch} (content-first)`, 'info', target);
  emit({ type: 'conflicts-found', count: conflicted.length, target });

  const flagged = [];

  for (const file of conflicted) {
    const baseContent = gitShow(wt, 1, file);
    const intContent  = gitShow(wt, 2, file);
    const srcContent  = gitShow(wt, 3, file);

    let rule = null;
    let winner = null; // 'source' or 'int'

    // Rule 1: Byte-identical
    if (intContent === srcContent) {
      winner = 'source';
      rule = 'identical';
    }

    // Rule 2: Format-equivalent (whitespace/blank-line insensitive)
    if (!rule && normalizeForDiff(intContent) === normalizeForDiff(srcContent)) {
      winner = 'source';
      rule = 'format-only';
    }

    // Rule 3: Superset
    if (!rule) {
      const baseSet = toLineSet(baseContent);
      const intSet  = toLineSet(intContent);
      const srcSet  = toLineSet(srcContent);

      const intAdded = [...intSet].filter(l => !baseSet.has(l));
      const srcAdded = [...srcSet].filter(l => !baseSet.has(l));

      // INT ⊇ source: source added nothing INT lacks
      if (srcAdded.every(l => intSet.has(l))) {
        winner = 'int';
        rule = 'int-superset';
      }
      // Source ⊇ INT: INT added nothing source lacks
      else if (intAdded.every(l => srcSet.has(l))) {
        winner = 'source';
        rule = 'source-superset';
      }
    }

    // Rule 4: Genuinely divergent
    if (!rule) {
      const sensitive = isSensitivePath(file);
      if (!sensitive) {
        winner = 'source';
        rule = 'divergent→source';
      } else {
        // Flag for human review — get commit dates as unattended fallback
        let srcDate = '', intDate = '';
        try {
          srcDate = git(wt, 'log', '-1', '--format=%cI', `origin/${source}`, '--', file);
          intDate = git(wt, 'log', '-1', '--format=%cI', `origin/${branch}`, '--', file);
        } catch { /* dates unavailable */ }

        const unattendedWinner = (!intDate || (srcDate && srcDate > intDate)) ? 'source' : 'int';

        // Emit to panel for review
        emit({
          type: 'conflict-needs-review',
          file,
          target,
          intContent,
          srcContent,
          baseContent,
          srcDate,
          intDate,
          unattendedWinner,
        });

        // Wait for panel to send resolution (with 5-minute timeout → unattended fallback)
        let resolution = unattendedWinner;
        try {
          const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(unattendedWinner), 300_000));
          resolution = await Promise.race([waitForResolve(file, target), timeoutPromise]);
        } catch { resolution = unattendedWinner; }

        winner = resolution;
        rule = `divergent→${winner}(FLAGGED)`;
        flagged.push({ file, resolution: winner });
      }
    }

    // Apply the resolution
    if (winner === 'source') {
      gitSafe(wt, 'checkout', 'MERGE_HEAD', '--', file);
    } else {
      gitSafe(wt, 'checkout', 'HEAD', '--', file);
    }

    // Signature-drop guard on sensitive types
    let droppedMembers = [];
    if (isSensitivePath(file)) {
      const loserContent  = winner === 'source' ? intContent : srcContent;
      const winnerContent = winner === 'source' ? srcContent : intContent;
      droppedMembers = droppedSignatures(winnerContent, loserContent);
      if (droppedMembers.length > 0) {
        flagged.push({ file, rule, droppedMembers });
        emit({ type: 'sig-drop-warning', file, target, droppedMembers, rule });
      }
    }

    git(wt, 'add', file);

    emit({
      type: 'conflict-resolved',
      file,
      rule,
      winner,
      dropped: droppedMembers.length,
      target,
    });

    log(`  ${rule}: ${file} → ${winner}`, 'info', target);
  }

  return { flagged };
}

// ── Step 5: Delta deploy ──────────────────────────────────────────────────────

async function computeDelta(wt, deployBaseline, tmpDir, target) {
  log(`Computing delta from ${deployBaseline.slice(0, 8)}...`, 'info', target);

  const upsertRaw = git(wt, 'diff', '--name-only', '--diff-filter=ACMR', deployBaseline, 'HEAD', '--', 'force-app/**');
  const deleteRaw = git(wt, 'diff', '--name-only', '--diff-filter=D',    deployBaseline, 'HEAD', '--', 'force-app/**');

  const upsertLines = upsertRaw.split('\n').filter(Boolean);
  const deleteLines = deleteRaw.split('\n').filter(Boolean);

  // Drop git-quoted paths (non-ASCII / with special chars)
  const upsertClean = upsertLines.filter(l => !l.startsWith('"'));
  const deleteSafe  = deleteLines.filter(l => !l.startsWith('"'));

  writeFileSync(join(tmpDir, 'upsert.txt'), upsertClean.join('\n') + '\n');
  writeFileSync(join(tmpDir, 'upsert_clean.txt'), upsertClean.join('\n') + '\n');
  writeFileSync(join(tmpDir, 'delete.txt'), deleteSafe.join('\n') + '\n');

  log(`Delta: ${upsertClean.length} upserts, ${deleteSafe.length} deletes`, 'info', target);
  emit({ type: 'delta-computed', upserts: upsertClean.length, deletes: deleteSafe.length, target });

  return { upsertClean, deleteSafe };
}

async function runOrgRefStrip(wt, alias, tmpDir, scriptsPath, target) {
  const stripScript = join(scriptsPath, 'org_ref_strip.py');
  if (!existsSync(stripScript)) {
    log(`org_ref_strip.py not found at ${stripScript} — skipping strip`, 'warn', target);
    return;
  }

  const upsertFile = join(tmpDir, 'upsert_clean.txt');

  // Preview pass
  log('Running org_ref_strip.py (preview)...', 'info', target);
  const preview = runPython(stripScript, [
    '--org', alias,
    '--report-only',
    '--files-from', upsertFile,
    '--upsert-list', upsertFile,
  ], wt, 300_000);
  log(preview.stdout.trim() || '(no output)', 'info', target);
  if (preview.stderr.trim()) log(preview.stderr.trim(), 'warn', target);

  // Strip pass (commits will include these changes)
  log('Running org_ref_strip.py (strip)...', 'info', target);
  const strip = runPython(stripScript, [
    '--org', alias,
    '--files-from', upsertFile,
    '--upsert-list', upsertFile,
  ], wt, 600_000);
  log(strip.stdout.trim() || '(no output)', 'info', target);
  if (strip.stderr.trim()) log(strip.stderr.trim(), 'warn', target);
  if (!strip.ok) {
    log(`org_ref_strip strip pass exited ${strip.status} — continuing (deploy may flag dangling refs)`, 'warn', target);
  }

  // Rewrite pass (per-org username rewrites — never commit)
  log('Running org_ref_strip.py (rewrite)...', 'info', target);
  const rewrite = runPython(stripScript, [
    '--org', alias,
    '--mode', 'rewrite',
    '--files-from', upsertFile,
  ], wt, 300_000);
  log(rewrite.stdout.trim() || '(no output)', 'info', target);
}

async function generateManifest(wt, tmpDir, scriptsPath, deployBaseline, target) {
  log('Generating deploy manifest...', 'info', target);

  const upsertNoLbl = join(tmpDir, 'upsert_nolbl.txt');
  const upsertClean = readFileSync(join(tmpDir, 'upsert_clean.txt'), 'utf8');

  // Only strip CustomLabels from the main manifest when changed_labels.py exists to inject
  // individual label members. Without it, include the full labels file so the manifest isn't empty.
  const changedLabelsScript = join(scriptsPath, 'changed_labels.py');
  const hasLabelScript = existsSync(changedLabelsScript);
  const noLbl = hasLabelScript
    ? upsertClean.split('\n').filter(l => !l.includes('labels/CustomLabels.labels-meta.xml')).join('\n')
    : upsertClean;
  writeFileSync(upsertNoLbl, noLbl);

  const upsertFiles = noLbl.split('\n').filter(Boolean);
  if (upsertFiles.length === 0) {
    // Only labels changed AND changed_labels.py exists — generate minimal manifest skeleton
    // that the label injection block below will populate with specific label members.
    writeFileSync(join(tmpDir, 'pkg.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>67.0</version>\n</Package>\n`
    );
  } else {
    // Generate manifest using sf CLI.
    // NOTE: --output-dir must use the native Windows path, NOT toUnixPath — sf is a Node.js
    // CLI that resolves paths with Node.js on Windows, so /d/users/... is not valid there.
    const sfArgs = [
      'project', 'generate', 'manifest',
      '--output-dir', tmpDir,
      '--name', 'pkg',
      '--source-dir', ...upsertFiles,  // relative paths from git diff — forward slashes already OK
    ];
    const result = sf(sfArgs, wt, 120_000);
    if (!result.ok) {
      log(`sf project generate manifest failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`, 'warn', target);
    }

    // If sf CLI failed to write the manifest, fall back to a hand-written one.
    // For labels-only this means deploying CustomLabel:* (all labels); acceptable fallback.
    if (!existsSync(join(tmpDir, 'pkg.xml'))) {
      log('Manifest generation failed — writing fallback manifest', 'warn', target);
      const hasOnlyLabels = upsertFiles.every(f => f.includes('labels/'));
      const typesBlock = hasOnlyLabels
        ? '    <types>\n        <members>*</members>\n        <name>CustomLabel</name>\n    </types>\n'
        : '';
      writeFileSync(join(tmpDir, 'pkg.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesBlock}    <version>67.0</version>\n</Package>\n`
      );
    }
  }

  // Handle changed labels
  const hasLabels = upsertClean.includes('labels/CustomLabels.labels-meta.xml');
  if (hasLabels) {
    const changedLabelsScript = join(scriptsPath, 'changed_labels.py');
    if (existsSync(changedLabelsScript)) {
      log('Computing changed CustomLabels...', 'info', target);
      const lblFile = 'force-app/main/default/labels/CustomLabels.labels-meta.xml';
      const baseLabels = join(tmpDir, 'base_labels.xml');
      const headLabels = join(tmpDir, 'head_labels.xml');

      const baseContent = gitSafe(wt, 'show', `${deployBaseline}:${lblFile}`);
      writeFileSync(baseLabels, baseContent || '');
      const headContent = gitSafe(wt, 'show', `HEAD:${lblFile}`);
      writeFileSync(headLabels, headContent || '');

      const changed = runPython(changedLabelsScript, [baseLabels, headLabels], wt, 30_000);
      const changedNames = changed.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      log(`Changed labels: ${changedNames.length}`, 'info', target);

      if (changedNames.length > 0) {
        // Inject CustomLabel members into pkg.xml
        const pkgPath = join(tmpDir, 'pkg.xml');
        let pkgXml = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : '';
        const block = '    <types>\n' +
          changedNames.map(n => `        <members>${n}</members>\n`).join('') +
          '        <name>CustomLabel</name>\n    </types>\n';
        pkgXml = pkgXml.replace('    <version>', block + '    <version>');
        writeFileSync(pkgPath, pkgXml);
        log(`Injected ${changedNames.length} CustomLabel members`, 'info', target);
      }
    }
  }

  log('Manifest ready: ' + join(tmpDir, 'pkg.xml'), 'info', target);
}

async function runProgressiveDeploy(wt, alias, branch, tmpDir, scriptsPath, target) {
  const deployScript = join(scriptsPath, 'progressive_deploy.sh');

  if (!existsSync(deployScript)) {
    // Fallback: single deploy
    log('progressive_deploy.sh not found — running direct deploy', 'warn', target);
    return runDirectDeploy(wt, alias, tmpDir, target);
  }

  const manifest = join(tmpDir, 'pkg.xml');
  const upsertList = join(tmpDir, 'upsert_clean.txt');

  if (!existsSync(manifest)) {
    throw new Error('pkg.xml not found — manifest generation failed');
  }

  log('Starting progressive deploy (labels → schema → RecordType → apex → check-only → REAL)...', 'info', target);
  emit({ type: 'deploy-start', target });

  return new Promise((resolve, reject) => {
    const args = [
      deployScript,
      '--org', alias,
      '--branch', branch,
      '--wt', toUnixPath(wt),
      '--manifest', toUnixPath(manifest),
      '--upsert-list', toUnixPath(upsertList),
    ];

    const proc = spawn(BASH, args, {
      cwd: wt,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let outBuf = '';
    proc.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      const lines = outBuf.split('\n');
      outBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        log(line, 'deploy', target);
        // Detect stage markers
        if (/\[labels\]/i.test(line)) emit({ type: 'deploy-stage', stage: 'labels', target });
        else if (/\[schema\]/i.test(line)) emit({ type: 'deploy-stage', stage: 'schema', target });
        else if (/\[recordtype\]/i.test(line)) emit({ type: 'deploy-stage', stage: 'recordTypes', target });
        else if (/\[apex\]/i.test(line)) emit({ type: 'deploy-stage', stage: 'apex', target });
        else if (/check.only|validate/i.test(line)) emit({ type: 'deploy-stage', stage: 'checkOnly', target });
        else if (/real deploy|atomic deploy/i.test(line)) emit({ type: 'deploy-stage', stage: 'realDeploy', target });
        else if (/GATE PASS|Status=Succeeded/i.test(line)) emit({ type: 'deploy-gate-pass', target });
        else if (/GATE FAIL|Status=Failed/i.test(line)) emit({ type: 'deploy-gate-fail', target });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(text, 'stderr', target);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        emit({ type: 'deploy-gate-pass', target });
        resolve(true);
      } else {
        emit({ type: 'deploy-gate-fail', exitCode: code, target });
        resolve(false);
      }
    });
    proc.on('error', reject);
  });
}

async function runDirectDeploy(wt, alias, tmpDir, target) {
  // Fallback when progressive_deploy.sh isn't available: single real deploy
  log('Running direct deploy (fallback)...', 'info', target);
  emit({ type: 'deploy-stage', stage: 'realDeploy', target });

  const manifest = join(tmpDir, 'pkg.xml');
  if (!existsSync(manifest)) {
    throw new Error('pkg.xml not found');
  }

  // Log what's actually being deployed
  const upsertList = join(tmpDir, 'upsert_clean.txt');
  if (existsSync(upsertList)) {
    const files = readFileSync(upsertList, 'utf8').split('\n').filter(Boolean);
    log(`Deploying ${files.length} file(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''}`, 'info', target);
  }

  // Wipe sf CLI source tracking cache so it can't block deploy with "No local changes".
  // Deploy must be driven by the git diff (manifest), not by sf's local tracking opinion.
  const sfdxDir = join(wt, '.sfdx');
  try { rmSync(sfdxDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const result = spawnSync('sf', [
    'project', 'deploy', 'start',
    '--manifest', manifest,
    '--target-org', alias,
    '--ignore-conflicts',
    '--json',
  ], {
    cwd: wt,
    encoding: 'utf8',
    shell: true,
    timeout: 30 * 60 * 1000, // 30 min
    env: { ...process.env, SF_ORG_DISABLE_SOURCE_TRACKING: 'true' },
  });
  const result_ok = result.status === 0;
  const result_stdout = result.stdout ?? '';
  const result_stderr = result.stderr ?? '';

  // Log stderr (CLI warnings etc)
  const stderrClean = result_stderr.replace(/».*\n?/g, '').trim();
  if (stderrClean) log(stderrClean.slice(0, 3000), 'error', target);

  // Parse JSON output — log success detail or failure detail
  let gatePass = result_ok;
  try {
    const jsonStart = result_stdout.indexOf('{');
    const parsed = jsonStart >= 0 ? JSON.parse(result_stdout.slice(jsonStart)) : null;

    if (result_ok) {
      // ── Success path ──────────────────────────────────────────────────────
      const deployId   = parsed?.result?.id ?? 'unknown';
      const successes  = parsed?.result?.details?.componentSuccesses ?? [];
      const succArr    = Array.isArray(successes) ? successes : [successes];
      // Filter out the Package pseudo-component
      const realSucc   = succArr.filter(c => c.componentType !== '' && c.componentType !== 'Package');
      log(`Deploy ID: ${deployId}`, 'info', target);
      log(`Deployed ${realSucc.length} component(s) to org successfully`, 'success', target);
      for (const c of realSucc.slice(0, 30)) {
        logHtml(`  ✓ <span style="color:#f59e0b">${esc(c.componentType)}</span>:<span style="color:var(--green)">${esc(c.fullName)}</span>`, 'info', target);
      }
      if (realSucc.length > 30) log(`  … and ${realSucc.length - 30} more`, 'info', target);
    } else {
      // ── Failure path ──────────────────────────────────────────────────────
      const deployMsg = parsed?.message || parsed?.result?.message || '';
      if (deployMsg) log(`Deploy error: ${deployMsg}`, 'error', target);
      const failures = parsed?.result?.details?.componentFailures ?? [];
      const failArr  = Array.isArray(failures) ? failures : [failures];
      for (const f of failArr.slice(0, 20)) {
        log(`  ✗ ${f.type}:${f.fullName} — ${f.problem}`, 'error', target);
      }
      if (failArr.length > 20) log(`  … and ${failArr.length - 20} more failures`, 'error', target);
      if (!failArr.length && !deployMsg && result_stdout.trim()) {
        log(result_stdout.trim().slice(0, 2000), 'error', target);
      }
    }
  } catch {
    if (result_stdout.trim() && !result_ok) log(result_stdout.trim().slice(0, 2000), 'error', target);
  }

  if (gatePass) {
    emit({ type: 'deploy-gate-pass', target });
  } else {
    emit({ type: 'deploy-gate-fail', target });
  }
  return gatePass;
}

// ── Main per-target flow ──────────────────────────────────────────────────────

async function syncTarget(source, aliasOrBranch, repoPath, scriptsPath) {
  const target = aliasOrBranch;
  const orgCfg = lookupOrg(aliasOrBranch);
  if (!orgCfg) {
    emit({ type: 'target-skip', target: aliasOrBranch, reason: `No org mapping for "${aliasOrBranch}". Add it to ORG_MAP_ENTRIES in runner.mjs.` });
    return;
  }
  // Use the first (canonical) alias for sf CLI commands
  const alias  = orgCfg.aliases[0];
  const branch = orgCfg.branch;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const stagingBranch = `sync/${branch}-${today}`;
  const repoBase = repoPath.replace(/\\/g, '/').split('/').pop() ?? 'repo';
  const wtDir = join(repoPath, '..', `${repoBase}-${branch}`);
  const tmpDir = join(tmpdir(), `intsync-${branch}`);

  emit({ type: 'target-start', target, source, alias, stagingBranch, wtDir, tmpDir });

  // ── Step 2: Auth gate ─────────────────────────────────────────────────────
  stepStart(2, 'Auth Gate', target);
  const authResult = sf(['org', 'display', '--target-org', alias, '--json'], repoPath, 30_000);
  if (!authResult.ok) {
    stepError(2, `Org token for ${alias} is not valid or expired.\nRe-authenticate: sf org login web --alias ${alias}`, target);
    emit({ type: 'target-skip', target, reason: 'auth-failed' });
    return;
  }
  log(`Auth OK for ${alias}`, 'info', target);
  stepDone(2, target);

  // ── Step 3: Cut staging branch ────────────────────────────────────────────
  stepStart(3, 'Cut Staging Branch', target);
  try {
    // Remove stale worktree if present
    gitSafe(repoPath, 'worktree', 'remove', '--force', wtDir);
    gitSafe(repoPath, 'branch', '-D', stagingBranch);

    gitSlow(repoPath, 'worktree', 'add', '-b', stagingBranch, wtDir, `origin/${branch}`);
    const intTip = git(wtDir, 'rev-parse', `origin/${branch}`);
    log(`Staging: ${stagingBranch} (cut from ${branch}@${intTip.slice(0, 8)})`, 'info', target);
    emit({ type: 'branch-cut', stagingBranch, intTip, wtDir, target });
  } catch (err) {
    stepError(3, String(err.message), target);
    emit({ type: 'target-fail', target, step: 3 });
    return;
  }
  stepDone(3, target);

  // ── Step 4: Merge source ──────────────────────────────────────────────────
  stepStart(4, `Merge origin/${source}`, target);

  // Configure merge settings in worktree
  gitSafe(wtDir, 'config', 'merge.conflictstyle', 'zdiff3');
  gitSafe(wtDir, 'config', 'diff.algorithm', 'histogram');
  gitSafe(wtDir, 'config', 'rerere.enabled', 'false');
  gitSafe(wtDir, 'config', 'rerere.autoupdate', 'false');

  // Create tmp dir
  mkdirSync(tmpDir, { recursive: true });

  let mergeResult;
  try {
    mergeResult = spawnSync('git', ['merge', `origin/${source}`, '--no-commit', '--no-ff'], {
      cwd: wtDir, encoding: 'utf8', shell: false, timeout: 120_000,
    });
  } catch (err) {
    stepError(4, `Merge failed: ${err.message}`, target);
    emit({ type: 'target-fail', target, step: 4 });
    await cleanupWorktree(repoPath, wtDir, stagingBranch);
    return;
  }

  const mergeOut = (mergeResult.stdout ?? '') + (mergeResult.stderr ?? '');

  if (/already up.to.date/i.test(mergeOut)) {
    log(`${branch} is already up-to-date with ${source} — nothing to sync`, 'info', target);
    emit({ type: 'target-noop', target });
    stepDone(4, target);
    await cleanupWorktree(repoPath, wtDir, stagingBranch);
    return;
  }

  if (mergeResult.status !== 0) {
    // Conflicts to resolve
    const { flagged } = await resolveConflicts(wtDir, source, branch, target);
    if (flagged.length > 0) {
      emit({ type: 'flagged-conflicts', count: flagged.length, items: flagged, target });
    }
  }

  // Commit the merge
  try {
    git(wtDir, 'commit', '-m', `Sync: merge ${source} into ${branch} via ${stagingBranch}`);
    log('Merge committed', 'info', target);
  } catch (err) {
    // Check if already clean (nothing to commit)
    const status = gitSafe(wtDir, 'status', '--porcelain');
    if (status.trim()) {
      stepError(4, `Commit failed: ${err.message}`, target);
      emit({ type: 'target-fail', target, step: 4 });
      await cleanupWorktree(repoPath, wtDir, stagingBranch);
      return;
    }
  }

  stepDone(4, target);

  // ── Step 5: Delta deploy ──────────────────────────────────────────────────
  stepStart(5, 'Delta Deploy (THE GATE)', target);

  // Find deploy baseline — look for per-org anchor file first
  const anchorFile = join(repoPath, '.claude', 'skills', 'copado-int-sync', 'orgs', `${branch}.md`);
  let deployBaseline = '';

  if (existsSync(anchorFile)) {
    const anchorContent = readFileSync(anchorFile, 'utf8');
    const match = anchorContent.match(/deploy_baseline:\s*([a-f0-9]{40})/i);
    if (match) deployBaseline = match[1];
  }

  if (!deployBaseline) {
    // First run — look for a "Prod Snapshot" anchor commit left by previous tooling
    const snapLog = gitSafe(wtDir, 'log', '--oneline', '--all', '--grep', 'Prod Snapshot');
    const snapLine = snapLog.split('\n')[0];
    if (snapLine) {
      deployBaseline = snapLine.split(' ')[0];
      log(`No baseline anchor file — using snapshot commit: ${deployBaseline}`, 'info', target);
    } else {
      // Last resort: use the current target branch tip (before the merge) as baseline
      deployBaseline = git(wtDir, 'rev-parse', `origin/${branch}`);
      log(`No baseline anchor found — using target tip as baseline: ${deployBaseline.slice(0, 8)}`, 'warn', target);
    }
  }

  log(`Deploy baseline: ${deployBaseline.slice(0, 8)}`, 'info', target);

  let deployGatePassed = false;
  try {
    const { upsertClean, deleteSafe } = await computeDelta(wtDir, deployBaseline, tmpDir, target);

    if (upsertClean.length === 0 && deleteSafe.length === 0) {
      log('Delta is empty — nothing to deploy; proceeding to promote', 'info', target);
      deployGatePassed = true;
    } else {
      // Run org ref strip
      stepStart(5.1, 'Org Ref Strip', target);
      await runOrgRefStrip(wtDir, alias, tmpDir, scriptsPath, target);
      stepDone(5.1, target);

      // Generate manifest
      stepStart(5.2, 'Generate Manifest', target);
      await generateManifest(wtDir, tmpDir, scriptsPath, deployBaseline, target);
      stepDone(5.2, target);

      // Stage strip changes for commit (Step 6a)
      const strippedFiles = gitSafe(wtDir, 'diff', '--name-only');
      if (strippedFiles.trim()) {
        git(wtDir, 'add', '-A');
        git(wtDir, 'commit', '-m', `Sync: strip dangling org refs for ${branch} deploy`);
        log(`Committed ${strippedFiles.split('\n').filter(Boolean).length} stripped files`, 'info', target);
      }

      // Run progressive deploy (THE GATE)
      stepStart(5.3, 'Progressive Deploy', target);
      deployGatePassed = await runProgressiveDeploy(wtDir, alias, branch, tmpDir, scriptsPath, target);
      stepDone(5.3, target);
    }
  } catch (err) {
    stepError(5, String(err.message), target);
    emit({ type: 'target-fail', target, step: 5 });
    await cleanupWorktree(repoPath, wtDir, stagingBranch);
    return;
  }

  stepDone(5, target);

  if (!deployGatePassed) {
    log(`Deploy gate FAILED for ${branch} — branch NOT promoted`, 'error', target);
    emit({ type: 'gate-fail', target });
    await cleanupWorktree(repoPath, wtDir, stagingBranch);
    return;
  }

  // ── Step 6: Promote INT branch ─────────────────────────────────────────────
  stepStart(6, 'Promote INT Branch', target);
  try {
    git(repoPath, 'push', 'origin', `${stagingBranch}:${branch}`);
    const newTip = git(wtDir, 'rev-parse', 'HEAD');
    log(`Promoted ${branch} → ${newTip.slice(0, 8)}`, 'info', target);
    emit({ type: 'promote-done', target, newTip });
  } catch (err) {
    stepError(6, `Promote failed: ${err.message}`, target);
    emit({ type: 'target-fail', target, step: 6 });
    await cleanupWorktree(repoPath, wtDir, stagingBranch);
    return;
  }
  stepDone(6, target);

  // ── Step 7: Cleanup ───────────────────────────────────────────────────────
  stepStart(7, 'Cleanup', target);
  await cleanupWorktree(repoPath, wtDir, stagingBranch);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  stepDone(7, target);

  emit({ type: 'target-done', target, gatePass: true });
}

async function cleanupWorktree(repoPath, wtDir, stagingBranch) {
  gitSafe(repoPath, 'worktree', 'remove', '--force', wtDir);
  gitSafe(repoPath, 'branch', '-D', stagingBranch);
}

// ── Step 1: Global preflight ──────────────────────────────────────────────────

async function globalPreflight(repoPath) {
  stepStart(1, 'Global Preflight');
  // Enable long paths for Windows (avoids MAX_PATH errors on deep file trees)
  gitSafe(repoPath, 'config', 'core.longpaths', 'true');
  git(repoPath, 'fetch', 'origin');
  const remoteUrl = git(repoPath, 'remote', 'get-url', 'origin');
  const currentBranch = git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  log(`Origin: ${remoteUrl}`, 'info');
  log(`Current branch: ${currentBranch}`, 'info');
  stepDone(1);
  return currentBranch;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const { source, targets, repoPath, scriptsPath } = parseArgs(process.argv);

if (!repoPath || !existsSync(repoPath)) {
  emit({ type: 'fatal', message: `Repo path does not exist: ${repoPath}` });
  process.exit(1);
}

(async () => {
  try {
    emit({ type: 'runner-ready', source, targets, repoPath, scriptsPath });

    await globalPreflight(repoPath);

    for (const t of targets) {
      await syncTarget(source, t, repoPath, scriptsPath);
    }

    emit({ type: 'all-done', targets });
  } catch (err) {
    emit({ type: 'fatal', message: String(err.message) });
    process.exit(1);
  } finally {
    process.stdout.write('\n'); // flush
    process.exit(0);
  }
})();
