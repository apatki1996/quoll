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

export type ExtraSite = {
  line: number;
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
