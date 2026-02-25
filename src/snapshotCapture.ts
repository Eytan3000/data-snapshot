import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── DAP response shapes ───────────────────────────────────────────────────────

interface DapThread {
  id: number;
  name: string;
}

interface DapStackFrame {
  id: number;
  name: string;
  source?: { path?: string };
  line?: number;
}

interface DapScope {
  name: string;
  variablesReference: number;
  presentationHint?: string;
}

interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

// ── Public snapshot shape ─────────────────────────────────────────────────────

export interface SnapshotSource {
  file: string;
  line: number;
  functionName: string;
}

export interface SnapshotFrame {
  name: string;
  id: number;
}

export interface Snapshot {
  version: 1;
  capturedAt: string;
  source: SnapshotSource;
  frame: SnapshotFrame;
  variables: Record<string, unknown>;
}

// ── Progress counter ──────────────────────────────────────────────────────────

// Tracks how many items are queued vs completed so we can show a live
// percentage in the notification progress bar.
class SerializeCounter {
  total = 0;
  completed = 0;
  private lastPct = -1;

  constructor(
    private readonly progress: vscode.Progress<{ message?: string }>
  ) {}

  addItems(n: number): void {
    this.total += n;
    this.report();
  }

  completeItem(): void {
    this.completed++;
    this.report();
  }

  private report(): void {
    if (this.total === 0) return;
    const pct = Math.min(99, Math.floor((this.completed / this.total) * 100));
    if (pct === this.lastPct) return;
    this.lastPct = pct;
    this.progress.report({
      message: `Serializing… ${this.completed} / ${this.total} items (${pct}%)`,
    });
  }
}

// ── Global DAP semaphore ──────────────────────────────────────────────────────

// Per-level concurrency limits (asyncPool) don't work for deep trees because
// each level spawns its own pool, multiplying in-flight requests exponentially.
// A single global semaphore gates ALL `variables` requests across every depth,
// keeping total concurrent DAP calls at most DAP_CONCURRENCY at any time.
const DAP_CONCURRENCY = 20;

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

// ── Serialization ─────────────────────────────────────────────────────────────

async function serializeVariable(
  session: vscode.DebugSession,
  variable: DapVariable,
  depth: number,
  maxDepth: number,
  counter: SerializeCounter,
  token: vscode.CancellationToken,
  semaphore: Semaphore
): Promise<unknown> {
  if (token.isCancellationRequested) {
    return "[cancelled]";
  }

  if (variable.variablesReference === 0 || depth >= maxDepth) {
    if (variable.variablesReference !== 0) {
      return `[unresolved: ${variable.type ?? "object"}]`;
    }
    return parsePrimitiveValue(variable.value, variable.type);
  }

  // Gate this DAP request through the global semaphore
  const response = await semaphore.run(() =>
    Promise.resolve(
      session.customRequest("variables", {
        variablesReference: variable.variablesReference,
      })
    )
  );

  const children: DapVariable[] = response?.variables ?? [];

  const isArrayLike =
    children.length > 0 && children.every((c) => /^\d+$/.test(c.name));

  if (isArrayLike) {
    counter.addItems(children.length);
    return Promise.all(
      children.map(async (child) => {
        const result = await serializeVariable(
          session,
          child,
          depth + 1,
          maxDepth,
          counter,
          token,
          semaphore
        );
        counter.completeItem();
        return result;
      })
    );
  }

  const relevant = children.filter((c) => !c.name.startsWith("[["));
  counter.addItems(relevant.length);

  const entries = await Promise.all(
    relevant.map(async (child) => {
      const result = await serializeVariable(
        session,
        child,
        depth + 1,
        maxDepth,
        counter,
        token,
        semaphore
      );
      counter.completeItem();
      return [child.name, result] as [string, unknown];
    })
  );

  return Object.fromEntries(entries);
}

function parsePrimitiveValue(raw: string, type?: string): unknown {
  if (raw === "undefined") return undefined;
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (
    type === "number" ||
    (type === undefined && /^-?\d+(\.\d+)?$/.test(raw))
  ) {
    const n = Number(raw);
    if (!isNaN(n)) return n;
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

// ── Fast serialize via JSON.stringify in the debuggee ─────────────────────────

// Evaluates JSON.stringify() inside the target process and writes the result
// to a temp file.  ONE round-trip regardless of data size — orders of magnitude
// faster than recursive DAP variable-by-variable fetching.
async function fastSerialize(
  session: vscode.DebugSession,
  expression: string,
  frameId: number
): Promise<unknown | undefined> {
  const tmpFile = path.join(
    os.tmpdir(),
    `data-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const escapedPath = JSON.stringify(tmpFile);

  // The script runs inside the debuggee (Node.js) — handles circular refs,
  // functions, BigInt, and any other non-JSON-safe value.
  const script =
    `(() => { ` +
    `var __s = new WeakSet(); ` +
    `require('fs').writeFileSync(${escapedPath}, JSON.stringify(${expression}, function(k, v) { ` +
    `if (typeof v === 'object' && v !== null) { if (__s.has(v)) return '[circular]'; __s.add(v); } ` +
    `if (typeof v === 'function') return '[function]'; ` +
    `if (typeof v === 'bigint') return v.toString(); ` +
    `return v; })); ` +
    `return 'ok'; })()`;

  try {
    const resp = await session.customRequest("evaluate", {
      expression: script,
      frameId,
      context: "repl",
    });
    if (resp?.result?.includes?.("ok")) {
      const json = fs.readFileSync(tmpFile, "utf8");
      return JSON.parse(json);
    }
  } catch {
    // Fall through — caller will use the slow recursive path
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* already cleaned up or never written */
    }
  }
  return undefined;
}

// ── Timeout helper (for fast DAP setup calls only) ───────────────────────────

function withTimeout<T>(
  thenable: Thenable<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    Promise.resolve(thenable),
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Data Snapshot: Timed out waiting for ${label}. Is the debugger paused at a breakpoint?`
            )
          ),
        ms
      )
    ),
  ]);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Captures a single selected expression from the current debug frame.
 */
