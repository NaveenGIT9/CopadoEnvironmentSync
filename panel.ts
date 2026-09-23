import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const RUNNER_PATH = path.join(__dirname, '..', 'runner.mjs');

const NODE_EXEC_PATH = (() => {
  try {
    const r = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['node'],
      { encoding: 'utf8', shell: false, timeout: 5000 }
    );
    const first = (r.stdout ?? '').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* fall through */ }
  return process.execPath;
})();

const RUN_TIMEOUT_MS = 60 * 60 * 1000; // 60 min — deploy stages can take a while

interface OrgEntry {
  alias?: string;
  username?: string;
  orgId?: string;
  instanceUrl?: string;
  connectedStatus?: string;
  isDefaultOrg?: boolean;
  isScratch?: boolean;
}

interface PipelineEnv {
  id: string;
  name: string;
  branch: string;
  orgId: string;
  alias: string;
  username: string;
  connectedStatus: string;
  authenticated: boolean;
}

function getRepoPath(context: vscode.ExtensionContext): string {
  const cfg = vscode.workspace.getConfiguration('int-sync');
  const cfgPath = cfg.get<string>('repoPath', '').trim();
  if (cfgPath) return cfgPath;

  // Auto-detect from workspace folders
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const sfdxProject = path.join(f.uri.fsPath, 'sfdx-project.json');
    if (fs.existsSync(sfdxProject)) return f.uri.fsPath;
  }

  // Fall back to last saved
  return context.globalState.get<string>('int-sync.lastRepoPath', '');
}

function getScriptsPath(repoPath: string): string {
  const cfg = vscode.workspace.getConfiguration('int-sync');
  const cfgPath = cfg.get<string>('scriptsPath', '').trim();
  if (cfgPath) return cfgPath;
  return path.join(repoPath, '.claude', 'skills', 'copado-int-sync', 'scripts');
}

function toHttpsUrl(url: string): string {
  const m = url.match(/^git@([^:]+):(.+)$/);
  return m ? `https://${m[1]}/${m[2]}` : url;
}

function repoNameFromUri(uri: string): string {
  return uri.replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
}

export class IntSyncPanel {
  public static currentPanel: IntSyncPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeProc: ReturnType<typeof spawn> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly context: vscode.ExtensionContext;

  // Pipeline-derived state
  private pipelineRepoUri  = '';
  private pipelineRepoName = '';

  // Pending sync args — populated by preview, consumed by confirm-sync
  private pendingSyncArgs: { source: string; targets: string[]; repoPath: string; branchMap: Record<string, string> } | null = null;

