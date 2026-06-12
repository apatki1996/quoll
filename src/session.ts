import * as vscode from "vscode";
import type { CaptureSite, RunnerMsg } from "../protocol/index.ts";
import { identityInstrument } from "./instrument/identity.ts";
import { Renderer } from "./render/decorations.ts";
import { startRun, type RunHandle } from "./runner/client.ts";

/**
 * A live session on one document: re-runs (debounced) on every edit and
 * renders runner messages as inline decorations + output channel lines.
 */
export class QuollSession implements vscode.Disposable {
  private runId = 0;
  private run: RunHandle | undefined;
  private sites = new Map<number, CaptureSite>();
  private readonly renderer: Renderer;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly doc: vscode.TextDocument,
    private readonly output: vscode.OutputChannel,
    private readonly runnerMain: string,
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

    const { code, sites } = identityInstrument(this.doc.getText(), {
      filename: this.doc.fileName,
      jsx: false,
    });
    this.sites = new Map(sites.map((s) => [s.id, s]));

    this.renderer.clear();
    this.output.appendLine(`[quoll] run #${runId} ${this.doc.fileName}`);
    this.run = startRun({
      denoPath: config.get<string>("denoPath", "deno"),
      runnerMain: this.runnerMain,
      runId,
      code,
      entry: this.doc.fileName,
      onMessage: (msg) => this.onMessage(msg),
      onDiagnostic: (text) => this.output.appendLine(`[runner] ${text}`),
    });
  }

  private onMessage(msg: RunnerMsg): void {
    if (msg.runId !== this.runId) return; // stale run
    switch (msg.t) {
      case "console": {
        const text = msg.args.map((a) => a.preview).join(" ");
        this.output.appendLine(text);
        const site = msg.siteId === undefined ? undefined : this.sites.get(msg.siteId);
        if (site) this.renderer.addValue(site.line, text);
        break;
      }
      case "error": {
        this.output.appendLine(`✗ ${msg.message}`);
        if (msg.stack) this.output.appendLine(msg.stack);
        const site = msg.siteId === undefined ? undefined : this.sites.get(msg.siteId);
        if (site) this.renderer.setError(site.line, msg.message);
        break;
      }
      case "done":
        this.output.appendLine(`[quoll] done in ${msg.durationMs}ms`);
        break;
      case "exit":
        if (msg.reason !== "complete") this.output.appendLine(`[quoll] exit: ${msg.reason}`);
        break;
      default:
        // value/perf/cover (phase 4+), expandResult (phase 5).
        break;
    }
  }

  dispose(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.run?.cancel();
    this.renderer.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