export async function captureVariable(
  workspaceRoot: string
): Promise<{ snapshotPath: string; snapshot: Snapshot } | undefined> {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    vscode.window.showErrorMessage("Data Snapshot: No active debug session.");
    return undefined;
  }

  const editor = vscode.window.activeTextEditor;
  const expression = editor?.document.getText(editor.selection).trim();
  if (!expression) {
    vscode.window.showErrorMessage(
      "Data Snapshot: Select a variable or expression in the editor first."
    );
    return undefined;
  }

  if (/^[\[{]/.test(expression) || expression.includes("\n")) {
    vscode.window.showErrorMessage(
      `Data Snapshot: "${expression}" is not a valid expression. ` +
        `Select a single variable name or property access (e.g. "listings" or "order.items").`
    );
    return undefined;
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Data Snapshot: Capturing "${expression}"`,
      cancellable: true,
    },
    async (progress, token) => {
      const maxDepth: number = vscode.workspace
        .getConfiguration("data-snapshot")
        .get("maxDepth", 5);

      const counter = new SerializeCounter(progress);
      const DAP_TIMEOUT_MS = 5000;

      progress.report({ message: "Evaluating expression…" });

      let threadsResp: { threads: DapThread[] };
      try {
        threadsResp = await withTimeout(
          session.customRequest("threads"),
          DAP_TIMEOUT_MS,
          "threads"
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(
          e.message ?? "Data Snapshot: Failed to get threads."
        );
        return undefined;
      }

      const threads: DapThread[] = threadsResp?.threads ?? [];
      if (threads.length === 0) {
        vscode.window.showErrorMessage("Data Snapshot: No threads found.");
        return undefined;
      }

      let stackResp: { stackFrames: DapStackFrame[] };
      try {
        stackResp = await withTimeout(
          session.customRequest("stackTrace", { threadId: threads[0].id }),
          DAP_TIMEOUT_MS,
          "stack trace"
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(
          e.message ?? "Data Snapshot: Failed to get stack trace."
        );
        return undefined;
      }

      const frames: DapStackFrame[] = stackResp?.stackFrames ?? [];
      if (frames.length === 0) {
        vscode.window.showErrorMessage(
          "Data Snapshot: No stack frames — is the debugger paused at a breakpoint?"
        );
        return undefined;
      }
      const topFrame = frames[0];

      // Fast path: run JSON.stringify inside the debuggee — one round-trip
      progress.report({ message: "Serializing (fast path)…" });

      let serialized: unknown = await fastSerialize(
        session,
        expression,
        topFrame.id
      );

      // Slow fallback: recursive DAP variable-by-variable fetching
      if (serialized === undefined) {
        progress.report({
          message: "Fast path unavailable — using DAP fallback…",
        });

        let evalResp: {
          result: string;
          type?: string;
          variablesReference: number;
        };
        try {
          evalResp = await withTimeout(
            session.customRequest("evaluate", {
              expression,
              frameId: topFrame.id,
              context: "hover",
            }),
            DAP_TIMEOUT_MS,
            "evaluate"
          );
        } catch (e: any) {
          vscode.window.showErrorMessage(
            e.message?.startsWith("Data Snapshot:")
              ? e.message
              : `Data Snapshot: Could not evaluate "${expression}". ` +
                  `Make sure the debugger is paused and the variable is in scope.`
          );
          return undefined;
        }

        const semaphore = new Semaphore(DAP_CONCURRENCY);
        const dapVar: DapVariable = {
          name: expression,
          value: evalResp.result,
          type: evalResp.type,
          variablesReference: evalResp.variablesReference,
        };

        serialized = await serializeVariable(
          session,
          dapVar,
          0,
          maxDepth,
          counter,
          token,
          semaphore
        );
      }

      if (token.isCancellationRequested) return undefined;

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-");
      const functionName = topFrame.name ?? "unknown";

      const snapshot: Snapshot = {
        version: 1,
        capturedAt: now.toISOString(),
        source: {
          file: topFrame.source?.path ?? "",
          line: topFrame.line ?? 0,
          functionName,
        },
        frame: { name: topFrame.name, id: topFrame.id },
        variables: { [expression]: serialized },
      };

      const snapshotsDir = path.join(workspaceRoot, ".snapshots", "snapshots");
      fs.mkdirSync(snapshotsDir, { recursive: true });

      const safeName = `${sanitizeName(functionName)}_${sanitizeName(
        expression
      )}_${timestamp}`;
      const snapshotPath = path.join(snapshotsDir, `${safeName}.json`);
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

      return { snapshotPath, snapshot };
    }
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
