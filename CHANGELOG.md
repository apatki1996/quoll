# Changelog

All notable changes to Quoll are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Added

- **Live comments** — annotate a line with `//?` to mark its value as an
  explicit "show me this" (Phase 8). Pairs with the new `quoll.values` setting:
  set it to `comments` for a quiet mode that shows inline values only on
  `//?` lines, leaving the rest uncluttered.
- **Perf timing** — `//?.` on a line times its execution and renders `⏱ <n>ms`
  inline instead of the value.

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
