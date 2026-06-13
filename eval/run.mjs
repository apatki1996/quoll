// Golden-eval harness (spec: "the objective quality signal and the regression net").
//
// Each eval/cases/*.ts file carries inline expectations:
//   //=> <text>                line's value decoration must CONTAIN <text>
//   //== <text>                line's value decoration must EQUAL <text> exactly
//                              (catches noise/surplus a substring check misses)
//   //~ covered|uncovered|partial   line's coverage gutter state
//   //! <text>                 line must show an error containing <text>
//
// The harness runs the REAL pipeline: native instrument -> Deno runner ->
// protocol messages -> line attribution, then diffs against expectations.
// Usage: DENO=$(mise which deno) node eval/run.mjs [caseName]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Aggregator } from "../src/render/aggregate.ts";
import { prepareRun } from "../src/instrument/index.ts";
import { startRun } from "../src/runner/client.ts";
import { stageRunner } from "../src/runner/stage.ts";

// The harness runs the host's EXACT pipeline: prepareRun (instrument + import
// resolution) AND startRun (the runner spawn, with its sandbox flags and
// node_modules rooting). Sharing these assemblies is what lets the harness
// catch host bugs: a forgotten import rewrite or a dropped spawn flag fails
// the `imports`/`bare` cases here too.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deno = process.env.DENO ?? "deno";

// `==` (exact) is checked before `=>` (contains); the patterns are disjoint
// (`=>` vs `==`) so a line carries at most one of them.
const EXACT_RE = /\/\/==\s*(.*?)(?=\s*\/\/[~!]|$)/;
const VALUE_RE = /\/\/=>\s*(.*?)(?=\s*\/\/[~!]|$)/;
const COV_RE = /\/\/~\s*(covered|uncovered|partial)/;
const ERR_RE = /\/\/!\s*(.*?)(?=\s*\/\/[~=]|$)/;

function parseExpectations(source) {
  const expect = { values: new Map(), exact: new Map(), coverage: new Map(), errors: new Map() };
  source.split("\n").forEach((text, i) => {
    const line = i + 1;
    // Annotations only ever trail code; a pure-comment line is prose, so don't
    // let a `//==`/`//=>` written inside an explanatory comment become an
    // assertion.
    if (/^\s*\/\//.test(text)) return;
    const x = text.match(EXACT_RE);
    if (x) expect.exact.set(line, x[1].trim());
    const v = text.match(VALUE_RE);
    if (v) expect.values.set(line, v[1].trim());
    const c = text.match(COV_RE);
    if (c) expect.coverage.set(line, c[1]);
    const e = text.match(ERR_RE);
    if (e) expect.errors.set(line, e[1].trim());
  });
  return expect;
}

async function runCase(file) {
  const source = readFileSync(file, "utf8");
  const expect = parseExpectations(source);
  const prepared = prepareRun(source, { filename: file, jsx: false }, root);
  if (prepared.errors.length > 0) {
    throw new Error(`instrument failed: ${prepared.errors[0].message}`);
  }

  // Fold the runner stream with the REAL host aggregator (shared code, not a
  // replica): value/cover attribute via the capture sites, console/error via
  // the source map. The harness tests the exact attribution + aggregation the
  // editor uses. projectRoot mirrors the host's loose-file rule: the case's
  // own directory (which also holds the fixtures and fixture node_modules).
  const agg = new Aggregator(prepared.sites, (siteId) => prepared.toSourceLine(siteId));
  const run = startRun({
    denoPath: deno,
    runnerMain: stageRunner(root),
    runId: 1,
    code: prepared.code,
    entry: file,
    projectRoot: dirname(file),
    onMessage: (msg) => {
      agg.ingest(msg);
      // The runner lingers after `exit` to serve expand (phase 5); the
      // harness must kill it or `exited` never resolves.
      if (msg.t === "exit") run.cancel();
    },
    onDiagnostic: () => {},
  });
  // Watchdog: a runner that never emits `exit` (crash before exit, grace-loop
  // deadlock) must FAIL the case, not hang the harness/CI forever.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    run.cancel();
  }, 15_000);
  await run.exited;
  clearTimeout(watchdog);
  const values = agg.lineValues(); // line -> previews[]
  const coverage = agg.coverage(); // line -> covered|uncovered|partial
  const errorsAt = agg.errorLines(); // line -> message

  const failures = [];
  if (timedOut) failures.push("runner never emitted `exit` within 15s (killed by watchdog)");
  for (const [line, want] of expect.values) {
    const got = (values.get(line) ?? []).join(", ");
    if (!got.includes(want))
      failures.push(
        `line ${line}: value want ⊇ ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
  }
  for (const [line, want] of expect.exact) {
    const got = (values.get(line) ?? []).join(", ");
    if (got !== want)
      failures.push(
        `line ${line}: value want = ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
  }
  for (const [line, want] of expect.coverage) {
    const got = coverage.get(line) ?? "none";
    if (got !== want) failures.push(`line ${line}: coverage want ${want}, got ${got}`);
  }
  for (const [line, want] of expect.errors) {
    const got = errorsAt.get(line) ?? "";
    if (!got.includes(want))
      failures.push(
        `line ${line}: error want ⊇ ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
  }
  return failures;
}

const filter = process.argv[2];
const caseDir = join(root, "eval", "cases");
const files = readdirSync(caseDir).filter(
  (f) => f.endsWith(".ts") && (!filter || f.includes(filter)),
);
let failed = 0;
for (const f of files.sort()) {
  const failures = await runCase(join(caseDir, f));
  if (failures.length === 0) {
    console.log(`  PASS ${f}`);
  } else {
    failed++;
    console.log(`  FAIL ${f}`);
    for (const msg of failures) console.log(`       ${msg}`);
  }
}
console.log(
  failed === 0
    ? `\neval: all ${files.length} cases pass`
    : `\neval: ${failed}/${files.length} cases FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
