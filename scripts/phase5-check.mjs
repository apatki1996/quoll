// End-to-end phase 5 check: value capture → objectId → `expand` round-trip,
// proving the runner KEEPS SERVING expansion after `exit` (keep-alive), plus
// nested expansion and unknown-id/wrong-runId errors.
// Usage: DENO=$(mise which deno) node scripts/phase5-check.mjs
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deno = process.env.DENO ?? "deno";

// Calls the __quoll runtime directly — no instrumentation needed for this check.
const code = `
const user = { name: "Ada", langs: ["js", "ts"] };
(globalThis as any).__quoll.log(0, user);
`;

const child = spawn(deno, ["run", "--quiet", "--no-prompt", join(root, "runner", "main.ts")]);
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(d));

const queue = [];
const waiters = [];
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  }
});

function nextMsg(timeoutMs = 8000) {
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for runner message")), timeoutMs);
    waiters.push((m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}

async function nextOfType(t) {
  for (;;) {
    const m = await nextMsg();
    if (m.t === t) return m;
  }
}

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

send({ t: "run", runId: 7, code, entry: "phase5.ts" });

const value = await nextOfType("value");
assert.equal(value.value.type, "object");
assert.ok(value.value.objectId, "captured object must carry an objectId");

await nextOfType("exit"); // event log sealed; the process must still answer

// 1) expand AFTER exit — the keep-alive contract
send({ t: "expand", runId: 7, reqId: 1, objectId: value.value.objectId });
const res1 = await nextOfType("expandResult");
assert.equal(res1.reqId, 1);
assert.equal(res1.error, undefined);
assert.deepEqual(res1.entries.map((e) => e.key), ["name", "langs"]);
const langs = res1.entries.find((e) => e.key === "langs");
assert.equal(langs.value.type, "array");
assert.ok(langs.value.objectId, "nested array must be expandable");

// 2) nested expansion
send({ t: "expand", runId: 7, reqId: 2, objectId: langs.value.objectId });
const res2 = await nextOfType("expandResult");
assert.deepEqual(
  res2.entries.map((e) => [e.key, e.value.preview]),
  [["0", '"js"'], ["1", '"ts"'], ["length", "2"]],
);

// 3) unknown id
send({ t: "expand", runId: 7, reqId: 3, objectId: "o999999" });
const res3 = await nextOfType("expandResult");
assert.equal(res3.error, "unknown");
assert.deepEqual(res3.entries, []);

// 4) wrong runId → unknown
send({ t: "expand", runId: 8, reqId: 4, objectId: value.value.objectId });
const res4 = await nextOfType("expandResult");
assert.equal(res4.error, "unknown");

child.kill();
console.log("phase5-check PASS");
console.log("  expand-after-exit, nested expansion, unknown-id, wrong-runId all ok");
