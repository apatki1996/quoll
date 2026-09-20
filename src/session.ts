import { dirname } from "node:path";
import * as vscode from "vscode";
import type { ExtraSite, RemoteValue, RunnerEvent, RunnerMsg } from "../protocol/index.ts";
import { config } from "./configuration.ts";
import { Commands, EXTENSION_ID, STEPPING_CONTEXT } from "./constants.ts";
import { prepareRun } from "./instrument/index.ts";
import { registerValueHover } from "./hover.ts";
import { Aggregator, isStop, stepIndices, type SiteValues } from "./render/aggregate.ts";
import { Renderer } from "./render/decorations.ts";
import { startRun, type RunHandle } from "./runner/client.ts";
import { stageRunner } from "./runner/stage.ts";

/** Host-side outcome of a lazy expansion ("gone": runner process is dead). */
export type ExpandOutcome =
  | { entries: { key: string; value: RemoteValue }[] }
  | { error: "evicted" | "unknown" | "gone" };

const EXPAND_TIMEOUT_MS = 3000;

/**
 * Ceiling on the recorded event log. A hot loop emits faster than anyone can
 * step, so the tape keeps the FIRST events and stops recording — the start of
 * a run is what you step forward from, and dropping the head to keep the tail
 * would move every stop index under the user mid-session.
 * ponytail: one flat cap; sample or window it only if a real run hits it.
 */
const MAX_LOG = 5000;

/**
 * This document's enabled breakpoints as logpoint sites (Phase 9). A breakpoint
 * marks a LINE, so the column is meaningless here and the core ignores it.
 * Read fresh per run rather than mirrored into session state: VS Code already
 * owns this list, and a second copy could only drift from it.
 */
function breakpointSites(doc: vscode.TextDocument): ExtraSite[] {
  const uri = doc.uri.toString();
  return vscode.debug.breakpoints
    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
    .filter((bp) => bp.enabled && bp.location.uri.toString() === uri)
    .map((bp) => ({ line: bp.location.range.start.line + 1, column: 0, kind: "logpoint" }));
}

/**
 * A live session on one document: re-runs (debounced) on every edit and
 * renders runner messages as inline decorations + output channel lines.
 */
