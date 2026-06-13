import { dirname } from "node:path";
import * as vscode from "vscode";
import type { RemoteValue, RunnerMsg } from "../protocol/index.ts";
import { prepareRun, type PreparedRun } from "./instrument/index.ts";
import { Aggregator } from "./render/aggregate.ts";
import { Renderer } from "./render/decorations.ts";
import { startRun, type RunHandle } from "./runner/client.ts";
import { stageRunner } from "./runner/stage.ts";

/** Host-side outcome of a lazy expansion ("gone": runner process is dead). */
export type ExpandOutcome =
  | { entries: { key: string; value: RemoteValue }[] }
  | { error: "evicted" | "unknown" | "gone" };

const EXPAND_TIMEOUT_MS = 3000;

/**
 * A live session on one document: re-runs (debounced) on every edit and
 * renders runner messages as inline decorations + output channel lines.
 */
export class QuollSession implements vscode.Disposable {
  private runId = 0;
  private run: RunHandle | undefined;
  private prepared: PreparedRun | undefined;
  private agg: Aggregator | undefined;
  /** Absolute paths of imported project files; editing any re-runs the entry. */
  private deps = new Set<string>();
  private renderQueued = false;
  private nextReqId = 1;
  private readonly pendingExpands = new Map<number, (outcome: ExpandOutcome) => void>();
  private updateQueued = false;
  private readonly updateEmitter = new vscode.EventEmitter<void>();
  /** Fires (microtask-coalesced) when explorer-visible data changes. */
  readonly onDidUpdate = this.updateEmitter.event;
  private readonly renderer: Renderer;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly doc: vscode.TextDocument,
    private readonly output: vscode.OutputChannel,
    private readonly extensionRoot: string,
  ) {
    this.renderer = new Renderer(doc);
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc && e.contentChanges.length > 0) this.scheduleRun();
      }),
      // Imported deps are loaded from DISK by the runner, so they re-run on
      // SAVE (disk is fresh then). Re-running on the unsaved buffer change
      // would read stale disk content and lag one value behind. (The active
      // file is read from the editor buffer via getText(), so it's live on type.)
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.deps.has(doc.fileName)) this.scheduleRun();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderer.reapply()),
    );
    this.runNow();
  }

  private scheduleRun(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    const delay = vscode.workspace.getConfiguration("quoll").get<number>("debounceMs", 300);
    this.debounce = setTimeout(() => this.runNow(), delay);
  }

  private runNow(): void {
    this.run?.cancel();
    const runId = ++this.runId;
    const config = vscode.workspace.getConfiguration("quoll");

    this.prepared = prepareRun(
      this.doc.getText(),
      {
        filename: this.doc.fileName,
        jsx: this.doc.languageId.endsWith("react"),
      },
      this.extensionRoot,
    );
    this.agg = new Aggregator(this.prepared.sites, (id) =>
      id === undefined ? undefined : this.prepared?.toSourceLine(id),
    );
    this.deps = new Set(this.prepared.deps); // refresh the watch graph each run
    this.failPendingExpands();
    this.queueUpdate();
    this.renderer.clear();

    if (this.prepared.errors.length > 0) {
      const errLines = new Map<number, string>();
      for (const err of this.prepared.errors) {
        this.output.appendLine(`✗ ${err.message}`);
        if (err.line !== undefined) errLines.set(err.line, err.message);
      }
      this.renderer.setSnapshot(new Map(), new Map(), errLines);
      return; // wait for the next edit; nothing runnable
    }

    this.output.appendLine(`[quoll] run #${runId} ${this.doc.fileName}`);
    // The workspace folder (or the file's dir if loose) scopes read access AND
    // roots node_modules resolution — imports resolve, nothing outside the
    // project is readable (see StartRunOpts.projectRoot).
    const projectRoot = vscode.workspace.getWorkspaceFolder(this.doc.uri)?.uri.fsPath ??
      dirname(this.doc.fileName);
    this.run = startRun({
      denoPath: config.get<string>("denoPath", "deno"),
      // Staged to a neutral temp dir so byonm resolves the project's
      // node_modules via cwd, not the extension's own (see stageRunner).
      runnerMain: stageRunner(this.extensionRoot),
      runId,
      code: this.prepared.code,
      entry: this.doc.fileName,
      projectRoot,
      onMessage: (msg) => this.onMessage(msg),
      onDiagnostic: (text) => this.output.appendLine(`[runner] ${text}`),
    });
  }

  private onMessage(msg: RunnerMsg): void {
    if (msg.runId !== this.runId) return; // stale run
    this.agg?.ingest(msg); // fold value/console/cover/error into render state
    switch (msg.t) {
      case "value":
        this.scheduleRender();
        this.queueUpdate(); // explorer roots changed
        break;
      case "cover":
        this.scheduleRender();
        break;
      case "console":
        this.output.appendLine(msg.args.map((a) => a.preview).join(" "));
        this.scheduleRender();
        break;
      case "error":
        this.output.appendLine(`✗ ${msg.message}`);
        if (msg.stack) this.output.appendLine(msg.stack);
        this.scheduleRender();
        break;
      case "done":
        this.output.appendLine(`[quoll] done in ${msg.durationMs}ms`);
        break;
      case "exit":
        if (msg.reason !== "complete") this.output.appendLine(`[quoll] exit: ${msg.reason}`);
        break;
      case "expandResult": {
        const resolve = this.pendingExpands.get(msg.reqId);
        if (resolve) {
          this.pendingExpands.delete(msg.reqId);
          resolve(msg.error ? { error: msg.error } : { entries: msg.entries });
        }
        break;
      }
      default:
        // perf (phase 8).
        break;
    }
  }

  /**
   * Lazy expansion against the runner — which lingers after `exit` precisely
   * for this (see protocol). "gone" when the process died or never answers.
   */
  expand(objectId: string): Promise<ExpandOutcome> {
    const run = this.run;
    if (!run) return Promise.resolve({ error: "gone" });
    const reqId = this.nextReqId++;
    return new Promise((resolve) => {
      if (!run.send({ t: "expand", runId: this.runId, reqId, objectId })) {
        resolve({ error: "gone" });
        return;
      }
      const timer = setTimeout(() => {
        this.pendingExpands.delete(reqId);
        resolve({ error: "gone" });
      }, EXPAND_TIMEOUT_MS);
      this.pendingExpands.set(reqId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /** Explorer roots: the current run's captured values, by source line. */
  valueRoots(): { line: number; values: RemoteValue[] }[] {
    return this.agg?.valueSites() ?? [];
  }

  private failPendingExpands(): void {
    for (const resolve of this.pendingExpands.values()) resolve({ error: "gone" });
    this.pendingExpands.clear();
  }

  private queueUpdate(): void {
    if (this.updateQueued) return;
    this.updateQueued = true;
    queueMicrotask(() => {
      this.updateQueued = false;
      this.updateEmitter.fire();
    });
  }

  /**
   * Push the Aggregator's latest snapshot to the renderer, coalesced to one
   * paint per microtask: the runner flushes value/cover bursts that parse
   * within a tick, so recomputing per message is O(sites²) and would flash
   * not-yet-reported coverage sites red before they flip green.
   */
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const runId = this.runId;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (runId !== this.runId || !this.agg) return; // superseded by a newer run
      this.renderer.setSnapshot(this.agg.lineValues(), this.agg.coverage(), this.agg.errorLines());
    });
  }

  dispose(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.failPendingExpands();
    this.run?.cancel();
    this.renderer.dispose();
    this.updateEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
