import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import type { Snapshot } from "./snapshotCapture";

// The stub is wrapped between two single-line comment markers so the revert
// logic is immune to the formatter breaking the stub across multiple lines.
//
// Inserted block looks like:
//   // data-snapshot-stub-start: <original trimmed line>
//   const result = require("...").variables["result"];
//   // data-snapshot-stub-end
const MARKER_START = "// data-snapshot-stub-start:";
const MARKER_END = "// data-snapshot-stub-end";

/**
 * Replaces the assignment line for the captured variable in the source file
 * with a `require(snapshot)` expression wrapped in revert markers.
 *
 * Works for ANY call site — same-file internal calls included — because it
 * rewrites the source rather than patching module exports.
 */
export async function applyInlineStub(
  snapshotPath: string,
  snapshot: Snapshot
): Promise<boolean> {
  const variableNames = Object.keys(snapshot.variables);
  if (variableNames.length !== 1) {
    vscode.window.showErrorMessage(
      "Data Snapshot: Inline stub requires exactly one captured variable."
    );
    return false;
  }

  const varName = variableNames[0];
  const filePath = snapshot.source.file;

  if (!filePath || !fs.existsSync(filePath)) {
    vscode.window.showErrorMessage(
      `Data Snapshot: Source file not found: ${filePath}`
    );
    return false;
  }

  const document = await vscode.workspace.openTextDocument(filePath);

  // Find lines that declare the variable (const/let/var <varName>)
  // and haven't already been stubbed.
  const assignPattern = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(varName)}\\b`
  );

  const candidates = Array.from({ length: document.lineCount }, (_, i) => i)
    .filter((i) => {
      const text = document.lineAt(i).text;
      return assignPattern.test(text) && !text.includes(MARKER_START);
    });

  if (candidates.length === 0) {
    vscode.window.showErrorMessage(
      `Data Snapshot: No declaration of "${varName}" found in ${path.basename(filePath)}.`
    );
    return false;
  }

  let lineIndex: number;
  if (candidates.length === 1) {
    lineIndex = candidates[0];
  } else {
    const pick = await vscode.window.showQuickPick(
      candidates.map((i) => ({
        label: `Line ${i + 1}`,
        detail: document.lineAt(i).text.trim(),
        lineIndex: i,
      })),
      { placeHolder: `Multiple declarations of "${varName}" — pick the line to stub` }
    );
    if (!pick) return false;
    lineIndex = pick.lineIndex;
  }

  const originalLine = document.lineAt(lineIndex);
  const originalText = originalLine.text;
  const originalTrimmed = originalText.trim();
  const indent = originalText.match(/^(\s*)/)?.[1] ?? "";

  // Preserve the declaration keyword + variable name (+ optional type annotation)
  const declMatch = originalTrimmed.match(
    /^((?:const|let|var)\s+\w+(?:\s*:\s*[^=]+)?)\s*=/
  );
  const prefix = declMatch ? declMatch[1] : `const ${varName}`;

  const stubRhs = `(await import("fs")).readFileSync(${JSON.stringify(snapshotPath)}, "utf8")`;
  const fullRhs = `JSON.parse(${stubRhs}).variables[${JSON.stringify(varName)}]`;

  const replacement = [
    `${indent}${MARKER_START} ${originalTrimmed}`,
    `${indent}/* eslint-disable */`,
    `${indent}${prefix} = ${fullRhs};`,
    `${indent}/* eslint-enable */`,
    `${indent}${MARKER_END}`,
  ].join("\n");

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, originalLine.range, replacement);
  const applied = await vscode.workspace.applyEdit(edit);

  if (applied) {
    await document.save();
  }

  return applied;
}

/**
 * Reverts every inline stub in every source file under `workspaceRoot/src`.
 * Finds start/end marker pairs and replaces the entire block with the
 * original line preserved in the start marker comment.
 */
export async function removeAllInlineStubs(workspaceRoot: string): Promise<void> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, "src/**/*.{ts,tsx,js,jsx}"),
    "**/node_modules/**"
  );

  await Promise.all(
    uris.map(async (uri) => {
      const document = await vscode.workspace.openTextDocument(uri);

      if (!document.getText().includes(MARKER_START)) return;

      const edit = new vscode.WorkspaceEdit();
      let hasEdits = false;

      let i = 0;
      while (i < document.lineCount) {
        const startLine = document.lineAt(i);
        const startText = startLine.text;

        if (!startText.trimStart().startsWith(MARKER_START)) {
          i++;
          continue;
        }

        // Extract the original line text from the start marker comment
        const markerIdx = startText.indexOf(MARKER_START);
        const originalTrimmed = startText
          .slice(markerIdx + MARKER_START.length)
          .trim();
        const indent = startText.match(/^(\s*)/)?.[1] ?? "";

        // Find the matching end marker (search forward from the start line)
        let endLineIdx = i + 1;
        while (
          endLineIdx < document.lineCount &&
          !document.lineAt(endLineIdx).text.trimStart().startsWith(MARKER_END)
        ) {
          endLineIdx++;
        }

        // Replace the entire block (start marker through end marker) with the original
        const startPos = startLine.range.start;
        const endPos =
          endLineIdx < document.lineCount
            ? document.lineAt(endLineIdx).range.end
            : startLine.range.end;

        edit.replace(
          document.uri,
          new vscode.Range(startPos, endPos),
          `${indent}${originalTrimmed}`
        );
        hasEdits = true;

        i = endLineIdx + 1;
      }

      if (hasEdits) {
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
    })
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
