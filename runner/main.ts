/**
 * Quoll runner — executes user code in a permission-locked Deno subprocess.
 *
 * Lifecycle (one process per run; the host kills the process to cancel):
 *   stdin:  one HostMsg `run` as NDJSON
 *   stdout: RunnerMsg NDJSON stream … `done` → async grace window → `exit`
 *
 * Phase 1 scope: console.* capture only. Value capture (instrumented code),
 * expand, and profiling arrive in later phases.
 */

// NB: protocol/* imports here MUST stay `import type`. The packaged extension
// does not ship protocol/ (.vscodeignore) — type-only imports are erased by
// Deno before resolution, but a value import would fail at runtime in the
// packaged extension only.
import type { ConsoleLevel, HostMsg, RunnerEvent, RunnerMsg } from "../protocol/index.ts";
import { toRemoteValue } from "./serialize.ts";

// TODO(config): expose as `asyncGraceMs` per the spec's run-completion semantics.
const ASYNC_GRACE_MS = 200;
// Hard cap on the post-`done` quiet window, so a setInterval can't keep the
// run alive indefinitely. Hitting it exits with reason "timeout".
const ASYNC_MAX_MS = 5000;

let runId = -1;
let seq = 0;

const encoder = new TextEncoder();

function send(event: RunnerEvent): void {
  const msg: RunnerMsg = { runId, seq: seq++, ts: Date.now(), ...event };
  const bytes = encoder.encode(JSON.stringify(msg) + "\n");
  try {
    let written = 0;
    while (written < bytes.length) {
      written += Deno.stdout.writeSync(bytes.subarray(written));
    }
  } catch {
    // Host closed the pipe (cancelled/killed run) — nothing left to report to.
    Deno.exit(0);
  }
}

/**
 * Line attribution bridge (phases 2–3): the innermost data:-URL stack frame
 * gives the 1-based line in the code we EXECUTED — i.e. the generated
 * (transpiled) line, not the source line. siteId carries that generated
 * line; the host maps it back to a source line via the run's source map
 * (identity only on the no-transpile fallback path). Replaced by real
 * instrumented capture calls in phase 4.
 */
// NB: Deno elides long data: URLs in stack frames ("base64,Ly8g......g==:2:9"),
// so match any non-colon run rather than strict base64.
const DATA_URL_FRAME = /data:application\/typescript;base64,[^\s:]+:(\d+):\d+/;

function userCallLine(stack: string | undefined): number | undefined {
  const match = stack?.match(DATA_URL_FRAME);
  return match ? Number(match[1]) : undefined;
}

// Runner-internal sleeps must bypass the timer patch below, or the grace
// loop's own setTimeout would hold the quiet window open forever.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => nativeSetTimeout(resolve, ms));
}

/**
 * Count outstanding user setTimeouts so the quiet window can extend on
 * PENDING timers, not just recent emissions — an isolated setTimeout(cb, 250)
 * must survive a 200ms quiet check. setInterval is deliberately untracked
 * (never settles); its ticks extend the window via `seq` until ASYNC_MAX_MS.
 */
type TimerId = ReturnType<typeof globalThis.setTimeout>;

let pendingTimers = 0;
function patchTimers(): void {
  const origSet = globalThis.setTimeout.bind(globalThis);
  const origClear = globalThis.clearTimeout.bind(globalThis);
  const live = new Set<TimerId>();
  globalThis.setTimeout = ((cb: (...cbArgs: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id: TimerId = origSet(
      (...cbArgs: unknown[]) => {
        if (live.delete(id)) pendingTimers--;
        cb(...cbArgs);
      },
      delay,
      ...args,
    );
    live.add(id);
    pendingTimers++;
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id?: TimerId) => {
    if (id !== undefined && live.delete(id)) pendingTimers--;
    origClear(id);
  }) as typeof globalThis.clearTimeout;
}

/** Late async failures (timer throws, unhandled rejections) become protocol
 * error events instead of tearing the process down mid-grace. */
function trapAsyncErrors(): void {
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    send({ t: "error", message: e.message || String(e.error), stack, siteId: userCallLine(stack) });
  });
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    const reason: unknown = e.reason;
    const stack = reason instanceof Error ? reason.stack : undefined;
    send({
      t: "error",
      message: reason instanceof Error ? reason.message : String(reason),
      stack,
      siteId: userCallLine(stack),
    });
  });
}

function patchConsole(): void {
  const levels: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    (console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>)[level] = (
      ...args: unknown[]
    ) => {
      send({
        t: "console",
        level,
        args: args.map(toRemoteValue),
        siteId: userCallLine(new Error().stack),
      });
    };
  }
}

function toDataUrl(code: string): string {
  const bytes = encoder.encode(code);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:application/typescript;base64,${btoa(binary)}`;
}

async function handleRun(msg: Extract<HostMsg, { t: "run" }>): Promise<never> {
  runId = msg.runId;
  seq = 0;
  patchConsole();
  patchTimers();
  trapAsyncErrors();

  const start = performance.now();
  try {
    // data: URL import: no fs/net permission needed, TS supported, and
    // top-level await resolves before `done` — sync pass + microtask flush.
    await import(toDataUrl(msg.code));
  } catch (err) {
    const stack = err instanceof Error ? err.stack : undefined;
    send({
      t: "error",
      message: err instanceof Error ? err.message : String(err),
      stack,
      siteId: userCallLine(stack),
    });
  }
  send({ t: "done", durationMs: Math.round(performance.now() - start) });

  // QUIET window (per spec): the run stays alive while events keep arriving
  // OR user timers are still pending, so isolated long timers and chains both
  // survive; ASYNC_MAX_MS caps it (setInterval exits here as "timeout").
  const graceStart = performance.now();
  let lastSeq = seq;
  while (performance.now() - graceStart < ASYNC_MAX_MS) {
    await sleep(ASYNC_GRACE_MS);
    if (seq === lastSeq && pendingTimers === 0) {
      send({ t: "exit", reason: "complete" });
      Deno.exit(0);
    }
    lastSeq = seq;
  }
  send({ t: "exit", reason: "timeout" });
  Deno.exit(0);
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
}

for await (const line of lines(Deno.stdin.readable)) {
  const msg = JSON.parse(line) as HostMsg;
  switch (msg.t) {
    case "run":
      await handleRun(msg);
      break;
    case "cancel":
      // Cancellation is process kill from the host side; nothing to do here.
      break;
    default:
      // expand (phase 5), profileStart/profileStop (phase 12).
      break;
  }
}
