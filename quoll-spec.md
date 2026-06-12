# Quoll — Project Spec & Agent Context

> A live-scratchpad VS Code extension: runs JS/TS as you type and shows runtime
> values inline. An open-source, modern-stack reimagining of Quokka.js, scoped to
> VS Code only.
>
> This file is the source of truth for the build. If you use Claude Code, rename
> or symlink it to `CLAUDE.md` so it auto-loads as project memory.

## Identity

- **Name:** Quoll — an endangered Australian marsupial; the quokka's "Qu-" sibling.
- **npm package (core):** `quoll`  *(verify free with `npm view quoll` → 404 = yours)*
- **Publisher:** `apatki` · **Extension id:** `apatki.quoll` · **Command namespace:** `quoll.*`
- **Repo:** `apatki/quoll`
- Note: the `@quoll` npm org scope is taken by someone else, so avoid `@quoll/*`.
  `quoll-http` also exists (inactive) but does not block the bare `quoll` name.

```jsonc
// package.json (identity fields)
{
  "name": "quoll",
  "displayName": "Quoll",
  "publisher": "apatki",
  "description": "Live runtime values inline, as you type — for JS/TS.",
  "contributes": {
    "commands": [
      { "command": "quoll.start", "title": "Quoll: Start on Current File" }
    ]
  }
}
```

## Scope & end goal

- **End goal: full feature parity with Quokka.js (Community AND Pro).** v1 is a
  deliberate subset, but every interface below is designed so that no later
  parity feature requires a breaking protocol change.
- **VS Code only** — no WebStorm/Sublime/JetBrains abstraction layer (this is the
  deliberate simplification vs. real Quokka; collapses the host layer to one
  decoration API). Quokka's multi-editor support is explicitly NOT a parity target.
- JS + TS + JSX/TSX. **Node-style target first** (Deno runner); browser/jsdom
  support is phase 7.
- **v1 features:** inline runtime values, coverage gutter, value explorer, inline errors.
- **Non-goals (for now):** a Quokka-style plugins API, a hosted sharing service.
  Revisit post-parity.

### Parity matrix (Quokka feature → Quoll phase)

| Feature | Quokka edition | Quoll phase |
|---|---|---|
| Live execution + inline values, as you type | Community | 1–4 |
| Inline errors | Community | 2 |
| Live coverage incl. partial (branch) coverage | Community | 4 |
| Value Explorer (treeview, copy values) | Pro | 5 |
| Project file imports + auto change detection | Community | 6 |
| Browser-like runtime (jsdom) | Community | 7 |
| Live Comments `//?`, perf `//?.`, value-on-selection | Community | 8 |
| Logpoints (breakpoints as log sites) | Community | 9 |
| Time Machine (step through execution) | Community | 10 |
| Interactive Timeline | Pro | 11 |
| Interactive Value Graphs | Pro | 11 |
| CPU Profiler | Community | 12 |
| Snaps (run snippets in Vue/Svelte files) | Community | 13 |
| Quick Package Install + config (env, runtime, tsconfig paths) | Community | 14 |
| Codeclip-style sharing (recording export; no hosted service) | Community | 15 |
| Plugins API | — | post-parity |

## Architecture

Five components. Define the interfaces between them BEFORE writing component code.

1. **Extension host (TypeScript)** — activation, debounced re-run on edit, inline
   value decorations (`DecorationRenderOptions.after`), coverage gutter
   decorations, a value-explorer `TreeDataProvider`, and orchestration of the
   runner. Owns the **append-only run event log** (the foundation for Time
   Machine, Timeline, and sharing). The extension shell stays TS because the
   VS Code host is Node-based.

2. **Instrumentation core (Rust / Oxc)** — a **single pass**: parse TS/JSX →
   strip types/JSX **and** inject value-capture (plus coverage counters) in one
   `Traverse` → `oxc_codegen` with **one** source map. Also extracts `//?` /
   `//?.` comment annotations and accepts caller-supplied extra capture
   positions (Logpoints, selection). Shipped to the extension via **napi-rs**
   (fallback: WASM).

3. **Runner / sandbox (Deno)** — executes the instrumented code in a
   permission-locked subprocess (`--deny-net`, `--deny-read`, etc.), captures
   console output, captured values, errors, and timings, and reports over IPC.
   Must also be able to drive V8 inspector profiling (CPU Profiler, phase 12).
   Keep the IPC layer runtime-agnostic so Node is swappable.

4. **Serialization protocol** — CDP-`RemoteObject`-style: lazy expansion via
   `objectId`, truncation, circular-ref handling; correct handling of typed
   arrays, `Map`/`Set`, class instances, and Promises (resolve and show).

5. **Golden-eval harness** — a corpus of `input snippet → expected annotations`
   (line N shows value X; lines covered; line dead). Run on **every** iteration.
   This is the objective quality signal and the regression net.

## Key technical decisions (and why)

