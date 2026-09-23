import * as vscode from 'vscode';
import { IntSyncPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand('int-sync.open', () => {
    IntSyncPanel.createOrShow(context.extensionUri, context);
  });
  context.subscriptions.push(cmd);
}

export function deactivate(): void {}
