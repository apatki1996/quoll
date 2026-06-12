/**
 * Quoll's frozen interfaces — the contracts between the extension host (TS),
 * the instrumentation core (Rust/Oxc via napi), and the runner (Deno).
 * See quoll-spec.md "Frozen interfaces".
 */

export type * from "./capture.ts";
export type * from "./ipc.ts";
export type * from "./values.ts";
