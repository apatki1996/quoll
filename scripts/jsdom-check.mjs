// End-to-end check of the Phase 7 browser runtime: with argv[1] === "browser"
// the runner installs a jsdom window's globals before user code loads, so DOM
// code runs in a scratchpad — and the runner's own console/timer patches
// survive that install, which is the part most likely to break silently.
// Spawned with the same flags and the same EMPTY environment as
// src/runner/client.ts, so what this proves is what ships.
// Usage: DENO=$(mise which deno) node scripts/jsdom-check.mjs
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deno = process.env.DENO ?? "deno";

/** Runs `code` in the given mode; resolves with the run's messages. */
function run(code, mode) {
  const child = spawn(
    deno,
    [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-remote",
      "--node-modules-dir=manual",
      "--sloppy-imports",
      `--allow-read=${root}`,
      ...(mode === "browser" ? ["--allow-env"] : []),
      join(root, "runner", "main.ts"),
      "5000",
      mode,
    ],
    // cwd drives byonm resolution of npm:jsdom; the scrubbed env (PATH only,
    // so a bare `deno` still resolves) is what makes --allow-env safe to
    // grant. Mirrors src/runner/client.ts exactly.
    { cwd: root, env: mode === "browser" ? { PATH: process.env.PATH ?? "" } : process.env },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(d));

  const messages = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const failsafe = setTimeout(() => {
      child.kill();
      reject(new Error("runner never sent exit"));
    }, 60_000);
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
    child.stdin.write(JSON.stringify({ t: "run", runId: 1, code, entry: "dom.ts" }) + "\n");
  });
}

const logs = (msgs) => msgs.filter((m) => m.t === "console").map((m) => m.args[0].preview);
const errors = (msgs) => msgs.filter((m) => m.t === "error").map((m) => m.message);

// 1) The DOM is there, mutable, and queryable — and `console.log` still
//    reaches the host, i.e. jsdom's window.console did not replace the patch.
const dom = `
document.body.innerHTML = "<p id='x'>hello</p>";
console.log(document.getElementById("x").textContent);
console.log(typeof Element, typeof localStorage, typeof window);
`;
const domRun = await run(dom, "browser");
assert.deepEqual(errors(domRun), [], "browser run must not error");
assert.deepEqual(logs(domRun), ['"hello"', '"function"'], "DOM globals must be installed");
assert.equal(domRun.at(-1).reason, "complete");

// 2) The globals a jsdom window wraps by DELEGATING to the real one are left
//    alone, so they don't become their own callee. Each of these recursed
//    until the stack blew when jsdom's copy was installed — and `btoa` did it
//    while reporting "invalid characters", blaming the caller's input. The
//    window's own wrappers must work too: they delegate to what is left here.
const wrappers = `
console.log(btoa("hi"), atob("aGk="), window.btoa("hi"));
queueMicrotask(() => console.log("microtask"));
console.log(typeof performance.now());
`;
const wrapperRun = await run(wrappers, "browser");
assert.deepEqual(errors(wrapperRun), [], "self-delegating globals must not recurse");
assert.deepEqual(logs(wrapperRun), ['"aGk="', '"number"', '"microtask"'], "wrappers must work");

// 3) Value capture works through DOM expressions (the whole point — these are
//    ordinary capture sites whose values happen to be DOM objects).
const captured = `(globalThis as any).__quoll.log(0, document.title = "t");`;
const capturedRun = await run(captured, "browser");
assert.equal(
  capturedRun.find((m) => m.t === "value" && m.siteId === 0)?.value.preview,
  '"t"',
  "captures must still be emitted in browser mode",
);

// 4) The timer patch survived: a pending setTimeout still holds the run open
//    and its late value is re-emitted. jsdom's window.setTimeout would be
//    untracked, so the run would end early and report "complete" with nothing.
const timer = `
const p = new Promise((r) => setTimeout(() => r(document.createElement("div").tagName), 600));
(globalThis as any).__quoll.log(1, p);
`;
const started = Date.now();
const timerRun = await run(timer, "browser");
const elapsed = Date.now() - started;
const values = timerRun.filter((m) => m.t === "value" && m.siteId === 1);
assert.ok(values.length >= 2, "the runner's timer patch must survive the jsdom install");
assert.match(values.at(-1).value.preview, /then "DIV"/);
assert.ok(elapsed >= 600, `must wait for the DOM timer (waited ${elapsed}ms)`);

// 5) node mode is untouched: no DOM, no jsdom load, so the default stays the
//    plain sandbox and nobody pays for a runtime they didn't ask for.
const nodeRun = await run(`console.log(typeof document);`, "node");
assert.deepEqual(logs(nodeRun), ['"undefined"'], "node mode must not install a DOM");

console.log("jsdom-check PASS");
console.log(`  DOM globals, captures and the timer patch all survive; waited ${elapsed}ms`);
