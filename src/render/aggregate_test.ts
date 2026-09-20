// Aggregator unit tests: `mise exec -- deno test src/render/ runner/`
import { strict as assert } from "node:assert";
import { Aggregator, stepIndices, type SiteInfo } from "./aggregate.ts";

/** A site spanning one whole line by default; pass a span to nest sites. */
function site(line: number, kind: string, column = 0, endColumn = 80, endLine = line): SiteInfo {
  return { line, column, endLine, endColumn, kind };
}

function val(siteId: number, preview: string, update?: true) {
  return {
    t: "value",
    siteId,
    value: { type: "object", preview },
    ...(update ? { update } : {}),
  } as const;
}

Deno.test("settling value replaces its own slot (update), not appends", () => {
  const sites = new Map<number, SiteInfo>([[1, site(5, "expr")]]);
  const agg = new Aggregator(sites, () => undefined);
  agg.ingest(val(1, "Promise { <pending> }"));
  agg.ingest(val(1, "then 42", true));
  assert.deepEqual(agg.lineValues().get(5), ["then 42"]);
});

Deno.test("multiple sites on one line keep both, in capture order", () => {
  const sites = new Map<number, SiteInfo>([
    [1, site(5, "expr")],
    [2, site(5, "expr")],
  ]);
  const agg = new Aggregator(sites, () => undefined);
  agg.ingest(val(1, "a"));
  agg.ingest(val(2, "b"));
  assert.deepEqual(agg.lineValues().get(5), ["a", "b"]);
});

Deno.test("a loop appends each capture at one site", () => {
  const sites = new Map<number, SiteInfo>([[1, site(3, "expr")]]);
  const agg = new Aggregator(sites, () => undefined);
  agg.ingest(val(1, "0"));
  agg.ingest(val(1, "1"));
  assert.deepEqual(agg.lineValues().get(3), ["0", "1"]);
});

Deno.test("console attributes via genToSource (generated line -> source)", () => {
  const agg = new Aggregator(new Map(), (gen) => (gen === 9 ? 4 : undefined));
  agg.ingest({
    t: "console",
    level: "log",
    args: [{ type: "string", preview: '"hi"' }],
    siteId: 9,
  } as never);
  assert.deepEqual(agg.lineValues().get(4), ['"hi"']);
});

Deno.test("coverage rollup: covered / uncovered / partial", () => {
  const sites = new Map<number, SiteInfo>([
    [1, site(1, "statement")], // hit -> covered
    [2, site(2, "statement")], // unhit -> uncovered
    [3, site(3, "branch")], // hit
    [4, site(3, "branch")], // unhit -> line 3 partial
    [5, site(4, "expr")], // non-coverage kind: no gutter
  ]);
  const agg = new Aggregator(sites, () => undefined);
  agg.ingest({ t: "cover", siteId: 1, hits: 2 } as never);
  agg.ingest({ t: "cover", siteId: 3, hits: 1 } as never);
  const cov = agg.coverage();
  assert.equal(cov.get(1), "covered");
  assert.equal(cov.get(2), "uncovered");
  assert.equal(cov.get(3), "partial");
  assert.equal(cov.get(4), undefined); // line 4 has no statement/branch site
});

Deno.test("explorer roots are sorted by line; error lines via genToSource", () => {
  const sites = new Map<number, SiteInfo>([
    [1, site(7, "expr")],
    [2, site(2, "expr")],
  ]);
  const agg = new Aggregator(sites, (gen) => gen);
  agg.ingest(val(1, "seven"));
  agg.ingest(val(2, "two"));
  agg.ingest({ t: "error", message: "boom", siteId: 3 } as never);
  assert.deepEqual(
    agg.valueSites().map((r) => r.line),
    [2, 7],
  );
  assert.equal(agg.errorLines().get(3), "boom");
});