  public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
    if (IntSyncPanel.currentPanel) {
      IntSyncPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'intSync',
      'Copado Environment Sync',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    IntSyncPanel.currentPanel = new IntSyncPanel(panel, extensionUri, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.webview.html = this.getHtml(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
  }

  private handleMessage(msg: {
    command: string;
    source?: string;
    targets?: string[];
    repoPath?: string;
    branchMap?: Record<string, string>;
    copadoOrg?: string;
    pipelineId?: string;
    repoUri?: string;
    file?: string;
    resolution?: string;
    content?: string;
    target?: string;
  }): void {
    if (msg.command === 'sync') {
      this.pendingSyncArgs = {
        source:    msg.source    ?? 'rbkqa',
        targets:   msg.targets   ?? ['rbkintcsad'],
        repoPath:  msg.repoPath  ?? '',
        branchMap: msg.branchMap ?? {},
      };
      this.runPreview(this.pendingSyncArgs);
    } else if (msg.command === 'confirm-sync') {
      if (this.pendingSyncArgs) {
        const a = this.pendingSyncArgs;
        this.pendingSyncArgs = null;
        this.runSync(a.source, a.targets, a.repoPath, a.branchMap);
      }
    } else if (msg.command === 'cancel-preview') {
      this.pendingSyncArgs = null;
    } else if (msg.command === 'resolve-conflict') {
      this.sendToRunner({ command: 'resolve-conflict', file: msg.file, resolution: msg.resolution, target: msg.target, content: msg.content });
    } else if (msg.command === 'abort') {
      this.abortRun();
    } else if (msg.command === 'get-config') {
      const source = vscode.workspace.getConfiguration('int-sync').get<string>('defaultSource', '');
      const copadoOrg = this.getDefaultOrg();
      const history = this.context.globalState.get<string[]>('int-sync.repoHistory', []);
      // repoPath is intentionally omitted — repo path is now driven by pipeline selection
      this.post({ type: 'config', source, copadoOrg, history });
    } else if (msg.command === 'get-orgs') {
      this.fetchOrgList();
    } else if (msg.command === 'get-pipelines') {
      const org = (msg.copadoOrg ?? '').trim();
      if (org) void this.context.globalState.update('int-sync.copadoOrg', org);
      this.fetchPipelines(org);
    } else if (msg.command === 'get-pipeline-envs') {
      // Cache repo info for this pipeline (sent from webview when user selects pipeline)
      if (msg.repoUri) {
        this.pipelineRepoUri  = msg.repoUri as string;
        this.pipelineRepoName = repoNameFromUri(this.pipelineRepoUri);
      }
      this.fetchPipelineEnvs(msg.copadoOrg ?? '', msg.pipelineId ?? '');
    } else if (msg.command === 'save-repo-path') {
      const rp = (msg.repoPath ?? '').trim();
      if (rp) {
        const history: string[] = this.context.globalState.get('int-sync.repoHistory', []);
        const deduped = [rp, ...history.filter(h => h !== rp)].slice(0, 5);
        void this.context.globalState.update('int-sync.repoHistory', deduped);
        void this.context.globalState.update('int-sync.lastRepoPath', rp);
      }
    }
  }

  private getOrgListRaw(): OrgEntry[] {
    const result = spawnSync('sf', ['org', 'list', '--json'], {
      shell: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env },
    });
    try {
      const parsed = JSON.parse(result.stdout ?? '') as {
        result?: { nonScratchOrgs?: OrgEntry[]; scratchOrgs?: OrgEntry[] };
      };
      return [
        ...(parsed.result?.nonScratchOrgs ?? []),
        ...(parsed.result?.scratchOrgs ?? []),
      ];
    } catch {
      return [];
    }
  }

  private fetchOrgList(): void {
    const result = spawnSync('sf', ['org', 'list', '--json'], {
      shell: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env },
    });
    try {
      const parsed = JSON.parse(result.stdout ?? '') as {
        result?: { nonScratchOrgs?: OrgEntry[]; scratchOrgs?: OrgEntry[] };
      };
      const orgs: OrgEntry[] = [
        ...(parsed.result?.nonScratchOrgs ?? []),
        ...(parsed.result?.scratchOrgs ?? []),
      ];
      this.post({ type: 'org-list', orgs });
    } catch {
      const errMsg = (result.stderr ?? '').trim();
      this.post({ type: 'org-list-error', message: errMsg || 'sf org list failed — is sf CLI installed?' });
    }
  }

