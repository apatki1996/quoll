// End-to-end check of the post-`done` wait: Quoll stays alive while user
// timers are pending (so a slow setTimeout still reports its value), and the
// run-timeout ceiling is what stops it — a setInterval exits "timeout".
// The ceiling is passed as the runner's argv[0], so this runs it small and
// fast instead of waiting out the 10s default.
// Usage: DENO=$(mise which deno) node scripts/timeout-check.mjs
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deno = process.env.DENO ?? "deno";
const CEILING_MS = 1500;

/** Runs `code` under a small ceiling; resolves with the run's messages. */
function run(code, ceilingMs = CEILING_MS) {
  const child = spawn(deno, [
    "run",
    "--quiet",
    "--no-prompt",
    join(root, "runner", "main.ts"),
    String(ceilingMs),
  ]);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(d));

  const messages = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const failsafe = setTimeout(() => {
      child.kill();
      reject(new Error("runner never sent exit"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        messages.push(msg);
        if (msg.t === "exit") {
          clearTimeout(failsafe);
          child.kill(); // the runner lingers to serve `expand`; we're done
          resolve(messages);
        }
      }
    });
    child.stdin.write(JSON.stringify({ t: "run", runId: 1, code, entry: "timeout.ts" }) + "\n");
  });
}

// 1) A timer that settles INSIDE the ceiling: the run waits for it, the
//    captured promise is patched from pending to its settled value, and the
//    run still completes cleanly.
const settles = `
const p = new Promise((resolve) => setTimeout(() => resolve(42), 700));
(globalThis as any).__quoll.log(0, p);
`;
const started = Date.now();
const waited = await run(settles);
const elapsed = Date.now() - started;
const values = waited.filter((m) => m.t === "value" && m.siteId === 0);
assert.ok(values.length >= 2, `expected a pending value then a settled one, got ${values.length}`);
assert.match(values.at(-1).value.preview, /then 42/, "late settlement must be re-emitted");
assert.equal(values.at(-1).update, true, "the re-emit replaces the pending value in place");
assert.equal(waited.at(-1).reason, "complete", "a settled timer is not a timeout");
assert.ok(elapsed >= 700, `must actually wait for the timer (waited ${elapsed}ms)`);

// 2) A run that never goes quiet: an interval that keeps emitting events
//    holds the wait loop open, so the ceiling is the only thing that ends it.
//    (A SILENT setInterval is deliberately untracked and does not hold the
//    run — see patchTimers in runner/main.ts.)
const forever = `setInterval(() => console.log("tick"), 100);`;
const capped = Date.now();
const timedOut = await run(forever);
const cappedElapsed = Date.now() - capped;
assert.equal(timedOut.at(-1).t, "exit");
assert.equal(timedOut.at(-1).reason, "timeout", "a pending setInterval must hit the ceiling");
assert.ok(
  cappedElapsed >= CEILING_MS && cappedElapsed < CEILING_MS + 10_000,
  `ceiling must bound the wait (took ${cappedElapsed}ms for a ${CEILING_MS}ms ceiling)`,
);

console.log("timeout-check PASS");
console.log(`  waited ${elapsed}ms for a 700ms timer; capped setInterval at ${cappedElapsed}ms`);
