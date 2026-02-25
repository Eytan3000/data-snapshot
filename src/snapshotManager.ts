import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ── Tree item ─────────────────────────────────────────────────────────────────

export class SnapshotItem extends vscode.TreeItem {
  /** Absolute path to the `.json` snapshot file. */
  readonly snapshotPath: string;

  constructor(snapshotPath: string, workspaceRoot: string) {
    const baseName = path.basename(snapshotPath, ".json");

    // Label: replace the first underscore-separated timestamp with a readable form
    // File names follow the pattern  <functionName>_<ISO-timestamp-with-dashes>
    const label = baseName.replace(/_(\d{4}-\d{2}-\d{2}T)/, " @ $1");

    super(label, vscode.TreeItemCollapsibleState.None);

    this.snapshotPath = snapshotPath;

    this.contextValue = "snapshot";
    this.tooltip = snapshotPath;
    this.iconPath = new vscode.ThemeIcon("file-code");

    // Single-click opens the JSON snapshot
    this.command = {
      command: "debug-replay.openSnapshot",
      title: "Open Snapshot",
      arguments: [this],
    };
  }
}

// ── Tree provider ─────────────────────────────────────────────────────────────

export class SnapshotTreeProvider
  implements vscode.TreeDataProvider<SnapshotItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<SnapshotItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  // ── vscode.TreeDataProvider ──────────────────────────────────────────────

  getTreeItem(element: SnapshotItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SnapshotItem[] {
    const snapshotsDir = path.join(
      this.workspaceRoot,
      ".snapshots",
      "snapshots"
    );

    if (!fs.existsSync(snapshotsDir)) {
      return [];
    }

    return fs
      .readdirSync(snapshotsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => new SnapshotItem(path.join(snapshotsDir, f), this.workspaceRoot));
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Trigger a tree refresh (call after capture or delete). */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ── Command handlers ─────────────────────────────────────────────────────

  /** Open the JSON snapshot file in the editor. */
  openSnapshot(item: SnapshotItem): void {
    vscode.window.showTextDocument(vscode.Uri.file(item.snapshotPath));
  }

  /** Delete a single snapshot. */
  deleteSnapshot(item: SnapshotItem): void {
    fs.unlinkSync(item.snapshotPath);
    this.refresh();
  }

  /** Delete every snapshot. */
  deleteAll(): void {
    const snapshotsDir = path.join(
      this.workspaceRoot,
      ".snapshots",
      "snapshots"
    );

    if (!fs.existsSync(snapshotsDir)) return;

    fs.readdirSync(snapshotsDir)
      .filter((f) => f.endsWith(".json"))
      .forEach((f) => fs.unlinkSync(path.join(snapshotsDir, f)));

    this.refresh();
  }
}