- **Single Oxc pass, NOT transpile-then-instrument.** Stacking two tools forces
  you to compose two source maps, and Oxc's parser can't yet consume an input
  source map. Going original-source → final-output in one pass yields one
  accurate source map. **This is the make-or-break call for line-mapping accuracy.**
- **Start from the `oxc_coverage_instrument` crate's pattern** (parse →
  `SemanticBuilder` → `Traverse` inject → `codegen` + source map; Istanbul-
  compatible, includes source-map remapping). Fork its visitor to emit
  value-capture calls (e.g. `__quoll.log(siteId, expr)`) alongside / instead of
  coverage counters. ~Half the hardest part already exists here.
- **Every runner→host message carries `runId` + `seq`.** `runId` makes stale
  messages from a cancelled run discardable (debounce safety). `seq` makes the
  message stream an ordered, replayable event log — which is what Time Machine,
  Interactive Timeline, and Codeclip-style sharing consume. Adding these later
  would break every consumer; adding them now costs two fields.
- **Capture sites have a `kind`.** Live Comments, perf comments, Logpoints, and
  value-on-selection are all just capture sites with different origins. One enum
  plus `InstrumentOpts.extraSites` makes phases 8–9 frontend work, not core work.
- **Deno for the sandbox** — its permission model directly solves "run arbitrary
  code on every keystroke."
- **Rust core via napi for perf**; WASM only if you want one portable artifact.

## The hard parts (spend review time here — this is where AI output looks right but is subtly wrong)

1. **Source-map line/column accuracy** after instrumentation.
2. **Value capture + serialization** — the coverage crate *counts*; it does not
   *snapshot values*. You build this.
3. **Async / run-completion semantics** — micro/macrotask flushing; when is a run
   "done"; showing values that resolve later (see `done` vs `exit` below).
4. **Cancellation + debounce** of in-flight runs on the next keystroke (`runId`
   discipline on both sides).
5. **Event-log recording with bounded memory** — the log references runner-side
   objects by `objectId`; the runner must retain them under a memory budget with
   eviction. This is the Time Machine / Timeline foundation; get the retention
   contract right early.

## Frozen interfaces (write these first)

```ts
// ── napi boundary ──────────────────────────────────────────────
instrument(source: string, opts: InstrumentOpts): {
  code: string;
  map: RawSourceMap;
  sites: CaptureSite[];
}

type InstrumentOpts = {
  filename: string;
  jsx: boolean;
  // Extra caller-specified capture positions. This is the entire mechanism
  // for Logpoints (phase 9) and value-on-selection (phase 8).
  extraSites?: { line: number; column: number; kind: "logpoint" | "selection" }[];
};

type CaptureSite = {
  id: number;
  // Original-source span (pre-instrumentation).
  line: number; column: number; endLine: number; endColumn: number;
  // Why this site exists:
  //   expr      — auto-instrumented expression (inline values)
  //   statement — coverage counter (green/red gutter)
  //   branch    — coverage counter for one branch arm; a line whose branch
  //               sites have mixed zero/non-zero hits renders PARTIAL (yellow)
  //   comment   — `//?` live comment        perf — `//?.` timing comment
  //   logpoint  — from extraSites           selection — from extraSites
  kind: "expr" | "statement" | "branch" | "comment" | "perf" | "logpoint" | "selection";
};

// ── IPC: newline-delimited JSON, bidirectional ─────────────────

// host -> runner
type HostMsg =
  | { t: "run";    runId: number; code: string; entry: string }
  | { t: "cancel"; runId: number }
  | { t: "expand"; runId: number; reqId: number; objectId: string }
  // phase 12
  | { t: "profileStart"; runId: number }
  | { t: "profileStop";  runId: number };

// runner -> host. EVERY message carries runId (stale-run discard),
// seq (monotonic per run; the replayable event-log order), ts (epoch ms).
type RunnerMsg = { runId: number; seq: number; ts: number } & (
  | { t: "console"; level: "log" | "info" | "warn" | "error" | "debug";
      args: RemoteValue[]; siteId?: number }          // console.* output
  | { t: "value";  siteId: number; value: RemoteValue } // expression capture;
      // re-emitted with the same siteId when a Promise settles late
  | { t: "perf";   siteId: number; durationMs: number } // `//?.` timing
  | { t: "cover";  siteId: number; hits: number }        // statement & branch sites
  | { t: "error";  message: string; stack?: string; siteId?: number }
  | { t: "done";   durationMs: number }  // sync run + microtask flush complete;
      // late async `value`/`console` messages MAY still follow until `exit`
  | { t: "expandResult"; reqId: number;
      entries: { key: string; value: RemoteValue }[] }
  | { t: "exit";   reason: "complete" | "cancelled" | "timeout" | "crash" }
      // terminal. After `exit`, all objectIds for this runId are invalid.
);

