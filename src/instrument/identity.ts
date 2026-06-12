import type { CaptureSite, InstrumentOpts, InstrumentResult } from "../../protocol/index.ts";

/**
 * Pre-instrumentation bridge (phases 2–3): code passes through unchanged and
 * every non-blank line becomes a capture site with id == 1-based line number.
 * The runner attributes console/error events to lines by stack parsing and
 * emits siteId == line under the same convention (see runner/main.ts).
 * Replaced by the Rust napi instrument() in phase 4 behind this exact signature.
 */
export function identityInstrument(source: string, opts: InstrumentOpts): InstrumentResult {
  const sites: CaptureSite[] = [];
  const sourceLines = source.split("\n");
  for (let i = 0; i < sourceLines.length; i++) {
    const text = sourceLines[i] ?? "";
    if (!text.trim()) continue;
    sites.push({
      id: i + 1,
      line: i + 1,
      column: text.length - text.trimStart().length,
      endLine: i + 1,
      endColumn: text.length,
      kind: "expr",
    });
  }
  return {
    code: source,
    map: {
      version: 3,
      file: opts.filename,
      sources: [opts.filename],
      names: [],
      mappings: "",
    },
    sites,
  };
}