export class QuollSession implements vscode.Disposable {
  private runId = 0;
  private run: RunHandle | undefined;
  private agg: Aggregator | undefined;
  /** Absolute paths of imported project files; editing any re-runs the entry. */
  private deps = new Set<string>();
  private renderQueued = false;
  private nextReqId = 1;
  private readonly pendingExpands = new Map<number, (outcome: ExpandOutcome) => void>();
  /** Non-empty editor selections in this document (Phase 8 value-on-selection). */
  private selection: ExtraSite[] = [];
  /** Serialized `extraSites()` of the last run — the re-run change detector. */
  private extraKey = "";
  private updateQueued = false;
  /**
   * The current run's event log in `seq` order — the Time Machine's tape
   * (phase 10). Only what the Aggregator folds is recorded; `done`/`exit`/
   * `expandResult` carry no render state. In memory and per session: writing
   * it to disk is phase 15's job, which needs a file format anyway.
   */
  private log: RunnerEvent[] = [];
  /** Did the tape hit `MAX_LOG`? The status bar says so, so a step forward
   * off the end isn't a silent jump over the events that were dropped. */
  private truncated = false;
  /** Position in `stepIndices(log)` while stepping; `undefined` = live. */
  private step: number | undefined;
  /** Fold over the tape's prefix at `step` — what's rendered while stepping. */
  private replay: Aggregator | undefined;
  /** Builds an Aggregator wired to THIS run's sites; replay re-folds with it. */
  private newAggregator: (() => Aggregator) | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (this.deps.has(saved.fileName)) this.scheduleRun();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderer.reapply()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document !== this.doc) return;
        // Only a real selection reveals anything. A bare cursor move is by far
        // the most common event on this channel and must never spawn a run.
        this.selection = e.selections
          .filter((sel) => !sel.isEmpty)
          .map((sel) => ({
            line: sel.start.line + 1,
            column: sel.start.character,
            kind: "selection",
          }));
        this.rerunIfExtraSitesChanged();
      }),
      vscode.debug.onDidChangeBreakpoints(() => this.rerunIfExtraSitesChanged()),
      // Both are read at run start — the values mode when the Aggregator is
      // built, the runtime when the subprocess is spawned — so a re-run is
      // what applies either change.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(`${EXTENSION_ID}.values`) ||
          e.affectsConfiguration(`${EXTENSION_ID}.runtime`)
        ) {
          this.scheduleRun();
        }
      }),
      registerValueHover(doc, (line, column) => this.siteAt(line, column)),
    );
    this.runNow();
  }

  /**
   * Caller-supplied capture sites: the editor state that opts a line in beyond
   * a `//?` comment — the live selection and this document's breakpoints.
   *
   * Quiet mode is the only mode where opting in means anything: `all` renders
   * every expression already, so a tag would change no pixel while the extra
   * runs (one per drag-select, one per breakpoint toggle) cost a Deno process
   * each. So in `all` mode there is nothing to collect.
   */
  private extraSites(): ExtraSite[] {
    if (config.values() !== "comments") return [];
    return [...this.selection, ...breakpointSites(this.doc)];
  }

  /**
   * Re-run only when the opt-in set actually CHANGED. Both source events fire
   * far more often than they mean anything — clearing a selection that never
   * revealed a value, toggling a breakpoint in another file — and every run is
   * a process spawn.
   */
  private rerunIfExtraSitesChanged(): void {
    const key = JSON.stringify(this.extraSites());
    if (key === this.extraKey) return;
    this.extraKey = key;
    this.scheduleRun();
  }

  private scheduleRun(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.runNow(), config.debounceMs());
  }

  private runNow(): void {
    this.run?.cancel();
    const runId = ++this.runId;

    const extraSites = this.extraSites();
    this.extraKey = JSON.stringify(extraSites);
    const prepared = prepareRun(
      this.doc.getText(),
      {
        filename: this.doc.fileName,
        jsx: this.doc.languageId.endsWith("react"),
        extraSites,
      },
      this.extensionRoot,
    );
    this.failPendingExpands();
    this.renderer.clear();
    this.log = []; // a new run is a new tape
    this.truncated = false;
    this.goLive();

    if (!prepared.ok) {
      this.agg = undefined;
      this.newAggregator = undefined;
      this.deps = new Set(); // a broken entry clears the watch graph until it parses again
      const errLines = new Map<number, string>();
      for (const err of prepared.errors) {
        this.output.appendLine(`✗ ${err.message}`);
        if (err.line !== undefined) errLines.set(err.line, err.message);
      }
      this.queueUpdate();
      this.renderer.setSnapshot(new Map(), new Map(), errLines);
      return; // wait for the next edit; nothing runnable
    }

    // Kept as a factory, not just an instance: replaying a prefix of the tape
    // needs a SECOND aggregator wired to this run's sites, and `config.values()`
    // is read once here so a mid-run settings change can't make a replay
    // disagree with what the live render showed.
    const valuesMode = config.values();
    this.newAggregator = () =>
      new Aggregator(
        prepared.sites,
        (id) => (id === undefined ? undefined : prepared.toSourceLine(id)),
        valuesMode,
      );
    this.agg = this.newAggregator();
    this.deps = new Set(prepared.deps); // refresh the watch graph each run
    this.queueUpdate();

    this.output.appendLine(`[quoll] run #${runId} ${this.doc.fileName}`);
    // The workspace folder (or the file's dir if loose) scopes read access AND
    // roots node_modules resolution — imports resolve, nothing outside the
    // project is readable (see StartRunOpts.projectRoot).
    const projectRoot =
      vscode.workspace.getWorkspaceFolder(this.doc.uri)?.uri.fsPath ?? dirname(this.doc.fileName);
    this.run = startRun({
      denoPath: config.denoPath(),
      // Staged to a neutral temp dir so byonm resolves the project's
      // node_modules via cwd, not the extension's own (see stageRunner).
      runnerMain: stageRunner(this.extensionRoot),
      runId,
      runTimeoutMs: config.runTimeoutMs(),
      browser: config.runtime() === "browser",
      code: prepared.code,
      entry: this.doc.fileName,
      projectRoot,
      onMessage: (msg) => this.onMessage(msg),
      onDiagnostic: (text) => this.output.appendLine(`[runner] ${text}`),
    });
  }

  private onMessage(msg: RunnerMsg): void {
    if (msg.runId !== this.runId) return; // stale run
    this.record(msg);
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
   * Append to the run's tape. Only Aggregator-folded events are recorded: the
   * tape's whole contract is that replaying a prefix through an Aggregator
   * reproduces what the editor showed at that moment, and `done`/`exit`/
   * `expandResult` fold to nothing.
   */
  private record(msg: RunnerEvent): void {
    switch (msg.t) {
      case "done":
      case "exit":
      case "expandResult":
        return;
      default:
        if (this.log.length >= MAX_LOG) {
          this.truncated = true;
          return;
        }
        this.log.push(msg);
        // A run can still be streaming (timers, late promises) while the user
        // stands in the Time Machine, and live painting is frozen there — so
        // the counter growing under them is the only sign the run isn't over.
        if (this.step !== undefined && isStop(msg)) {
          this.showStep(this.step + 1, stepIndices(this.log).length);
        }
    }
  }

  /**
   * Move `delta` stops through the recorded run, entering the Time Machine
   * from live if needed (live == every stop applied, so stepping back from
   * live lands on the second-to-last). Stepping past the end resumes live
   * rather than stalling on the final frame — that frame IS live.
   */
  stepBy(delta: number): void {
    const stops = stepIndices(this.log);
    if (stops.length === 0) return;
    const target = Math.max(0, (this.step ?? stops.length - 1) + delta);
    if (target >= stops.length) {
      this.goLive(); // stepped off the end; the tape's last frame is live
      return;
    }
    // Entering on the frame that equals live would shadow three keys to show
    // the user exactly what they are already looking at.
    if (this.step === undefined && target === stops.length - 1) return;
    const agg = this.newAggregator?.();
    if (!agg) return; // the entry no longer parses; there is nothing to replay
    this.step = target;
    const upTo = stops[target]! + 1;
    for (let i = 0; i < upTo; i++) agg.ingest(this.log[i]!);
    this.replay = agg;
    // Values, console and errors come from the prefix — they were emitted as
    // they happened. Coverage does NOT: the runner batches cover totals and
    // flushes them when the run ends, so a prefix holds none of them and
    // re-deriving the gutter would paint every line red. Coverage is a
    // whole-run fact, so the live gutter stays put while stepping.
    this.renderer.setSnapshot(
      agg.lineValues(),
      this.agg?.coverage() ?? new Map(),
      agg.errorLines(),
    );
    this.showStep(target + 1, stops.length);
    this.queueUpdate(); // explorer + hover follow the step
  }

  /** Leave the Time Machine: repaint from the live fold and resume painting. */
  goLive(): void {
    if (this.step === undefined) return;
    this.step = undefined;
    this.replay = undefined;
    this.showStep();
    this.scheduleRender();
    this.queueUpdate();
  }

  /** Status bar + the context key the stepping keybindings are gated on. */
  private showStep(position?: number, total?: number): void {
    if (position === undefined) {
      this.status.hide();
    } else {
      this.status.text = `$(history) Quoll ${position}/${total}${this.truncated ? "+" : ""}`;
      this.status.tooltip = this.truncated
        ? `Quoll Time Machine — this run outran the ${MAX_LOG}-event tape, so stepping forward past the last recorded stop jumps straight to live. Click to resume live.`
        : "Quoll Time Machine — click to resume live";
      this.status.command = Commands.live;
      this.status.show();
    }
    void vscode.commands.executeCommand("setContext", STEPPING_CONTEXT, position !== undefined);
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

  /**
   * The fold the UI reads: the stepped prefix while in the Time Machine, the
   * live one otherwise. Explorer, hover and decorations all go through it, so
   * a step moves the whole editor back in time, not just the inline values.
   */
  private current(): Aggregator | undefined {
    return this.step === undefined ? this.agg : this.replay;
  }

  /** Explorer roots: the current run's captured values, by source line. */
  valueRoots(): { siteId: number; line: number; values: RemoteValue[] }[] {
    return this.current()?.valueSites() ?? [];
  }

  /** Hover lookup: values captured at the innermost site covering a position. */
  siteAt(line: number, column: number): SiteValues | undefined {
    return this.current()?.siteAt(line, column);
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
      if (this.step !== undefined) return; // frozen: the Time Machine owns the paint
      this.renderer.setSnapshot(this.agg.lineValues(), this.agg.coverage(), this.agg.errorLines());
    });
  }

  dispose(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.showStep(); // drop the context key so keybindings don't outlive the session
    this.status.dispose();
    this.failPendingExpands();
    this.run?.cancel();
    this.renderer.dispose();
    this.updateEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
