# Contributing to Quoll

Thanks for your interest in contributing! Bug reports, feature requests, and PRs
are all welcome. This document covers how the codebase is organized and how to
get a change landed. For the product overview and the phased roadmap, see the
[README](README.md) and [`quoll-spec.md`](quoll-spec.md).

## Development setup

Prerequisites and the build steps live in the README's
[Getting started](README.md#getting-started-from-source) section. In short:

```sh
pnpm install
pnpm run build:core   # native Rust instrumentation core
pnpm run build        # bundle the extension host
```

Press **F5** in VS Code to launch the extension development host.

## Architecture: three process boundaries

Quoll is three programs, and most organizing decisions follow from that. Keep
the boundaries in mind when deciding where code belongs:

| Boundary | Lives in | Runs as | Notes |
| --- | --- | --- | --- |
| **Extension host** | `src/` | VS Code extension (bundled by esbuild) | The only code with access to the `vscode` API. |
| **Runner sandbox** | `runner/` | A separate, permission-locked Deno process | Staged to a temp dir by `src/runner/stage.ts`; executes instrumented user code. |
| **Instrumentation core** | `crates/quoll-core/` | Rust `cdylib`, loaded by the host | Parses, type-strips, and instruments in one pass (Oxc). |

`protocol/` holds the **frozen contracts** (NDJSON message types, `RemoteValue`,
instrument options) shared across these boundaries. Treat changes there as
breaking — open an issue first.

> **`protocol/` is type-only across the boundary.** The runner imports from
> `protocol/` with `import type` exclusively (see the note in
> `runner/main.ts`). `protocol/` is *not* shipped or staged into the runner, so
> only erasable types cross — never runtime values. Adding a shared runtime
> value to the runner means adding it to the staging list in
> `src/runner/stage.ts`, not just importing it.

## Where things live

The codebase is organized by feature, and shared identifiers follow a
**one-source-of-truth-per-boundary** rule.

- **VS Code contribution IDs** (command/view/`contextValue` ids, the extension
  id, the output channel name) live in `src/constants.ts`. These mirror
  `package.json` `contributes` — change both together. Don't hard-code these
  strings anywhere else in `src/`.
- **Configuration** is read through the typed accessors in
  `src/configuration.ts`, which declare each default once. Don't call
  `vscode.workspace.getConfiguration("quoll")` directly or re-spell a default
  that already lives in `package.json`.
- **Module-local constants and single-use regexes** stay co-located with the
  code that uses them (e.g. `MAX_VALUES` in `render/aggregate.ts`, `SPECIFIER`
  in `instrument/resolve.ts`). Do **not** hoist these into a global file —
  locality is the point.

### A note on deliberate duplication

The surrogate-pair-safe `truncate()` helper appears in both
`src/render/decorations.ts` and `runner/serialize.ts`. This duplication is
**intentional**: the two run in different processes, and (per the `protocol/`
note above) a shared runtime module would have to be staged into the runner for
marginal benefit. If you touch one, check the other — but don't try to "DRY"
them into a shared import without addressing staging.

## Verify gate

A change should pass the same checks CI runs (`.github/workflows/ci.yml`):

```sh
pnpm run fmt:check    # oxfmt (JS/TS) + cargo fmt --check (Rust)
pnpm run lint         # oxlint (JS/TS), fails on any warning
pnpm run lint:rust    # cargo clippy (Rust), fails on any warning
pnpm run build:core   # native instrumentation core
pnpm run typecheck    # tsc --noEmit
pnpm run build        # esbuild bundle
pnpm run eval         # golden-eval harness
```

`pnpm run fmt` auto-formats if `fmt:check` fails; `pnpm run lint:fix` applies
oxlint's safe autofixes.

A **pre-commit hook** runs the fast subset (lint + format, gated on the file
types you staged) before each commit. It's installed automatically on
`pnpm install` via the `prepare` script (`git config core.hooksPath .githooks`),
so there's nothing to set up. Bypass a single commit with `git commit
--no-verify`. The heavier gates (clippy, typecheck, eval) stay in CI.

## Pull requests

- **New pipeline behavior** (anything in instrument → run → render) should come
  with a golden-eval case in `eval/cases/`.
- **Update [`CHANGELOG.md`](CHANGELOG.md)** for user-visible changes.
- Keep PRs scoped to one concern. If you're unsure where to start, open an issue
  and ask.

Commit message style is intentionally unopinionated for now (conventional
commits may be adopted as the project grows). Clear, imperative summaries are
all that's expected.
