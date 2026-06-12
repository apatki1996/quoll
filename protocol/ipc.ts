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

export type RunnerEvent =
  /** console.* output. */
  | { t: "console"; level: ConsoleLevel; args: RemoteValue[]; siteId?: number }
  /**
   * Expression capture. Re-emitted with the same siteId when a Promise
   * settles late (after `done`, before `exit`).
   */
  | { t: "value"; siteId: number; value: RemoteValue }
  /** `//?.` timing. */
  | { t: "perf"; siteId: number; durationMs: number }
  /** Statement & branch sites (see CaptureSiteKind). */
  | { t: "cover"; siteId: number; hits: number }
  | { t: "error"; message: string; stack?: string; siteId?: number }
  /**
   * Sync run + microtask flush complete. Late async `value`/`console`
   * messages MAY still follow until `exit`: the runner stays alive for a
   * quiet-window grace period (config `asyncGraceMs`) so settling
   * Promises/timers can re-emit, then sends `exit`. The host renders at
   * `done` and patches as late values arrive.
   */
  | { t: "done"; durationMs: number }
  | { t: "expandResult"; reqId: number; entries: { key: string; value: RemoteValue }[] }
  /** Terminal. After `exit`, all objectIds for this runId are invalid. */
  | { t: "exit"; reason: ExitReason };

export type RunnerMsg = RunnerMsgMeta & RunnerEvent;