Deno.test("siteAt returns the innermost covering site, ignoring quiet mode", () => {
  const sites = new Map<number, SiteInfo>([
    [1, site(3, "expr", 6, 30)], // outer: f(x)
    [2, site(3, "expr", 8, 9)], // inner: x
  ]);
  const agg = new Aggregator(sites, () => undefined, "comments");
  agg.ingest(val(1, "outer"));
  agg.ingest(val(2, "inner"));
  assert.equal(agg.siteAt(3, 8)?.values[0]?.preview, "inner");
  assert.equal(agg.siteAt(3, 20)?.values[0]?.preview, "outer");
  assert.equal(agg.siteAt(3, 9)?.values[0]?.preview, "outer"); // inner end is exclusive
  assert.equal(agg.siteAt(3, 30), undefined); // outer end is exclusive too
  assert.equal(agg.siteAt(3, 2), undefined); // before either span
  assert.equal(agg.siteAt(4, 8), undefined); // another line
  assert.equal(agg.lineValues().get(3), undefined); // quiet mode still hides inline
});

// ── Time Machine (phase 10): the tape is replayed through the same Aggregator ──

Deno.test("stepIndices stops at visible events, not at coverage", () => {
  const log = [
    { t: "cover", siteId: 1, hits: 1 },
    val(1, "a"),
    { t: "cover", siteId: 2, hits: 1 },
    { t: "console", args: [{ type: "string", preview: "hi" }], level: "log", siteId: 9 },
    { t: "perf", siteId: 1, durationMs: 3 },
    { t: "error", message: "boom", siteId: 9 },
  ] as never[];
  assert.deepEqual(stepIndices(log), [1, 3, 4, 5]);
  assert.deepEqual(stepIndices([]), []);
});

Deno.test("replaying a prefix shows the run as it stood at that stop", () => {
  const sites = new Map<number, SiteInfo>([
    [1, site(3, "expr")],
    [2, site(3, "statement")],
  ]);
  // A loop capturing three times. Cover comes LAST because that is where the
  // runner puts it — `flushCover()` runs after the entry module resolves, not
  // interleaved with the values (runner/main.ts).
  const log = [
    val(1, "1"),
    val(1, "2"),
    val(1, "3"),
    { t: "cover", siteId: 2, hits: 3 },
  ] as never[];
  const stops = stepIndices(log);
  assert.deepEqual(stops, [0, 1, 2]);

  const replay = (stop: number) => {
    const agg = new Aggregator(sites, () => undefined);
    for (let i = 0; i <= stops[stop]!; i++) agg.ingest(log[i]!);
    return agg;
  };
  assert.deepEqual(replay(0).lineValues().get(3), ["1"]);
  assert.deepEqual(replay(1).lineValues().get(3), ["1", "2"]);
  assert.deepEqual(replay(2).lineValues().get(3), ["1", "2", "3"]);
});

Deno.test("a prefix carries no coverage — the session must not re-derive it", () => {
  // Guards the reason `QuollSession.stepBy` paints the LIVE gutter while
  // stepping: every cover event sits after the last value in the tape, so a
  // prefix of a synchronous run has none and would mark the file uncovered.
  const sites = new Map<number, SiteInfo>([
    [1, site(3, "expr")],
    [2, site(3, "statement")],
  ]);
  const log = [val(1, "1"), { t: "cover", siteId: 2, hits: 1 }] as never[];
  const prefix = new Aggregator(sites, () => undefined);
  prefix.ingest(log[stepIndices(log)[0]!]!);
  assert.equal(prefix.coverage().get(3), "uncovered");

  const whole = new Aggregator(sites, () => undefined);
  for (const event of log) whole.ingest(event);
  assert.equal(whole.coverage().get(3), "covered");
});

Deno.test("replay un-settles a promise that settled later", () => {
  const sites = new Map<number, SiteInfo>([[1, site(2, "expr")]]);
  const log = [val(1, "Promise { <pending> }"), val(1, "then 42", true)] as never[];
  const stops = stepIndices(log);
  assert.deepEqual(stops, [0, 1]);

  // The whole tape: settled.
  const live = new Aggregator(sites, () => undefined);
  for (const event of log) live.ingest(event);
  assert.deepEqual(live.lineValues().get(2), ["then 42"]);

  // Stepping back to the stop before it settled: pending again. A fresh
  // aggregator per frame is what makes this work — an incrementally-updated
  // one could not undo the `update` that replaced the pending preview.
  const rewound = new Aggregator(sites, () => undefined);
  for (let i = 0; i <= stops[0]!; i++) rewound.ingest(log[i]!);
  assert.deepEqual(rewound.lineValues().get(2), ["Promise { <pending> }"]);
});
