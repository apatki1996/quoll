/**
 * IPC between extension host and runner: newline-delimited JSON, bidirectional.
 * Runtime-agnostic (Deno first, Node swappable).
 * FROZEN INTERFACE (quoll-spec.md): changes here are breaking protocol changes.
 */

import type { RemoteValue } from "./values.ts";

// ── host -> runner ─────────────────────────────────────────────

export type HostMsg =
  | { t: "run"; runId: number; code: string; entry: string }
  | { t: "cancel"; runId: number }
  | { t: "expand"; runId: number; reqId: number; objectId: string }
  // phase 12 (CPU Profiler)
  | { t: "profileStart"; runId: number }
  | { t: "profileStop"; runId: number };

// ── runner -> host ─────────────────────────────────────────────

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export type ExitReason = "complete" | "cancelled" | "timeout" | "crash";

/**
 * Every runner message carries:
 * - `runId` — host discards messages from non-current runs (debounce safety)
 * - `seq`   — monotonic per run; the replayable event-log order that Time
 *             Machine, Interactive Timeline, and sharing consume
 * - `ts`    — epoch ms
 */
export type RunnerMsgMeta = {
  runId: number;
  seq: number;
  ts: number;
};

/**
 * One frame of the runner's shadow call stack (phase 11).
 * - `fn` — the `function` capture site executing; ABSENT for the module's top
 *          level, which only ever appears as the outermost frame, and only
 *          when the module body itself made the call.
 * - `at` — the statement or branch site this frame most recently entered:
 *          where it is. For an outer frame, that is the call in progress.
 *          Absent before the frame's first statement (an expression-bodied
 *          arrow has none).
 */
export type StackFrame = { fn?: number; at?: number };

/**
 * Carried by the events a user can stop at (`value`, `console`, `perf`,
 * `error`): the call stack when the event happened, OUTERMOST first. (Named
 * `frames` because `error` already had a `stack` — the V8 stack text.) Absent
 * means top-level code. Only the innermost frames are sent; `stackDepth` is
 * present when that cut anything, and holds how many FUNCTION frames there
 * really were (the top-level position isn't a call, so it never counts).
 *
 * Additive and optional, so a host that ignores it renders exactly what it
 * did before phase 11.
 */
export type StackInfo = { frames?: StackFrame[]; stackDepth?: number };

export type RunnerEvent =
  /** console.* output. */
  | ({ t: "console"; level: ConsoleLevel; args: RemoteValue[]; siteId?: number } & StackInfo)
  /**
   * Expression capture. Re-emitted with the same siteId when a Promise
   * settles late (after `done`, before `exit`); the re-emit carries
   * `update: true` so the host REPLACES the site's prior value (pending →
   * `then <v>` / `catch <e>`) instead of appending it — a single evolving
   * value, not a new capture. Absent/false means a fresh capture (append;
   * loops produce several).
   */
  | ({ t: "value"; siteId: number; value: RemoteValue; update?: true } & StackInfo)
  /** `//?.` timing. */
  | ({ t: "perf"; siteId: number; durationMs: number } & StackInfo)
  /** Statement & branch sites (see CaptureSiteKind). */
  | { t: "cover"; siteId: number; hits: number }
  /**
   * `stack` is the V8 stack TEXT. `frames` (phase 11) is the call stack at
   * the THROW, not where the error was finally reported.
   */
  | ({ t: "error"; message: string; stack?: string; siteId?: number } & StackInfo)
  /**
   * Sync run + microtask flush complete. Late async `value`/`console`
   * messages MAY still follow until `exit`: the runner stays alive while
   * timers/promises are still pending so they can re-emit, bounded by the
   * run-timeout ceiling (config `runTimeoutMs`), then sends `exit`. The host
   * renders at `done` and patches as late values arrive. (The earlier
   * `asyncGraceMs` quiet-window framing was retired — see DECISIONS "Gap 2".)
   */
  | { t: "done"; durationMs: number }
  /** `entries` is empty when `error` is set ("evicted": LRU-dropped under the
   * memory budget; "unknown": id never existed / wrong runId). */
  | {
      t: "expandResult";
      reqId: number;
      entries: { key: string; value: RemoteValue }[];
      error?: "evicted" | "unknown";
    }
  /**
   * Terminal for the EVENT LOG (nothing after it is part of the recorded
   * run). The runner process itself stays alive afterwards to serve `expand`
   * for the value explorer; objectIds for this runId stay valid until the
   * host kills the process (next run or session stop).
   */
  | { t: "exit"; reason: ExitReason };

export type RunnerMsg = RunnerMsgMeta & RunnerEvent;
