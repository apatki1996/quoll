# Changelog

All notable changes to Quoll are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Added

- **Value peek** — hover any expression to see the value it produced, with each
  capture listed for a line that ran more than once. Reads the current run's
  values (no re-run), works in quiet mode, and offers *Explore value* to reveal
  that expression in the Quoll Values tree.
- **Full text on truncated inline values** — an inline decoration clipped at 120
  characters now carries the untruncated text as a hover instead of dropping it.
- **`quoll.runTimeoutMs`** — how long a run keeps waiting for outstanding
  timers and promises to settle (default 10s, was a hard-coded 5s). Quoll stays
  alive while they're pending, so a slow `setTimeout` now reports its value
  instead of leaving `Promise { <pending> }` on the line; the setting is the
  ceiling that stops a never-quiet run.
- **Live comments** — annotate a line with `//?` to mark its value as an
  explicit "show me this" (Phase 8). Pairs with the new `quoll.values` setting:
  set it to `comments` for a quiet mode that shows inline values only on
  `//?` lines, leaving the rest uncluttered.
- **Perf timing** — `//?.` on a line times its execution and renders `⏱ <n>ms`
  inline instead of the value.
- **Value on selection** — selecting an expression reveals its value inline
  (Phase 8). The selection anchors the innermost capture containing it, so
  selecting `x * 2` inside `xs.map(x => x * 2)` shows the element values rather
  than the resulting array; selecting a variable's name reveals its line.
- **Logpoints** — a VS Code breakpoint set in a Quoll file opts that line in the
  same way `//?` does, with no debugger session involved (Phase 9).
- **Browser runtime** — `quoll.runtime: "browser"` installs a jsdom window's
  globals (`document`, `Element`, `localStorage`, …) before your code runs, so
  DOM code works in a scratchpad (Phase 7). jsdom is resolved from the
  project's `node_modules` (`npm i -D jsdom`); the default stays `node`. This
  is the only mode that grants the sandbox `--allow-env`, and it spawns the
  runner with an empty environment so the grant hands out nothing.

  Both reveal-on-demand features apply to quiet mode (`quoll.values: comments`),
  which is where opting a line in means anything — the `all` default already
  renders every expression.

## [0.0.1] - 2026-06-13

Initial development release: single-file JS/TS scratchpads that run as you type.

### Added

- **Inline values** — expression results and variable values render next to the
  code that produced them.
- **Live code coverage** — gutter indicators mark lines as covered, uncovered,
  or partially run.
- **Inline runtime errors** — exceptions and unhandled rejections surface on the
  line that threw.
- **Inline `console.log`** — log output renders at the call site.
- **TypeScript out of the box** — no build step or config; types are stripped in
  the instrumentation pass.
- **Sandboxed execution** — code runs in a permission-locked Deno process with no
  file system or network access.
- **Quoll Values** explorer view for inspecting captured values.
- Commands: `Quoll: Start on Current File`, `Quoll: Stop Session`, and
  `Copy Value`.
- Settings: `quoll.denoPath` (runner executable) and `quoll.debounceMs`
  (re-run delay after the last edit).
- Relative and bare-specifier project imports, with auto re-run when an imported
  file changes (transitive watch graph).

### Internal

- Rust/[Oxc](https://oxc.rs) core that parses, type-strips, and instruments in a
  single pass with one source map.
- Deno runner streaming values, coverage, and errors over an NDJSON protocol.
- Golden-eval harness (`pnpm run eval`) exercising the real
  instrument → run → render pipeline.

[Unreleased]: https://github.com/apatki/quoll/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/apatki/quoll/releases/tag/v0.0.1
