/**
 * Quoll runner — executes user code in a permission-locked Deno subprocess.
 *
 * Lifecycle (one run per process; the host kills the process to cancel):
 *   stdin:  one HostMsg `run`, then any number of `expand`, as NDJSON
 *   stdout: RunnerMsg NDJSON stream … `done` → async grace window → `exit`
 *
 * `exit` ends the EVENT LOG, not the process: the runner lingers afterwards
 * serving `expand` from the object registry (value explorer) until the host
 * kills it on the next run / session stop.
 */

// NB: protocol/* imports here MUST stay `import type`. The packaged extension
// does not ship protocol/ (.vscodeignore) — type-only imports are erased by
// Deno before resolution, but a value import would fail at runtime in the
// packaged extension only.
import type { ConsoleLevel, HostMsg, RunnerEvent, RunnerMsg } from "../protocol/index.ts";
import { expandObject, toRemoteValue } from "./serialize.ts";

// TODO(config): expose as `asyncGraceMs` per the spec's run-completion semantics.
const ASYNC_GRACE_MS = 200;
// Hard cap on the post-`done` quiet window, so a setInterval can't keep the
// run alive indefinitely. Hitting it exits with reason "timeout".
const ASYNC_MAX_MS = 5000;

let runId = -1;
let seq = 0;
// Set just before `exit` goes out. The event log is sealed from then on:
// only expandResult may follow (a stray setInterval in the lingering process
// must not keep streaming values at the host).
let exited = false;

const encoder = new TextEncoder();

function send(event: RunnerEvent): void {
  if (exited && event.t !== "expandResult") return;
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
  // Timeouts and intervals share an id space, so clearInterval(timeoutId)
  // clears a tracked timer too — it must maintain the pending count or the
  // quiet window would hang until ASYNC_MAX_MS. (live never contains interval
  // ids; setInterval is untracked, see above.)
  const origClearInterval = globalThis.clearInterval.bind(globalThis);
  globalThis.clearInterval = ((id?: TimerId) => {
    if (id !== undefined && live.delete(id)) pendingTimers--;
    origClearInterval(id);
  }) as typeof globalThis.clearInterval;
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

// Don't flood the IPC channel from hot loops; the renderer caps per-line
// display anyway. Coverage hits keep counting past the cap.
const VALUE_CAP_PER_SITE = 500;

const coverHits = new Map<number, number>();
const flushedThrough = new Map<number, number>();

/** The runtime global the instrumented code calls into (see instrument.rs). */
function installQuollRuntime(): void {
  const valuesSent = new Map<number, number>();
  (globalThis as Record<string, unknown>).__quoll = {
    log(siteId: number, value: unknown): unknown {
      const n = (valuesSent.get(siteId) ?? 0) + 1;
      valuesSent.set(siteId, n);
      if (n <= VALUE_CAP_PER_SITE) {
        send({ t: "value", siteId, value: toRemoteValue(value) });
      }
      return value;
    },
    cover(siteId: number): void {
      coverHits.set(siteId, (coverHits.get(siteId) ?? 0) + 1);
    },
  };
}

/** Send cover totals that changed since the last flush (host keeps latest). */
function flushCover(): void {
  for (const [siteId, hits] of coverHits) {
    if (flushedThrough.get(siteId) !== hits) {
      send({ t: "cover", siteId, hits });
      flushedThrough.set(siteId, hits);
    }
  }
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

async function handleRun(msg: Extract<HostMsg, { t: "run" }>): Promise<void> {
  runId = msg.runId;
  seq = 0;
  installQuollRuntime();
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
  flushCover();
  send({ t: "done", durationMs: Math.round(performance.now() - start) });

  // QUIET window (per spec): the run stays alive while events keep arriving
  // OR user timers are still pending, so isolated long timers and chains both
  // survive; ASYNC_MAX_MS caps it (setInterval exits here as "timeout").
  const graceStart = performance.now();
  let lastSeq = seq;
  let reason: "complete" | "timeout" = "timeout";
  while (performance.now() - graceStart < ASYNC_MAX_MS) {
    await sleep(ASYNC_GRACE_MS);
    if (seq === lastSeq && pendingTimers === 0) {
      reason = "complete";
      break;
    }
    lastSeq = seq;
  }
  flushCover(); // late timer/promise work may have added hits
  send({ t: "exit", reason });
  exited = true;
  // No Deno.exit: linger to serve `expand` until the host kills us.
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

let ran = false;
for await (const line of lines(Deno.stdin.readable)) {
  const msg = JSON.parse(line) as HostMsg;
  switch (msg.t) {
    case "run":
      // NOT awaited: the loop must keep reading so `expand` is served both
      // during the run and after `exit` (keep-alive). One run per process.
      if (!ran) {
        ran = true;
        handleRun(msg).catch((err: unknown) => {
          send({ t: "error", message: err instanceof Error ? err.message : String(err) });
          send({ t: "exit", reason: "crash" });
          exited = true;
        });
      }
      break;
    case "expand": {
      const outcome = msg.runId === runId
        ? expandObject(msg.objectId)
        : ({ error: "unknown" } as const);
      send(
        "error" in outcome
          ? { t: "expandResult", reqId: msg.reqId, entries: [], error: outcome.error }
          : { t: "expandResult", reqId: msg.reqId, entries: outcome.entries },
      );
      break;
    }
    case "cancel":
      // Cancellation is process kill from the host side; nothing to do here.
      break;
    default:
      // profileStart/profileStop (phase 12).
      break;
  }
}
// stdin closed: the host is gone, so no one can ever ask for an expansion.
Deno.exit(0);
