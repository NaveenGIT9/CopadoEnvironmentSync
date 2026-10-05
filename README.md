# CopadoEnvironmentSync

`plugin-int-sync` — a VS Code extension (Copado Environment Sync).

## Install

The packaged extension is committed in this repo: **`copado-env-sync-1.0.0.vsix`**.

**From the VS Code UI**
1. Download `copado-env-sync-1.0.0.vsix` from this repo.
2. Open Extensions (`Ctrl+Shift+X`) → `…` menu → **Install from VSIX…** → pick the file.
3. Run **Developer: Reload Window**.

**From a terminal**
```
code --install-extension copado-env-sync-1.0.0.vsix --force
```

To update, install the new file over the old one (`--force`).

## Build from source

```
npm install
npm run package
```

This compiles the TypeScript and produces `copado-env-sync-1.0.0.vsix` (requires Node 18+ and `vsce`).
