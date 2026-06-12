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

import type { ConsoleLevel, HostMsg, RunnerEvent, RunnerMsg } from "../protocol/index.ts";
import { toRemoteValue } from "./serialize.ts";

// TODO(config): expose as `asyncGraceMs` per the spec's run-completion semantics.
const ASYNC_GRACE_MS = 200;

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

function patchConsole(): void {
  const levels: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    (console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>)[level] = (
      ...args: unknown[]
    ) => {
      send({ t: "console", level, args: args.map(toRemoteValue) });
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

  const start = performance.now();
  try {
    // data: URL import: no fs/net permission needed, TS supported, and
    // top-level await resolves before `done` — sync pass + microtask flush.
    await import(toDataUrl(msg.code));
  } catch (err) {
    send({
      t: "error",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
  send({ t: "done", durationMs: Math.round(performance.now() - start) });

  // Grace window: late timers/Promises may still emit console/value messages.
  await new Promise((resolve) => setTimeout(resolve, ASYNC_GRACE_MS));
  send({ t: "exit", reason: "complete" });
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
