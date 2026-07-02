import type { CaptureSite, InstrumentOpts, RawSourceMap } from "../../protocol/index.ts";
import { identityInstrument } from "./identity.ts";
import { loadNative } from "./native.ts";
import { buildLineMap } from "./sourcemap.ts";
import { collectDeps, resolveRequests, rewriteImports } from "./resolve.ts";

export type PrepareError = { message: string; line?: number };

/**
 * Outcome of preparing a run, as a tagged union so a failed run cannot carry
 * phantom code/sites: callers narrow on `ok` before touching value fields, and
 * the failure case has no empty placeholders to fabricate. `ok: true` covers
 * both native instrumentation and the identity fallback (real code, no errors).
 */
export type PreparedRun =
  | {
      ok: true;
      /** Code to send to the runner (instrumented JS, or source verbatim on fallback). */
      code: string;
      /** Absolute paths of the entry's resolved relative imports (for the watch graph). */
      deps: string[];
      /** Capture sites injected into `code`, keyed by id. Empty on fallback. */
      sites: Map<number, CaptureSite>;
      /**
       * Maps the runner's stack-derived line (in `code`) back to a 1-based
       * source line — used for console/error attribution. Identity when no
       * transpilation happened.
       */
      toSourceLine(generatedLine: number): number | undefined;
    }
  | { ok: false; errors: PrepareError[] };

/** The two failure exits (transform errors, native throw) carry only `errors`. */
function failed(errors: PrepareError[]): PreparedRun {
  return { ok: false, errors };
}

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
    const { code: runnable } = rewriteImports(code, opts.filename);
    const deps = collectDeps(code, opts.filename);
    return { ok: true, code: runnable, deps, sites: new Map(), toSourceLine: (line) => line };
  }

  // A throw here (napi call, map JSON, VLQ decode) would otherwise escape
  // through runNow's debounce setTimeout and silently kill the session.
  try {
    // Phase 6: list the entry's module requests (parse-accurate, so import
    // lookalikes inside string literals can't false-match), resolve relative
    // ones to absolute file:// URLs (the runner's data: URL entry can't
    // resolve relative specifiers), and let the Rust pass swap them in the
    // AST before its single codegen.
    const requests = native.listImports(source, opts.filename, opts.jsx);
    const { rewrites } = resolveRequests(requests, opts.filename);
    const result = native.instrument(source, { filename: opts.filename, jsx: opts.jsx, rewrites });
    if (result.errors.length > 0) return failed(result.errors);

    const map = JSON.parse(result.mapJson) as RawSourceMap;
    const lineMap = buildLineMap(map);
    const deps = collectDeps(source, opts.filename, (code, path) =>
      native.listImports(code, path, /\.[jt]sx$/.test(path)),
    );
    return {
      ok: true,
      code: result.code,
      deps,
      sites: new Map(result.sites.map((s) => [s.id, s as CaptureSite])),
      toSourceLine: (line) => lineMap.get(line),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failed([{ message: `instrumentation failed: ${message}` }]);
  }
}
