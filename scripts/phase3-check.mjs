// End-to-end phase 3 check: native transpile → line map → sandboxed run →
// assert runner output attributes back to the correct ORIGINAL source lines.
// Usage: DENO=$(mise which deno) node scripts/phase3-check.mjs
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLineMap } from "../src/instrument/sourcemap.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const core = require(join(root, "native", `quoll-core.${process.platform}-${process.arch}.node`));

// Type-only lines (interface, type alias) shift everything below them.
const source = `interface User {
  name: string;
  age: number;
}

const u: User = { name: "Ada", age: 36 };
console.log(u.name);

type Pair<T> = [T, T];
const p: Pair<number> = [1, 2];
console.log(p);

function add(a: number, b: number): number {
  return a + b;
}
console.log(add(2, 3));
`;
const EXPECT = [7, 11, 16]; // source lines of the three console.log calls

const { code, mapJson, errors } = core.instrument(source, { filename: "sample.ts", jsx: false });
assert.equal(errors.length, 0, `transpile errors: ${JSON.stringify(errors)}`);
assert.ok(!code.includes("interface"), "types must be stripped");
const lineMap = buildLineMap(JSON.parse(mapJson));

const deno = process.env.DENO ?? "deno";
const child = spawn(deno, ["run", "--quiet", "--no-prompt", join(root, "runner", "main.ts")]);
child.stdin.write(JSON.stringify({ t: "run", runId: 1, code, entry: "sample.ts" }) + "\n");

let out = "";
child.stdout.on("data", (c) => {
  out += c;
  // The runner lingers after `exit` to serve expand (phase 5); kill it once
  // the event log is complete (trailing newline = no mid-line cut).
  if (out.includes('"t":"exit"') && out.endsWith("\n")) child.kill();
});
await new Promise((resolve) => child.on("close", resolve));

const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
const consoles = msgs.filter((m) => m.t === "console");
assert.equal(consoles.length, 3, `expected 3 console messages, got ${consoles.length}`);

const sourceLines = consoles.map((m) => lineMap.get(m.siteId));
assert.deepEqual(sourceLines, EXPECT, `mapped lines ${sourceLines} != ${EXPECT}`);
assert.equal(consoles[0].args[0].preview, '"Ada"');
assert.equal(consoles[1].args[0].preview, "[ 1, 2 ]");
assert.equal(consoles[2].args[0].preview, "5");

console.log("phase3-check PASS");
console.log(`  generated→source: ${consoles.map((m) => `${m.siteId}→${lineMap.get(m.siteId)}`).join(", ")}`);
