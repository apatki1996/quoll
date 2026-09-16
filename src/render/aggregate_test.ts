// Aggregator unit tests: `mise exec -- deno test src/render/ runner/`
import { strict as assert } from "node:assert";
import { Aggregator, type SiteInfo } from "./aggregate.ts";

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
