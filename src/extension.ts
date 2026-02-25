import * as vscode from "vscode";

import { captureVariable } from "./snapshotCapture";
import { applyInlineStub, removeAllInlineStubs } from "./inlineStubGenerator";
import { SnapshotItem, SnapshotTreeProvider } from "./snapshotManager";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const treeProvider = new SnapshotTreeProvider(workspaceRoot);

  const treeView = vscode.window.createTreeView("debug-replay.snapshotsView", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  const captureVarCmd = vscode.commands.registerCommand(
    "debug-replay.captureVariable",
    async () => {
      const result = await captureVariable(workspaceRoot);
      if (!result) return;

      treeProvider.refresh();

      const applied = await applyInlineStub(
        result.snapshotPath,
        result.snapshot
      );
      if (applied) {
        vscode.window.showInformationMessage(
          'Debug Replay: Stub applied. Run "Remove All Stubs" to revert.'
        );
      }
    }
  );

  const removeStubsCmd = vscode.commands.registerCommand(
    "debug-replay.removeStubs",
    async () => {
      await removeAllInlineStubs(workspaceRoot);
      vscode.window.showInformationMessage(
        "Debug Replay: All stubs removed. Functions will run normally again."
      );
    }
  );

  const listCmd = vscode.commands.registerCommand(
    "debug-replay.listSnapshots",
    () => treeView.reveal(undefined as unknown as SnapshotItem, { focus: true })
  );

  const openSnapshotCmd = vscode.commands.registerCommand(
    "debug-replay.openSnapshot",
    (item: SnapshotItem) => treeProvider.openSnapshot(item)
  );

  const deleteSnapshotCmd = vscode.commands.registerCommand(
    "debug-replay.deleteSnapshot",
    (item: SnapshotItem) => treeProvider.deleteSnapshot(item)
  );

  const deleteAllCmd = vscode.commands.registerCommand(
    "debug-replay.deleteAll",
    () => treeProvider.deleteAll()
  );

  context.subscriptions.push(
    treeView,
    captureVarCmd,
    removeStubsCmd,
    listCmd,
    openSnapshotCmd,
    deleteSnapshotCmd,
    deleteAllCmd
  );
}

export function deactivate(): void {}