// Run-completion semantics: `done` fires after the synchronous pass and
// microtask flush. The runner then stays alive for a quiet-window grace period
// (config `asyncGraceMs`) so settling Promises/timers can re-emit `value`
// messages, then sends `exit`. The host renders at `done` and patches as late
// values arrive.

// ── serialization ──────────────────────────────────────────────
type RemoteValue = {
  type:
    | "string" | "number" | "boolean" | "bigint" | "symbol"
    | "undefined" | "null"
    | "function" | "object" | "array" | "typedarray"
    | "date" | "regexp" | "map" | "set" | "promise" | "error";
  preview: string;       // truncated, display-ready
  objectId?: string;     // present if lazily expandable
};
// objectId lifetime: scoped to its runId; valid until that run's `exit`.
// The runner retains referenced objects under a memory budget with LRU
// eviction; expand() on an evicted id returns an "evicted" error while the
// recorded preview remains displayable (Time Machine degrades gracefully).
```

## Phased roadmap (each phase is a checkpoint)

0. **Scaffold** — `yo code`, esbuild bundling, activate on a scratch file.
1. **Run + capture** — run file in subprocess, capture `console.log` → output
   channel. *(Proves the loop.)*
2. **Inline decorations** — render values as `after` decorations; debounced
   re-run; `runId` discard discipline from day one.
3. **Transpile + source map** — single-pass Oxc; map instrumented line → source line.
4. **Value capture + coverage** — AST instrumentation emitting capture calls;
   coverage gutter with statement AND branch sites (partial-coverage yellow).
   **Build the golden-eval harness before starting this phase.**
5. **Serialization + value explorer** — protocol + tree view with lazy
   expansion; copy-value-to-clipboard.
6. **Async + project imports** — run-completion semantics (`done`/grace/`exit`);
   module resolution (ESM/CJS, tsconfig paths, node_modules); track the module
   dependency graph and **auto re-run when an imported project file changes**.
7. **Hardening + jsdom** — large/circular values, cancellation, perf, settings;
   browser-like runtime via jsdom (verify jsdom-under-Deno early — see stack notes).
8. **Live Comments + selection values** — `//?` value comments, `//?.` timing,
   show-value-on-selection. Core work is comment extraction in the Oxc pass;
   the rest is `kind`-aware rendering.
9. **Logpoints** — map VS Code breakpoints in Quoll files to `extraSites`
   capture positions; render like live comments.
10. **Time Machine** — persist the per-run event log (already ordered by `seq`);
    step forward/back re-rendering decorations from the log prefix.
11. **Interactive Timeline + Value Graphs** — webview consuming the same event
    log (color-coded function/line transitions, stack traces) and `RemoteValue`
    lazy expansion for visual data-structure graphs.
12. **CPU Profiler** — drive V8 inspector profiling in the runner
    (`profileStart`/`profileStop`); flamegraph webview; map frames back through
    the source map.
13. **Snaps** — run snippets inside Vue/Svelte SFCs: extract the `<script>`
    block, offset-shift positions into the instrumentation pass.
14. **Quick Package Install + config** — install npm packages from the editor;
    `.quoll` config (env vars, runtime version, jsdom toggle, tsconfig paths).
15. **Sharing (Codeclip-style)** — export a run recording (source + event log +
    retained previews) as a file or gist; hosted service out of scope.

Phases 0–3 ≈ a weekend. Phase 4 onward is where "production-grade" is earned.
Phases 8–11 and 15 are deliberately cheap because the protocol pre-paid for them
(`kind`, `extraSites`, `runId`/`seq` event log).

## Stack notes (mid-2026 — verify current versions)

- **Oxc:** `oxc_parser` / `oxc_transformer` / `oxc_codegen` + the
  `oxc_coverage_instrument` crate (Istanbul-compatible; has source-map remapping
  and V8→Istanbul conversion — its Istanbul model already includes the branch
  counters phase 4's partial coverage needs). Open limitation: the parser can't
  consume an input source map — the reason for the single-pass design. Verify
  Oxc preserves/exposes comments well enough to extract `//?` annotations
  (needed by phase 8) when evaluating the crate.
- **tree-sitter:** actively maintained (0.26.x) but **not** used for the core —
  it's an incremental *parser* with no transform/codegen+source-map path. Optional
  only for editor-side expression-boundary detection. Skip for v1.
- **Deno 2.x** for the runner sandbox. **napi-rs** for the Rust↔Node boundary.
- **jsdom under Deno is unproven for this use** (Quokka runs jsdom under Node).
  Deno's npm compat should cover it, but sanity-check before phase 7 — this is
  the main reason the IPC layer stays runtime-agnostic so a Node runner can be
  swapped in if needed.

## First task for the agent

Lay down the frozen interfaces above (napi signature, `HostMsg`/`RunnerMsg`,
`RemoteValue`), scaffold phases 0–2, then build the golden-eval harness before
touching phase 4. Treat the source-map mapping and the serialization protocol as
the two highest-risk seams.
