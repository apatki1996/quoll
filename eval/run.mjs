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
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLineMap } from "../src/instrument/sourcemap.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const core = require(join(root, "native", `quoll-core.${process.platform}-${process.arch}.node`));
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
  const { code, mapJson, errors, sites } = core.instrument(source, {
    filename: file,
    jsx: false,
  });
  if (errors.length > 0) throw new Error(`instrument failed: ${errors[0].message}`);
  const lineMap = buildLineMap(JSON.parse(mapJson));
  const siteById = new Map(sites.map((s) => [s.id, s]));

  const child = spawn(deno, ["run", "--quiet", "--no-prompt", join(root, "runner", "main.ts")]);
  child.stdin.write(JSON.stringify({ t: "run", runId: 1, code, entry: file }) + "\n");
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
    // The runner lingers after `exit` to serve expand (phase 5); the harness
    // must kill it. Wait for the trailing newline so no line is cut mid-parse.
    if (out.includes('"t":"exit"') && out.endsWith("\n")) child.kill();
  });
  await new Promise((resolve) => child.on("close", resolve));

  // Reproduce the session's attribution rules.
  const values = new Map(); // line -> previews[]
  const errorsAt = new Map(); // line -> message
  const hits = new Map(); // siteId -> hits
  const siteSlot = new Map(); // siteId -> index in its line's previews (for update-in-place)
  const addValue = (line, text) => {
    if (line === undefined) return;
    if (!values.has(line)) values.set(line, []);
    values.get(line).push(text);
  };
  for (const raw of out.trim().split("\n")) {
    const m = JSON.parse(raw);
    if (m.t === "value") {
      // Mirror the session's rule: `update` (promise settling) REPLACES the
      // site's prior preview in place; otherwise append (loops show several).
      const line = siteById.get(m.siteId)?.line;
      if (line === undefined) continue;
      if (!values.has(line)) values.set(line, []);
      const list = values.get(line);
      if (m.update && siteSlot.has(m.siteId)) {
        list[siteSlot.get(m.siteId)] = m.value.preview;
      } else {
        siteSlot.set(m.siteId, list.length);
        list.push(m.value.preview);
      }
    } else if (m.t === "console") addValue(lineMap.get(m.siteId), m.args.map((a) => a.preview).join(" "));
    else if (m.t === "error" && m.siteId !== undefined) errorsAt.set(lineMap.get(m.siteId), m.message);
    else if (m.t === "cover") hits.set(m.siteId, m.hits);
  }

  // Coverage state per line from sites + hits (the session's rule).
  const lineState = new Map(); // line -> { hit: bool, missed: bool }
  for (const s of sites) {
    if (s.kind !== "statement" && s.kind !== "branch") continue;
    const st = lineState.get(s.line) ?? { hit: false, missed: false };
    if ((hits.get(s.id) ?? 0) > 0) st.hit = true;
    else st.missed = true;
    lineState.set(s.line, st);
  }
  const coverage = new Map(
    [...lineState].map(([line, st]) => [
      line,
      st.hit && st.missed ? "partial" : st.hit ? "covered" : "uncovered",
    ]),
  );

  const failures = [];
  for (const [line, want] of expect.values) {
    const got = (values.get(line) ?? []).join(", ");
    if (!got.includes(want)) failures.push(`line ${line}: value want ⊇ ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const [line, want] of expect.exact) {
    const got = (values.get(line) ?? []).join(", ");
    if (got !== want) failures.push(`line ${line}: value want = ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const [line, want] of expect.coverage) {
    const got = coverage.get(line) ?? "none";
    if (got !== want) failures.push(`line ${line}: coverage want ${want}, got ${got}`);
  }
  for (const [line, want] of expect.errors) {
    const got = errorsAt.get(line) ?? "";
    if (!got.includes(want)) failures.push(`line ${line}: error want ⊇ ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return failures;
}

const filter = process.argv[2];
const caseDir = join(root, "eval", "cases");
const files = readdirSync(caseDir).filter((f) => f.endsWith(".ts") && (!filter || f.includes(filter)));
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
console.log(failed === 0 ? `\neval: all ${files.length} cases pass` : `\neval: ${failed}/${files.length} cases FAILED`);
process.exit(failed === 0 ? 0 : 1);
