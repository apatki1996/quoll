# Security Policy

## Reporting a vulnerability

**Don't open a public issue.** Use GitHub's
[private vulnerability reporting](https://github.com/apatki1996/quoll/security/advisories/new)
to file a confidential advisory. Expect an acknowledgement within a week.

If you'd rather not use GitHub, email <aashwin.patki@gmail.com>.

## Supported versions

Quoll is pre-1.0. Fixes land on `main` and ship in the next release; older
versions aren't patched.

## What's in scope

Quoll executes the file you're editing, so the interesting boundary is the
[runner sandbox](CONTRIBUTING.md#architecture-three-process-boundaries) — a
separate Deno process started with an explicit permission set. In scope:

- **Sandbox escape** — instrumented user code reaching the filesystem, network,
  environment, or subprocesses beyond the permissions the runner was granted.
  Those permissions are deny-all plus, at most, read access scoped to the
  project; `quoll.runtime: "browser"` additionally grants `--allow-env`, and the
  runner is spawned with a scrubbed environment (PATH only) so that grant
  reaches nothing else. Anything readable beyond PATH there is a bug.
- **Host compromise from a workspace** — anything a cloned repo can do to the
  extension host by virtue of being opened (settings, workspace files, `//?`
  comments, module specifiers). `quoll.denoPath` and `quoll.runtime` are
  machine-scoped for this reason: a workspace override that redirects the
  sandbox binary, or that switches on browser mode (widening permissions and
  loading the repo's own jsdom on every run), is a bug.
- **Instrumentation core** — memory safety in `crates/quoll-core/`, or
  instrumented output that changes program semantics in an exploitable way.

## What's not

- Running a file you wrote that does something you told it to do. Quoll runs
  your code; that's the feature.
- Resource exhaustion from a runaway loop in the edited file. The runner is
  time-bounded, but a hot loop burning its budget is expected behavior.
- Findings against dependencies with no demonstrated path through Quoll —
  those belong upstream.
