/**
 * Folds the runner's value/console/cover/error stream into per-line render
 * state. Deliberately vscode-free: the live host (session.ts) and the golden
 * harness (eval/run.mjs) BOTH consume this, so the harness exercises the real
 * attribution + aggregation rules instead of a drifting replica.
 *
 * Two attribution maps are injected because the two message kinds carry
 * different ids: `value`/`cover` carry a capture-site id (→ source line via the
 * sites map), while `console`/`error` carry a generated line (→ source line via
 * the run's source map).
 */
import type { RemoteValue, RunnerEvent } from "../../protocol/index.ts";

export type CoverageState = "covered" | "uncovered" | "partial";
/** A capture site's source span + kind (structural subset of `CaptureSite`). */
export interface SiteInfo {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  kind: string;
}

/** One value site's capture history, with the span that located it (hover). */
export interface SiteValues {
  siteId: number;
  site: SiteInfo;
  values: RemoteValue[];
}

/**
 * Inline value-render policy (Phase 8). `all` = Quoll's always-on default
 * (every captured expression renders). `comments` = quiet mode: only sites the
 * user opted into (`//?`, value-on-selection, logpoints) render inline;
 * console output and `//?.` timings always render. Coverage and the explorer
 * are unaffected.
 */
export type ValuesMode = "all" | "comments";

/** Site kinds whose inline value survives quiet mode (user opted in). */
const OPT_IN_KINDS = new Set(["comment", "selection", "logpoint"]);

/** Per-site / per-line cap so a hot loop can't grow render state unbounded. */
const MAX_VALUES = 100;

/**
 * Is (line, column) inside a site's span? 1-based lines, 0-based columns, and
 * the END IS EXCLUSIVE — Oxc spans are half-open, so `endColumn` is already the
 * character after the expression. An inclusive test would match `;` for
 * `x = f()` and hand the hover the wrong (outer) site at every boundary.
 */
function covers(site: SiteInfo, line: number, column: number): boolean {
  const afterStart = line > site.line || (line === site.line && column >= site.column);
  const beforeEnd = line < site.endLine || (line === site.endLine && column < site.endColumn);
  return afterStart && beforeEnd;
}

/** Does `a` start later than `b`? (Innermost-wins tiebreak for nested spans.) */
function startsAfter(a: SiteInfo, b: SiteInfo): boolean {
  return a.line > b.line || (a.line === b.line && a.column > b.column);
}

/** `//?.` timing: sub-ms gets 2 decimals, otherwise whole milliseconds. */
function formatDuration(ms: number): string {
  return ms >= 1 ? `${Math.round(ms)}ms` : `${ms.toFixed(2)}ms`;
}

export class Aggregator {
  /** value captures keyed by siteId, so a single evolving value (a settling
   * promise) REPLACES its own slot on `update` instead of appending. */
  private readonly siteValues = new Map<number, { line: number; values: RemoteValue[] }>();
  /** console output, line-keyed (it isn't site-attributed). */
  private readonly consoleValues = new Map<number, string[]>();
  /** `//?.` timings keyed by siteId; the latest run's duration per site. */
  private readonly perfs = new Map<number, number>();
  private readonly coverHits = new Map<number, number>();
  private readonly errs = new Map<number, string>();

  // Explicit fields (not constructor parameter properties): this module is also
  // loaded by the node-based eval harness, whose type-stripping can't emit the
  // assignments parameter properties require.
  private readonly sites: ReadonlyMap<number, SiteInfo>;
  private readonly genToSource: (siteId: number | undefined) => number | undefined;
  private readonly valuesMode: ValuesMode;

  constructor(
    sites: ReadonlyMap<number, SiteInfo>,
    genToSource: (siteId: number | undefined) => number | undefined,
    valuesMode: ValuesMode = "all",
  ) {
    this.sites = sites;
    this.genToSource = genToSource;
    this.valuesMode = valuesMode;
  }

