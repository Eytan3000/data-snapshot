import * as vscode from "vscode";

import { captureVariable } from "./snapshotCapture";
import { applyInlineStub, removeAllInlineStubs } from "./inlineStubGenerator";
import { SnapshotItem, SnapshotTreeProvider } from "./snapshotManager";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const treeProvider = new SnapshotTreeProvider(workspaceRoot);

  const treeView = vscode.window.createTreeView("data-snapshot.snapshotsView", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  const captureVarCmd = vscode.commands.registerCommand(
    "data-snapshot.captureVariable",
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
          'Data Snapshot: Stub applied. Run "Remove All Stubs" to revert.'
        );
      }
    }
  );

  const removeStubsCmd = vscode.commands.registerCommand(
    "data-snapshot.removeStubs",
    async () => {
      await removeAllInlineStubs(workspaceRoot);
      vscode.window.showInformationMessage(
        "Data Snapshot: All stubs removed. Functions will run normally again."
      );
    }
  );

  const listCmd = vscode.commands.registerCommand(
    "data-snapshot.listSnapshots",
    () => treeView.reveal(undefined as unknown as SnapshotItem, { focus: true })
  );

  const openSnapshotCmd = vscode.commands.registerCommand(
    "data-snapshot.openSnapshot",
    (item: SnapshotItem) => treeProvider.openSnapshot(item)
  );

  const deleteSnapshotCmd = vscode.commands.registerCommand(
    "data-snapshot.deleteSnapshot",
    (item: SnapshotItem) => treeProvider.deleteSnapshot(item)
  );

  const deleteAllCmd = vscode.commands.registerCommand(
    "data-snapshot.deleteAll",
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
