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

## Scope (v1)

- **VS Code only** — no WebStorm/Sublime/JetBrains abstraction layer (this is the
  deliberate simplification vs. real Quokka; collapses the host layer to one
  decoration API).
- JS + TS + JSX/TSX. **Node target first**; browser/jsdom support deferred.
- Features: inline runtime values, coverage gutter, value explorer, inline errors.

## Architecture

Five components. Define the interfaces between them BEFORE writing component code.

1. **Extension host (TypeScript)** — activation, debounced re-run on edit, inline
   value decorations (`DecorationRenderOptions.after`), coverage gutter
   decorations, a value-explorer `TreeDataProvider`, and orchestration of the
   runner. The extension shell stays TS because the VS Code host is Node-based.

2. **Instrumentation core (Rust / Oxc)** — a **single pass**: parse TS/JSX →
   strip types/JSX **and** inject value-capture (plus coverage counters) in one
   `Traverse` → `oxc_codegen` with **one** source map. Shipped to the extension
   via **napi-rs** (fallback: WASM).

3. **Runner / sandbox (Deno)** — executes the instrumented code in a
   permission-locked subprocess (`--deny-net`, `--deny-read`, etc.), captures
   console output, captured values, errors, and timings, and reports over IPC.
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
- **Deno for the sandbox** — its permission model directly solves "run arbitrary
  code on every keystroke."
- **Rust core via napi for perf**; WASM only if you want one portable artifact.

## The hard parts (spend review time here — this is where AI output looks right but is subtly wrong)

1. **Source-map line/column accuracy** after instrumentation.
2. **Value capture + serialization** — the coverage crate *counts*; it does not
   *snapshot values*. You build this.
3. **Async / run-completion semantics** — micro/macrotask flushing; when is a run
   "done"; showing values that resolve later.
4. **Cancellation + debounce** of in-flight runs on the next keystroke.

## Frozen interfaces (write these first)

```ts
// napi boundary
instrument(source: string, opts: InstrumentOpts): {
  code: string;
  map: RawSourceMap;
  sites: CaptureSite[]; // siteId -> source position
}

// IPC: newline-delimited JSON, runner -> host
type Msg =
  | { t: "log";   siteId: number; value: RemoteValue }
  | { t: "value"; siteId: number; value: RemoteValue }
  | { t: "error"; message: string; stack?: string; siteId?: number }
  | { t: "cover"; siteId: number; hits: number }
  | { t: "done";  durationMs: number };

// serialization
type RemoteValue = {
  type: "string" | "number" | "boolean" | "object" | "array" | "function" | ...;
  preview: string;       // truncated, display-ready
  objectId?: string;     // present if lazily expandable
};
// host -> runner: expand(objectId) -> { entries: { key: string; value: RemoteValue }[] }
```

## Phased roadmap (each phase is a checkpoint)

0. **Scaffold** — `yo code`, esbuild bundling, activate on a scratch file.
1. **Run + capture** — run file in subprocess, capture `console.log` → output
   channel. *(Proves the loop.)*
2. **Inline decorations** — render values as `after` decorations; debounced re-run.
3. **Transpile + source map** — single-pass Oxc; map instrumented line → source line.
4. **Value capture + coverage** — AST instrumentation emitting capture calls;
   coverage gutter. **Build the golden-eval harness before starting this phase.**
5. **Serialization + value explorer** — protocol + tree view with lazy expansion.
6. **Async + project imports** — run-completion semantics; module resolution
   (ESM/CJS, tsconfig paths, node_modules).
7. **Hardening** — large/circular values, cancellation, perf, settings, jsdom.

Phases 0–3 ≈ a weekend. Phase 4 onward is where "production-grade" is earned.

## Stack notes (mid-2026 — verify current versions)

- **Oxc:** `oxc_parser` / `oxc_transformer` / `oxc_codegen` + the
  `oxc_coverage_instrument` crate (Istanbul-compatible; has source-map remapping
  and V8→Istanbul conversion). Open limitation: the parser can't consume an input
  source map — the reason for the single-pass design.
- **tree-sitter:** actively maintained (0.26.x) but **not** used for the core —
  it's an incremental *parser* with no transform/codegen+source-map path. Optional
  only for editor-side expression-boundary detection. Skip for v1.
- **Deno 2.x** for the runner sandbox. **napi-rs** for the Rust↔Node boundary.

## First task for the agent

Lay down the frozen interfaces above (napi signature, IPC `Msg` type,
`RemoteValue`), scaffold phases 0–2, then build the golden-eval harness before
touching phase 4. Treat the source-map mapping and the serialization protocol as
the two highest-risk seams.