  ingest(msg: RunnerEvent): void {
    switch (msg.t) {
      case "value": {
        const line = this.sites.get(msg.siteId)?.line;
        if (line === undefined) return;
        let entry = this.siteValues.get(msg.siteId);
        if (!entry) this.siteValues.set(msg.siteId, (entry = { line, values: [] }));
        if (msg.update && entry.values.length > 0) {
          entry.values[entry.values.length - 1] = msg.value; // evolved value: replace
        } else {
          if (entry.values.length >= MAX_VALUES) entry.values.shift(); // keep latest
          entry.values.push(msg.value);
        }
        return;
      }
      case "console": {
        const line = this.genToSource(msg.siteId);
        if (line === undefined) return;
        const list = this.consoleValues.get(line) ?? [];
        if (list.length < MAX_VALUES) list.push(msg.args.map((a) => a.preview).join(" "));
        this.consoleValues.set(line, list);
        return;
      }
      case "perf":
        this.perfs.set(msg.siteId, msg.durationMs);
        return;
      case "cover":
        this.coverHits.set(msg.siteId, msg.hits);
        return;
      case "error": {
        const line = this.genToSource(msg.siteId);
        if (line !== undefined) this.errs.set(line, msg.message);
        return;
      }
      default:
        return; // done / exit / expandResult carry no render state
    }
  }

  /** Value + perf + console previews per source line (value sites in capture
   * order, then perf timings, then console), ready to join into one
   * end-of-line decoration. In `comments` mode, only opt-in value sites
   * render; perf and console always do. */
  lineValues(): Map<number, string[]> {
    const byLine = new Map<number, string[]>();
    const push = (line: number, preview: string) => {
      const list = byLine.get(line) ?? [];
      list.push(preview);
      byLine.set(line, list);
    };
    for (const [siteId, { line, values }] of this.siteValues) {
      if (this.valuesMode === "comments" && !OPT_IN_KINDS.has(this.sites.get(siteId)?.kind ?? "")) {
        continue; // quiet mode: drop auto-captured expressions
      }
      for (const v of values) push(line, v.preview);
    }
    for (const [siteId, ms] of this.perfs) {
      const line = this.sites.get(siteId)?.line;
      if (line !== undefined) push(line, `⏱ ${formatDuration(ms)}`);
    }
    for (const [line, previews] of this.consoleValues) {
      for (const p of previews) push(line, p);
    }
    return byLine;
  }

  /** Gutter state per line: an unhit statement/branch site on a line that also
   * has hit sites → partial; all-hit → covered; none-hit → uncovered. */
  coverage(): Map<number, CoverageState> {
    const lineState = new Map<number, { hit: boolean; missed: boolean }>();
    for (const [id, info] of this.sites) {
      if (info.kind !== "statement" && info.kind !== "branch") continue;
      const st = lineState.get(info.line) ?? { hit: false, missed: false };
      if ((this.coverHits.get(id) ?? 0) > 0) st.hit = true;
      else st.missed = true;
      lineState.set(info.line, st);
    }
    const cov = new Map<number, CoverageState>();
    for (const [line, st] of lineState) {
      cov.set(line, st.hit && st.missed ? "partial" : st.hit ? "covered" : "uncovered");
    }
    return cov;
  }

  // All getters return snapshots, never internal state: consumers (renderer,
  // explorer) hold the result across later ingests and must not see it mutate.
  errorLines(): Map<number, string> {
    return new Map(this.errs);
  }

  /** Explorer roots: captured values by source line (value sites only), sorted. */
  valueSites(): { siteId: number; line: number; values: RemoteValue[] }[] {
    const roots: { siteId: number; line: number; values: RemoteValue[] }[] = [];
    for (const [siteId, { line, values }] of this.siteValues) {
      if (values.length > 0) roots.push({ siteId, line, values: [...values] });
    }
    return roots.sort((a, b) => a.line - b.line);
  }

