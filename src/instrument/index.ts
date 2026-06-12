import type { InstrumentOpts, RawSourceMap } from "../../protocol/index.ts";
import { identityInstrument } from "./identity.ts";
import { loadNative } from "./native.ts";
import { buildLineMap } from "./sourcemap.ts";

export type PreparedRun = {
  /** Code to send to the runner (transpiled JS, or source verbatim on fallback). */
  code: string;
  /**
   * Maps the runner's stack-derived line (in `code`) back to a 1-based
   * source line. Identity when no transpilation happened.
   */
  toSourceLine(generatedLine: number): number | undefined;
  /** Fatal parse/transform errors; non-empty means do not run `code`. */
  errors: { message: string; line?: number }[];
};

/**
 * Phase 3: single-pass Oxc transpile (TS/JSX → JS) with one source map,
 * via the napi binary. Falls back to the phase-2 identity bridge (plain-JS
 * passthrough) when the native binary is missing for this platform.
 * Phase 4 swaps in real capture sites behind this same facade.
 */
export function prepareRun(
  source: string,
  opts: InstrumentOpts,
  extensionRoot: string,
): PreparedRun {
  const native = loadNative(extensionRoot);
  if (!native) {
    const { code } = identityInstrument(source, opts);
    return { code, toSourceLine: (line) => line, errors: [] };
  }

  const result = native.instrument(source, { filename: opts.filename, jsx: opts.jsx });
  if (result.errors.length > 0) {
    return { code: "", toSourceLine: () => undefined, errors: result.errors };
  }

  const map = JSON.parse(result.mapJson) as RawSourceMap;
  const lineMap = buildLineMap(map);
  return {
    code: result.code,
    toSourceLine: (line) => lineMap.get(line),
    errors: [],
  };
}
