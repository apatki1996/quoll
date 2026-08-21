/**
 * The napi boundary: contract between the extension host (TS) and the
 * instrumentation core (Rust / Oxc, phases 3–4).
 * FROZEN INTERFACE (quoll-spec.md): changes here are breaking protocol changes.
 */

/**
 * Why a capture site exists:
 * - `expr`      — auto-instrumented expression (inline values)
 * - `statement` — coverage counter (green/red gutter)
 * - `branch`    — coverage counter for one branch arm; a line whose branch
 *                 sites have mixed zero/non-zero hits renders PARTIAL (yellow)
 * - `comment`   — `//?` live comment
 * - `perf`      — `//?.` timing comment
 * - `logpoint`  — from `InstrumentOpts.extraSites` (VS Code breakpoint)
 * - `selection` — from `InstrumentOpts.extraSites` (show-value-on-selection)
 */
export type CaptureSiteKind =
  | "expr"
  | "statement"
  | "branch"
  | "comment"
  | "perf"
  | "logpoint"
  | "selection";

export type ExtraSiteKind = Extract<CaptureSiteKind, "logpoint" | "selection">;

/**
 * A caller-supplied capture position. Both kinds produce an ordinary value
 * capture that quiet mode reveals; they differ only in provenance — and in
 * granularity, because their sources do:
 * - `logpoint`  — a VS Code breakpoint marks a LINE, so `column` is ignored
 *                 and every capture on the line is tagged (same rule as `//?`).
 * - `selection` — an editor selection marks a SPAN, so the position anchors the
 *                 INNERMOST capture containing it; an anchor that lands outside
 *                 every capture (a variable name, a keyword) falls back to
 *                 tagging its line, so a reveal is never silently empty.
 */
export type ExtraSite = {
  /** 1-based source line. */
  line: number;
  /** 0-based UTF-16 code-unit column, as VS Code reports it. `prepareRun`
   * converts to the byte columns the Rust core indexes by. */
  column: number;
  kind: ExtraSiteKind;
};

export type InstrumentOpts = {
  filename: string;
  jsx: boolean;
  /**
   * Extra caller-specified capture positions. This is the entire mechanism
   * for Logpoints (phase 9) and value-on-selection (phase 8).
   */
  extraSites?: ExtraSite[];
};

export type CaptureSite = {
  id: number;
  /** Original-source span (pre-instrumentation). 1-based lines, 0-based columns. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  kind: CaptureSiteKind;
};

/** Standard source map v3 (the single map of the single Oxc pass). */
export type RawSourceMap = {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
};

export type InstrumentResult = {
  code: string;
  map: RawSourceMap;
  sites: CaptureSite[];
};

/** Signature exported by the Rust core via napi-rs. */
export type InstrumentFn = (source: string, opts: InstrumentOpts) => InstrumentResult;
