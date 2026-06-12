import type { CaptureSite, InstrumentOpts, RawSourceMap } from "../../protocol/index.ts";
import { identityInstrument } from "./identity.ts";
import { loadNative } from "./native.ts";
import { buildLineMap } from "./sourcemap.ts";

export type PreparedRun = {
  /** Code to send to the runner (instrumented JS, or source verbatim on fallback). */
  code: string;
  /** Capture sites injected into `code`, keyed by id. Empty on fallback. */
  sites: Map<number, CaptureSite>;
  /**
   * Maps the runner's stack-derived line (in `code`) back to a 1-based
   * source line — used for console/error attribution. Identity when no
   * transpilation happened.
   */
  toSourceLine(generatedLine: number): number | undefined;
  /** Fatal parse/transform errors; non-empty means do not run `code`. */
  errors: { message: string; line?: number }[];
};

/**
 * Phase 4: single-pass Oxc transpile + value-capture/coverage instrumentation
 * via the napi binary. Falls back to the phase-2 identity bridge (plain-JS
 * passthrough, console-only attribution, no sites) when the native binary is
 * missing for this platform.
 */
export function prepareRun(
  source: string,
  opts: InstrumentOpts,
  extensionRoot: string,
): PreparedRun {
  const native = loadNative(extensionRoot);
  if (!native) {
    const { code } = identityInstrument(source, opts);
    return { code, sites: new Map(), toSourceLine: (line) => line, errors: [] };
  }

  const result = native.instrument(source, { filename: opts.filename, jsx: opts.jsx });
  if (result.errors.length > 0) {
    return { code: "", sites: new Map(), toSourceLine: () => undefined, errors: result.errors };
  }

  const map = JSON.parse(result.mapJson) as RawSourceMap;
  const lineMap = buildLineMap(map);
  return {
    code: result.code,
    sites: new Map(result.sites.map((s) => [s.id, s as CaptureSite])),
    toSourceLine: (line) => lineMap.get(line),
    errors: [],
  };
}