  // Write SOQL to a temp file and run sf data query --file to avoid Windows shell quoting issues
  private runSoql(targetOrg: string, soql: string): { stdout: string; stderr: string } {
    const tmpFile = path.join(os.tmpdir(), `int-sync-${Date.now()}.soql`);
    fs.writeFileSync(tmpFile, soql, 'utf8');
    try {
      const r = spawnSync('sf', ['data', 'query', '--target-org', targetOrg, '--file', tmpFile, '--json'], {
        shell: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env },
      });
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  private fetchPipelines(copadoOrg: string): void {
    if (!copadoOrg) {
      this.post({ type: 'pipelines-error', message: 'Enter a Copado org alias first' });
      return;
    }
    const soql = [
      'SELECT Id, Name,',
      'copado__Git_Repository__r.Name,',
      'copado__Git_Repository__r.copado__URI__c',
      'FROM copado__Deployment_Flow__c',
      'ORDER BY Name ASC',
    ].join('\n');
    const { stdout, stderr } = this.runSoql(copadoOrg, soql);
    try {
      const parsed = JSON.parse(stdout) as {
        status?: number;
        result?: { records?: Array<Record<string, unknown>> };
        message?: string;
      };
      if (typeof parsed.status === 'number' && parsed.status !== 0) {
        this.post({ type: 'pipelines-error', message: parsed.message || 'SOQL query failed' });
        return;
      }
      this.post({ type: 'pipelines', records: parsed.result?.records ?? [] });
    } catch {
      this.post({ type: 'pipelines-error', message: stderr.trim() || 'Failed to query pipelines' });
    }
  }

  private fetchPipelineEnvs(copadoOrg: string, pipelineId: string): void {
    if (!pipelineId || !/^[a-zA-Z0-9]{15,18}$/.test(pipelineId)) {
      this.post({ type: 'pipeline-envs-error', message: 'Invalid pipeline ID' });
      return;
    }

    // copado__Branch__c is on the step itself (= source env's branch), not on the environment
    const soql = [
      'SELECT',
      'copado__Branch__c,',
      'copado__Source_Environment__r.Id,',
      'copado__Source_Environment__r.Name,',
      'copado__Source_Environment__r.copado__Org_ID__c,',
      'copado__Destination_Environment__r.Id,',
      'copado__Destination_Environment__r.Name,',
      'copado__Destination_Environment__r.copado__Org_ID__c',
      'FROM copado__Deployment_Flow_Step__c',
      `WHERE copado__Deployment_Flow__c = '${pipelineId}'`,
      'ORDER BY CreatedDate ASC',
    ].join('\n');

    const { stdout, stderr } = this.runSoql(copadoOrg, soql);

    const sfOrgs = this.getOrgListRaw();

    try {
      const parsed = JSON.parse(stdout) as {
        status?: number;
        result?: { records?: Array<Record<string, unknown>> };
        message?: string;
      };
      if (typeof parsed.status === 'number' && parsed.status !== 0) {
        this.post({ type: 'pipeline-envs-error', message: parsed.message || 'SOQL query failed' });
        return;
      }

      const records = parsed.result?.records ?? [];

      // Pass 1: build envId → branch map (branch lives on the step, tied to the source env)
      const branchByEnvId = new Map<string, string>();
      for (const rec of records) {
        const srcEnv = rec.copado__Source_Environment__r as Record<string, unknown> | null | undefined;
        if (srcEnv && typeof srcEnv.Id === 'string') {
          const b = String(rec.copado__Branch__c ?? '').trim();
          if (b) branchByEnvId.set(srcEnv.Id, b);
        }
      }

      // Pass 2: collect unique environments (source + destination)
      const envMap = new Map<string, PipelineEnv>();
      const normalize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

      const addEnv = (env: Record<string, unknown> | null | undefined) => {
        if (!env || typeof env.Id !== 'string') return;
        const id    = env.Id;
        if (envMap.has(id)) return;
        const name  = String(env.Name  ?? '');
        const orgId = String(env.copado__Org_ID__c ?? '');
        const branch = branchByEnvId.get(id) || '';  // only set when this env is a source

        const sfOrg = sfOrgs.find(o => {
          if (orgId && o.orgId) {
            const a = normalize(orgId), b = normalize(o.orgId);
            if (a === b || a.includes(b) || b.includes(a)) return true;
          }
          if (name) {
            if (o.alias?.toLowerCase() === name.toLowerCase()) return true;
            if (o.username?.toLowerCase().includes(name.toLowerCase())) return true;
          }
          return false;
        });

        envMap.set(id, {
          id, name, branch, orgId,
          alias:           sfOrg?.alias    || name,
          username:        sfOrg?.username  || '',
          connectedStatus: sfOrg?.connectedStatus || 'Not in CLI',
          authenticated:   !!sfOrg,
        });
      };

      for (const rec of records) {
        addEnv(rec.copado__Source_Environment__r as Record<string, unknown>);
        addEnv(rec.copado__Destination_Environment__r as Record<string, unknown>);
      }

      // Collect unique source branches from the pipeline steps (in order encountered)
      const sourceBranchSet = new Set<string>();
      for (const rec of records) {
        const b = String(rec.copado__Branch__c ?? '').trim();
        if (b) sourceBranchSet.add(b);
      }

      this.post({ type: 'pipeline-envs', envs: [...envMap.values()], sourceBranches: [...sourceBranchSet] });

      // Resolve (or clone) the git repo for this pipeline
      if (this.pipelineRepoUri) {
        this.resolveOrCloneRepo(this.pipelineRepoUri, this.pipelineRepoName);
      }
    } catch {
      this.post({ type: 'pipeline-envs-error', message: stderr.trim() || 'Failed to query pipeline environments' });
    }
  }

  private resolveOrCloneRepo(repoUri: string, repoName: string): void {
    if (!repoUri || !repoName) return;
    const httpsUri = toHttpsUrl(repoUri);

    // 1. Check open workspace folders
    for (const f of (vscode.workspace.workspaceFolders ?? [])) {
      const p = f.uri.fsPath;
      const tail = p.replace(/\\/g, '/').split('/').pop() ?? '';
      if (tail === repoName && fs.existsSync(path.join(p, '.git'))) {
        this.post({ type: 'repo-resolved', repoPath: p });
        return;
      }
    }

    // 2. Check globally saved path
    const saved = this.context.globalState.get<string>('int-sync.lastRepoPath', '');
    if (saved && fs.existsSync(path.join(saved, '.git'))) {
      const tail = saved.replace(/\\/g, '/').split('/').pop() ?? '';
      if (tail === repoName) {
        this.post({ type: 'repo-resolved', repoPath: saved });
        return;
      }
    }

    // 3. Check / reuse temp clone
    const tempBase = path.join(os.tmpdir(), 'int-sync-repos');
    const tempPath = path.join(tempBase, repoName);

    if (fs.existsSync(path.join(tempPath, '.git'))) {
      const check = spawnSync('git', ['rev-parse', '--git-dir'], {
        cwd: tempPath, shell: true, encoding: 'utf8', timeout: 5_000,
      });
      if (check.status === 0) {
        this.post({ type: 'repo-resolved', repoPath: tempPath });
        // Background fetch so remote branches are fresh
        spawnSync('git', ['fetch', '--prune', 'origin'], {
          cwd: tempPath, shell: true, encoding: 'utf8', timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return;
      }
      // Corrupted — wipe and re-clone
      try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // 4. Clone fresh (async so UI stays responsive)
    this.post({ type: 'repo-cloning', repoName });
    fs.mkdirSync(tempBase, { recursive: true });

    const cloneProc = spawn('git', ['-c', 'core.longpaths=true', 'clone', '--no-checkout', httpsUri, tempPath], {
      shell: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    cloneProc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) this.post({ type: 'repo-clone-progress', message: line });
    });

    cloneProc.on('close', (code) => {
      if (code === 0) {
        this.post({ type: 'repo-resolved', repoPath: tempPath });
      } else {
        this.post({ type: 'repo-clone-error', message: `git clone failed (exit ${code}). Set repo path manually.` });
      }
    });
  }

  private runPreview(args: { source: string; targets: string[]; repoPath: string; branchMap: Record<string, string> }): void {
    const { source, targets, repoPath, branchMap } = args;
    const resolvedRepo = repoPath || getRepoPath(this.context);
    if (!resolvedRepo || !fs.existsSync(resolvedRepo)) {
      this.post({ type: 'error', message: `Repo path does not exist: ${resolvedRepo || '(none)'}` });
      return;
    }
    const scriptsPath = getScriptsPath(resolvedRepo);

    const runnerArgs = [
      RUNNER_PATH,
      '--source', source,
      '--targets', targets.join(','),
      '--repo-path', resolvedRepo,
      '--scripts-path', scriptsPath,
      '--preview-only', 'true',
    ];
    const mapEntries = Object.entries(branchMap);
    if (mapEntries.length > 0) {
      runnerArgs.push('--branch-map', mapEntries.map(([a, b]) => `${a}:${b}`).join(','));
    }

    this.post({ type: 'preview-loading', source, targets });

    const proc = spawn(NODE_EXEC_PATH, runnerArgs, {
      shell: false,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === 'preview-result' || evt.type === 'fatal') {
            this.post(evt);
          }
        } catch { /* ignore malformed */ }
      }
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        this.post({ type: 'preview-error', message: `Preview exited with code ${code}` });
      }
    });
  }

  private runSync(source: string, targets: string[], repoPath: string, branchMap: Record<string, string> = {}): void {
    if (this.activeProc) {
      this.post({ type: 'error', message: 'A sync is already running. Abort it first.' });
      return;
    }

    const resolvedRepo = repoPath || getRepoPath(this.context);
    if (!resolvedRepo) {
      this.post({ type: 'error', message: 'No repo path configured. Set it in the dashboard or in VS Code settings (int-sync.repoPath).' });
      return;
    }
    if (!fs.existsSync(resolvedRepo)) {
      this.post({ type: 'error', message: `Repo path does not exist: ${resolvedRepo}` });
      return;
    }

    const scriptsPath = getScriptsPath(resolvedRepo);

    // Save for next time
    void this.context.globalState.update('int-sync.lastRepoPath', resolvedRepo);

    this.post({ type: 'sync-start', source, targets, repoPath: resolvedRepo });

    const args = [
      RUNNER_PATH,
      '--source', source,
      '--targets', targets.join(','),
      '--repo-path', resolvedRepo,
      '--scripts-path', scriptsPath,
    ];

    // Pass custom alias→branch overrides (for non-INT orgs)
    const mapEntries = Object.entries(branchMap);
    if (mapEntries.length > 0) {
      args.push('--branch-map', mapEntries.map(([alias, branch]) => `${alias}:${branch}`).join(','));
    }

    const proc = spawn(NODE_EXEC_PATH, args, {
      shell: false,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.activeProc = proc;

    this.activeTimer = setTimeout(() => {
      proc.kill();
      this.activeProc = null;
      this.activeTimer = null;
      this.post({ type: 'fatal', message: 'Timed out after 60 minutes.' });
    }, RUN_TIMEOUT_MS);

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          this.post(evt);
        } catch {
          this.post({ type: 'log', level: 'info', message: line });
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.post({ type: 'log', level: 'stderr', message: text });
    });

    proc.on('close', (code) => {
      if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
      this.activeProc = null;
      this.post({ type: 'process-exit', code });
    });
  }

  private sendToRunner(data: Record<string, unknown>): void {
    if (this.activeProc?.stdin && !this.activeProc.stdin.destroyed) {
      this.activeProc.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  private abortRun(): void {
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    if (this.activeProc) { this.activeProc.kill(); this.activeProc = null; }
    this.post({ type: 'aborted' });
  }

  private post(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  private getDefaultOrg(): string {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const candidates = [
      ...workspacePaths.map(p => path.join(p, '.sf', 'config.json')),
      path.join(process.cwd(), '.sf', 'config.json'),
      path.join(os.homedir(), '.sf', 'config.json'),
      path.join(os.homedir(), '.sfdx', 'sfdx-config.json'),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
        const val = cfg['target-org'] ?? cfg['defaultusername'] ?? '';
        if (val) return val;
      } catch { /* try next */ }
    }
    try {
      const result = spawnSync('sf', ['config', 'get', 'target-org', '--json'], {
        timeout: 20_000, encoding: 'utf8', shell: true,
      });
      const parsed = JSON.parse(result.stdout ?? '') as { result?: Array<{ value?: string }> };
      const val = parsed?.result?.[0]?.value ?? '';
      if (val) return val;
    } catch { /* give up */ }
    return '';
  }

  private getHtml(extensionUri: vscode.Uri): string {
    const htmlPath = path.join(__dirname, '..', 'webview', 'index.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const defaultOrg = this.getDefaultOrg();
      // Inject default org so the Copado org field is pre-filled on open
      html = html.replace('<script>', `<script>window.__defaultOrg = ${JSON.stringify(defaultOrg)};\n`);
      return html;
    }
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Copado Environment Sync</title>
    <style>body{font-family:system-ui;padding:24px;background:#1e1e2e;color:#cdd6f4}</style>
    </head><body><h2>Copado Environment Sync</h2><p>webview/index.html not found — run npm run build</p></body></html>`;
  }

  public dispose(): void {
    IntSyncPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
