import * as vscode from "vscode";
import type { RunnerMsg } from "../protocol/index.ts";
import { prepareRun, type PreparedRun } from "./instrument/index.ts";
import { Renderer, type CoverageState } from "./render/decorations.ts";
import { startRun, type RunHandle } from "./runner/client.ts";

/**
 * A live session on one document: re-runs (debounced) on every edit and
 * renders runner messages as inline decorations + output channel lines.
 */
export class QuollSession implements vscode.Disposable {
  private runId = 0;
  private run: RunHandle | undefined;
  private prepared: PreparedRun | undefined;
  private coverHits = new Map<number, number>();
  private coverRecomputeQueued = false;
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
    this.coverHits = new Map();
    this.renderer.clear();

    if (this.prepared.errors.length > 0) {
      for (const err of this.prepared.errors) {
        this.output.appendLine(`✗ ${err.message}`);
        if (err.line !== undefined) this.renderer.setError(err.line, err.message);
      }
      return; // wait for the next edit; nothing runnable
    }

    this.output.appendLine(`[quoll] run #${runId} ${this.doc.fileName}`);
    this.run = startRun({
      denoPath: config.get<string>("denoPath", "deno"),
      runnerMain: `${this.extensionRoot}/runner/main.ts`,
      runId,
      code: this.prepared.code,
      entry: this.doc.fileName,
      onMessage: (msg) => this.onMessage(msg),
      onDiagnostic: (text) => this.output.appendLine(`[runner] ${text}`),
    });
  }

  /** Stack-derived siteId (generated line) -> source line, per the phase 2–3 bridge. */
  private sourceLineOf(siteId: number | undefined): number | undefined {
    if (siteId === undefined) return undefined;
    return this.prepared?.toSourceLine(siteId);
  }

  private onMessage(msg: RunnerMsg): void {
    if (msg.runId !== this.runId) return; // stale run
    switch (msg.t) {
      case "value": {
        const site = this.prepared?.sites.get(msg.siteId);
        if (site) this.renderer.addValue(site.line, msg.value.preview);
        break;
      }
      case "cover":
        this.coverHits.set(msg.siteId, msg.hits);
        // Coalesce: the runner flushes one message per site in a burst that
        // parses within one tick. Recomputing per message is O(sites²) and
        // paints not-yet-reported sites red before they flip green.
        if (!this.coverRecomputeQueued) {
          this.coverRecomputeQueued = true;
          queueMicrotask(() => {
            this.coverRecomputeQueued = false;
            if (msg.runId === this.runId) this.renderer.setCoverage(this.computeCoverage());
          });
        }
        break;
      case "console": {
        const text = msg.args.map((a) => a.preview).join(" ");
        this.output.appendLine(text);
        const line = this.sourceLineOf(msg.siteId);
        if (line !== undefined) this.renderer.addValue(line, text);
        break;
      }
      case "error": {
        this.output.appendLine(`✗ ${msg.message}`);
        if (msg.stack) this.output.appendLine(msg.stack);
        const line = this.sourceLineOf(msg.siteId);
        if (line !== undefined) this.renderer.setError(line, msg.message);
        break;
      }
      case "done":
        this.output.appendLine(`[quoll] done in ${msg.durationMs}ms`);
        break;
      case "exit":
        if (msg.reason !== "complete") this.output.appendLine(`[quoll] exit: ${msg.reason}`);
        break;
      default:
        // perf (phase 8), expandResult (phase 5).
        break;
    }
  }

  /**
   * Line state from coverage sites: any unhit site on a line with hit sites
   * (e.g. an untaken ternary arm) renders PARTIAL; all-hit → covered;
   * none-hit → uncovered. Lines without sites get no gutter mark.
   */
  private computeCoverage(): Map<number, CoverageState> {
    const lineState = new Map<number, { hit: boolean; missed: boolean }>();
    for (const site of this.prepared?.sites.values() ?? []) {
      if (site.kind !== "statement" && site.kind !== "branch") continue;
      const state = lineState.get(site.line) ?? { hit: false, missed: false };
      if ((this.coverHits.get(site.id) ?? 0) > 0) state.hit = true;
      else state.missed = true;
      lineState.set(site.line, state);
    }
    const coverage = new Map<number, CoverageState>();
    for (const [line, state] of lineState) {
      coverage.set(line, state.hit && state.missed ? "partial" : state.hit ? "covered" : "uncovered");
    }
    return coverage;
  }

  dispose(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.run?.cancel();
    this.renderer.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