  /**
   * Innermost value site whose span covers a position (1-based line, 0-based
   * column) — the hover's lookup. Deliberately ignores `valuesMode`: a hover
   * is an explicit ask, so quiet mode suppresses inline values, not hovered
   * ones. No re-run and no re-eval; this reads what the run already reported.
   */
  siteAt(line: number, column: number): SiteValues | undefined {
    let best: SiteValues | undefined;
    for (const [siteId, entry] of this.siteValues) {
      if (entry.values.length === 0) continue;
      const site = this.sites.get(siteId);
      if (!site || !covers(site, line, column)) continue;
      if (!best || startsAfter(site, best.site)) {
        best = { siteId, site, values: [...entry.values] };
      }
    }
    return best;
  }
}

/**
 * Event kinds worth stopping at when stepping through a recorded run (phase
 * 10 Time Machine): the ones emitted AS THEY HAPPEN, so a prefix of them is a
 * truthful picture of a moment in the run.
 *
 * `cover` is excluded, and not only because coverage would put hundreds of
 * gutter-only stops between two values: the runner batches cover totals and
 * flushes them once the run is over (`flushCover`, runner/main.ts), so they
 * don't sit at a meaningful place in the log at all. Coverage is a fact about
 * the whole run rather than about a moment in it — the session keeps painting
 * the live gutter while stepping instead of re-deriving it from a prefix,
 * which would show a file that is entirely red.
 */
const STEP_KINDS = new Set(["value", "console", "error", "perf"]);

/** Is this an event a user can step to? (The one definition; see STEP_KINDS.) */
export function isStop(event: RunnerEvent): boolean {
  return STEP_KINDS.has(event.t);
}

/**
 * Indices in a recorded event log of the stops a user steps between. The state
 * shown at a stop is `new Aggregator(...)` folded over `log[0..index]` — the
 * same aggregator, the same rules as live, so Time Machine has no second
 * rendering path that could disagree with the first.
 */
export function stepIndices(log: readonly RunnerEvent[]): number[] {
  const stops: number[] = [];
  for (let i = 0; i < log.length; i++) {
    if (isStop(log[i]!)) stops.push(i);
  }
  return stops;
}

/**
 * One Timeline row: a Time Machine stop, ready to render (phase 11). A row's
 * POSITION in the returned array is its stop index — the thing `stepTo` takes
 * — so it isn't repeated as a field that could disagree with it.
 */
export interface TimelineRow {
  line: number;
  /** The event kind, which the Timeline colours by. */
  kind: string;
  preview: string;
  /** Since the run's first RECORDED event (the tape's, not the run's). */
  elapsedMs: number;
}

/** One line of text for a recorded event — what a Timeline row shows. */
function rowPreview(msg: RunnerEvent): string {
  switch (msg.t) {
    case "value":
      return msg.value.preview;
    case "console":
      return msg.args.map((a) => a.preview).join(" ");
    case "error":
      return `✗ ${msg.message}`;
    case "perf":
      return `⏱ ${formatDuration(msg.durationMs)}`;
    default:
      return msg.t;
  }
}

/**
 * The run as a list of moments (phase 11 Timeline): one row per stop, in `seq`
 * order. Row `i` IS stop `i`, so a click is `stepTo(i)` — the Timeline and the
 * Time Machine are one mechanism with two front ends, not two recordings.
 *
 * `lineOf` is the caller's attribution map (the same two the Aggregator gets:
 * site ids for `value`/`perf`, generated lines for `console`/`error`).
 */
export function timelineRows(
  log: readonly (RunnerEvent & { ts: number })[],
  lineOf: (event: RunnerEvent) => number | undefined,
): TimelineRow[] {
  const first = log[0]?.ts;
  return stepIndices(log).map((at) => {
    const event = log[at]!;
    return {
      line: lineOf(event) ?? 0,
      kind: event.t,
      preview: rowPreview(event),
      elapsedMs: first === undefined ? 0 : event.ts - first,
    };
  });
}
