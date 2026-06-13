# Decisions

Running decision journal for Quoll — append-only, newest first.

This is the *during-the-build* companion to `quoll-spec.md`. The spec holds the
upfront design and frozen interfaces; this file records the non-trivial calls
made *while building*, including the alternatives rejected and the condition
that would make us reverse them. The rule for every entry:

- **Context** — what forced the decision.
- **Decision** — what we chose.
- **Rejected** — the alternatives and why they lost.
- **Revisit if** — the tripwire. If we can't name one, it's a guess, not a decision (and that's fine — label it).

When a decision has observable behavior, encode it as a golden-eval case so a
future regression fails a test, not just memory.

---

## 2026-06-12 — Import rewriting moved from regex to the Oxc AST pass [RESOLVED]

- **Context:** the Phase 6 v1 specifier rewrite was a regex over the generated
  code (`resolve.ts` SPECIFIER). Its acknowledged false-positive wasn't just
  cosmetic: a user string literal containing an import-shaped substring (e.g.
  `const s = 'import "./x" …'`) would be REWRITTEN, changing the program's
  runtime-observable values — a truth violation, not a style nit.
- **Decision:** specifier *finding* moves into the existing Rust pass. New napi
  surface: `listImports(source, filename, jsx)` (parse-only module-request
  listing) and an optional `rewrites: Record<specifier, replacement>` on
  `instrument()`, applied to the AST's import positions (static import/export
  sources + string-literal dynamic imports) before the single codegen. The host
  resolves requests between the two calls (`resolveRequests`); *resolution*
  stays in shared TS (`resolve.ts`) so the eval harness keeps testing the real
  logic and node_modules/tsconfig-paths can plug into the same seam.
- **Cost accepted:** two native parses per run (list + instrument). Parsing is
  the cheap part of the pass; revisit under Phase 8 perf work with caching if
  it ever shows up.
- **Rejected:**
  - *Span-based rewrite in TS* — parse spans are source positions, but the
    rewrite must land in the generated code; tracking spans through
    transform+codegen is exactly the complexity the single-pass design avoids.
  - *Keeping the regex* — it corrupts user strings (golden traps now in
    `eval/cases/imports.ts`). It survives only as the identity-fallback tier
    (no native binary), where there is no parser to use.
- **Golden cases:** `imports.ts` traps — an import-lookalike string and a
  string whose entire value is a resolvable specifier; both must render
  verbatim. Verified the old regex tier false-matches the first.
- **Revisit if:** the fallback tier's regex bites someone (then consider
  wasm/JS oxc parsing for fallback), or perf profiling flags the double parse.

## 2026-06-12 — Guiding principle: truthful/informative output over cosmetic Quokka parity [PRINCIPLE]

- **Context:** a run of Quokka-vs-Quoll comparisons kept landing the same way —
  always-on values (kept), `λ` (dropped for `[Function …]`), iterator verbosity
  (kept `Set Iterator { … }` over Quokka's `Iterator {}`), `n/a` (rejected for
  `Promise { <pending> }`). They share one rule.
- **Principle:** render the runtime's TRUTHFUL, informative output; diverge from
  raw Deno only when it adds genuine SEMANTIC value (promise settlement →
  `then`/`catch`), never for mere cosmetic parity. Reframes the parity matrix
  from "match Quokka pixel-for-pixel" to "match Quokka's CAPABILITIES, in Quoll's
  honest idiom."
- **Why (taste AND architecture):** a value inspector earns trust by being
  literal; and cosmetic rewrites are inherently `if (looksLikeX) return
  customString` special-cases in `previewOf` that don't generalize — stacking
  them is a maintenance smell, and each one moves away from the real runtime shape.
- **Resolves — all SKIP, keep Quoll's output:** gap 3 (preview compactness),
  gap 4 (iterator verbosity — Quoll's `Set Iterator { … }` differentiates Set vs
  Array and shows contents: `screenshots/quoll-quokka-iterator-type.png`), gap-1
  `n/a` idiom (`Promise { <pending> }` is conventional/correct), gap 5 `λ`.
- **Revisit if:** a specific cosmetic rewrite earns its keep on SEMANTIC grounds
  (the way `then`/`catch` did), or we add an opt-in "Quokka-compatible previews"
  mode.

## 2026-06-12 — Known limitation: multi-promise-per-site settlement mis-slots [KNOWN LIMITATION]

- **Context:** settlement re-emits replace the site's *last* value, identified
  only by `siteId` (`session.ts` / `aggregate.ts` `update` handling). If ONE
  capture site produces several pending promises — e.g. `for (const u of urls)
  fetch(u)` — that settle out of order, a settled value can land on the wrong
  slot. The common case (one promise per site, `const p = …`) is correct.
- **Decision: document, don't fix yet.** It's a genuine correctness bug but
  low-frequency (multiple promises captured at a *single* site).
- **The fix is structural, not an `if`:** it needs a per-capture identity — a
  capture-index emitted alongside `siteId` so the host can match a settlement to
  the exact pending slot. That's a small additive protocol field + runner/host
  threading, not a special-case. Deferred until loop-of-promises capture actually
  matters in practice.
- **Revisit if:** users hit it (out-of-order settled values on a loop that creates
  promises), or we build anything else that needs per-capture identity (then do
  both at once).

## 2026-06-12 — Quoll shows ALL expression values: DEFAULT, not enshrined [CONFIGURABLE]

- **Context:** Quokka only renders an inline value when you opt in — a
  `console.log` or a `//?` live comment. With bare expression statements and no
  logging it shows nothing (`screenshots/quokka-afns-2-without-consolelog.png`:
  `f(3)`/`g(4)`/`h(3)` are silent). Quoll auto-instruments every expression and
  shows its value everywhere (`screenshots/quoll-afns-2.png`).
- **Decision (user, 2026-06-12): always-on is the DEFAULT, but it's a reversible
  RENDER POLICY — not "the one true way."** Always-on wins for scratch files /
  exploration / zero-friction (Quoll's differentiator). Opt-in (Quokka's model)
  wins for large real files — more signal, less noise, less capture overhead —
  and gives the developer control. Both are valid; which is "better DX" is
  context-dependent (an earlier "always-on is obviously better" was an
  overstatement). The capture-site `kind` already separates auto (`expr`) from
  opt-in (`comment`/`//?`), so a "quiet / `//?`-only" mode is a render-time
  FILTER, not a re-architecture — build it as a setting alongside `//?` (phase 8).
- **Will it bite us? Only if enshrined.** Risks of a *fixed* always-on default:
  (1) noise on large files, (2) capture/serialize overhead on every expression,
  (3) default lock-in (changing it later is a UX break). All mitigated by keeping
  it configurable from the start — so ship always-on as the default, but treat
  the opt-in toggle as a near-term companion, not a someday-maybe.
- **Considered & dropped — `λ` function previews:** briefly rendered functions
  as `λ` / `λ <name>` (Quokka idiom), then reverted. For a value inspector,
  truthful > cute: keep Deno's literal `[Function (anonymous)]` / `[Function:
  name]`, which reflects the real runtime shape. (Note: `λ` is plain Unicode
  U+03BB — NO Nerd-Font/ligature setup needed — so it's a viable *opt-in*
  cosmetic later, just not the default.)
- **Revisit if:** always-on gets noisy on large files — a future opt-DOWN "quiet /
  `//?`-only" mode is cheap (capture sites already carry a `kind`).

## 2026-06-12 — Eval harness must test real code, not a replica [RESOLVED]

- **Context:** the harness gave a false green — `async_settle` passed (`//=> 42`)
  while the editor actually rendered the noisy `Promise { <pending> }, then 42`.
  Two root causes: (1) assertions were substring-CONTAINMENT (`got.includes`), so
  surplus/noise was invisible; (2) `eval/run.mjs` *reimplemented* the host's
  attribution + aggregation + coverage rollup, so it tested a replica that could
  drift from the real `session.ts`/`decorations.ts`.
- **Decision (Fix A + Fix B):**
  - **A — exact match.** Added a `//== <text>` operator asserting the line's value
    decoration EQUALS exactly (kept `//=>` contains for the cases that need it).
    Pinned `async_settle` to `then 42`; it immediately caught that the `braceless`
    loop truly renders `0, 0, 1` (the old `//=> 1` hid it).
  - **B — kill the replica.** Extracted attribution/aggregation/coverage into one
    vscode-free `src/render/aggregate.ts` (`Aggregator`) consumed by BOTH the live
    host and the harness. Renderer slimmed to decoration plumbing; harness now
    exercises the exact editor logic. Hardened the annotation parser to ignore
    `//==`/`//=>` in prose comments.
- **Rejected:** keeping containment-only (can't catch noise); host-only inference
  for promise-replace (brittle at a line-keyed renderer); leaving the replica
  (the thing that masked the bug).
- **Constraint discovered:** the shared module must be pure-erasure TS — NO
  constructor parameter properties — because the node harness type-strips it.
- **Revisit if:** a future feature needs render state the `Aggregator` doesn't
  model; extend the one module (both consumers update together by construction).

## 2026-06-12 — Reference comparison: Quokka vs Quoll (open gaps, not yet decided)

First live comparison of Quoll's output against Quokka on the same source
(answers the long-standing `LOG.md` TODO "check if quokka output is similar").
Screenshots live in `screenshots/`. These are **observed gaps that imply
pending decisions** — recorded here so the reasoning survives the session. Each
maps to an existing `LOG.md` open question and to *hard part #3* in the spec
(async / run-completion semantics).

Good news for the north star ("no later parity feature requires a breaking
protocol change"): every gap below is fixable *within* the frozen protocol —
the `value` message is already specced to re-emit on the same `siteId` when a
Promise settles late, with `done` vs `exit` and `asyncGraceMs` bracketing the
async window. So these are runner/serialization + host-rendering work, not
protocol changes. That's a real validation of the upfront design.

**Gap 1 — Settled-Promise rendering. [FIXED 2026-06-12]**
- Quokka renders settlement *semantically*: `resolve(45)` → `p  then 45`;
  `reject('error')` → `p  catch 'error'`; an executor that throws synchronously
  (`setTimeout()` with no callback) → `p  catch 'TypeError [ERR_INVALID_ARG_TYPE]…'`.
  (`screenshots/Screenshot 2026-06-12 at 10.28.21 AM.png`, `…10.28.42 AM.png`,
  `…10.29.55 AM.png`.)
- Quoll currently shows the *pending wrapper* and never patches it:
  `p  Promise { <pending> }` (`screenshots/quoll-promises-1.png`,
  `quoll-promises-2.png`). It captures the value synchronously and doesn't track
  settlement.
- **Implemented:** `__quoll.log` now tracks a captured promise's settlement
  (`runner/main.ts`) and re-emits `value` on the same `siteId` via
  `settledPromiseValue` (`runner/serialize.ts`) using Quokka's `then <v>` /
  `catch <e>` idiom; the resolved value is registered so it stays expandable.
  Attaching `.then` marks the captured promise handled, so Quoll reports its
  settled state inline and the global `unhandledrejection` trap now covers only
  *uncaptured* promises (a deliberate behavior shift — captured rejections render
  as `catch <e>` instead of a red error event).
- **Verified by `eval/cases/async_settle.ts`** — was red (`Promise { <pending> }`),
  now green (`then 42`); `await p` on the next line still passes. Plus 2 unit
  tests in `runner/serialize_test.ts`.
- **Decided SKIP (2026-06-12):** the `n/a` idiom for never-settling promises is a
  Quokka-ism — `Promise { <pending> }` is the conventional, correct form. Keep it
  (truthful-over-cosmetic principle).
- **Known limitation:** out-of-order settlement of multiple promises captured at
  ONE site can mis-slot — see the standalone "multi-promise-per-site" entry above.

**Gap 2 — Async wait budget. [DIRECTION SET]**
- Quokka waited the **full 10 s** for `setTimeout(() => resolve(42), 10000)` then
  showed `p  then 42` (`screenshots/Screenshot 2026-06-12 at 10.30.48 AM.png`),
  and likewise at 4 s (`screenshots/quokka-live-comment-promises.png`). Quoll
  gave up and showed `Promise { <pending> }` at both 4 s and 10 s
  (`screenshots/quoll-promises-2.png`, `quoll-promises-3.png`).
- **User confirmed (2026-06-12): Quokka deliberately waits** for outstanding
  timers — so this is NOT an open responsiveness-vs-latency tradeoff. Quokka
  chose to wait; we match it. Keystroke responsiveness is already protected by
  `runId` cancellation (the next edit kills the in-flight run), so a long wait
  costs nothing the user sees.
- Decision: **wait for outstanding timers/promises, bounded by the run timeout**,
  re-emitting `value` on settlement. Quoll currently doesn't wait → this is a
  bug to fix, not a design question. The spec's `asyncGraceMs` *quiet-window*
  framing is the wrong model; the right model is "stay alive while timers/promises
  are still pending, up to the run-timeout ceiling."

**Gap 3 — Preview of host-internal objects (NOT a clean divergence).**
- Originally logged as "Quoll leaks `Timeout` internals, Quokka doesn't." The new
  `screenshots/quokka-live-comment-promises.png` shows **Quokka also dumps the
  `Timeout` object** (`{ _idleTimeout: 4000, _idlePrev: [TimersList], … Symbol(triggerId): 2,
  Symbol(kAsyncContextFrame): undefined }`) when that expression is captured. So
  both leak runtime guts.
- The remaining real differences are narrower: (a) Quokka's preview is more
  compact and surfaces symbol keys with a `…` truncation; (b) Quokka appears to
  auto-capture *fewer* lines by default (the dump only appeared under an explicit
  `//?`), whereas Quoll captures the `setTimeout(...)` return everywhere.
- **Decided SKIP (2026-06-12):** cosmetic / density only — keep Deno's truthful
  preview (truthful-over-cosmetic principle). The "auto-render vs on-request"
  sub-question is settled separately by the always-on entry (default-on,
  configurable).

**Gap 4 — Preview verbosity. [DECIDED SKIP 2026-06-12]**
- Iterator: Quoll → `Set Iterator { [Function: f], … }`; Quokka → `Iterator {}`
  (`screenshots/quoll-quokka-iterator-type.png`). Quoll's is MORE informative — it
  differentiates Set vs Array iterators and shows contents. Keep it
  (truthful-over-cosmetic principle); not a gap, a feature.

**Gap 5 — Function naming.**
- Quoll keeps Deno's truthful `[Function (anonymous)]` / `[Function: name]`
  previews (the `λ` idiom was tried and dropped — see the always-on entry
  above). Minor remaining quirk: `setTimeout` loses its name under Deno
  (`[Function (anonymous)]`, not `[Function: setTimeout]`) — a runtime quirk,
  low priority.

(`image.png` was moved into `screenshots/`; new shots added 2026-06-12:
`quoll-promises-3.png`, `quokka-live-comment-promises.png`, `quoll-fn-1.png`,
`quoll-fn-2.png`.)

---

## 2026-06-12 — Evolving values render as append-history, not replace-in-place [RESOLVED → Option B]

- **Context:** after the gap-1 fix, a settling promise emits two `value`
  messages on one siteId (pending → settled). The inline renderer
  (`src/render/decorations.ts:92-98`) keys previews **by line** and joins the
  list with `", "`, so the line shows `Promise { <pending> }, then 42`
  (`screenshots/quoll-promises-4-after-timeout.png`). Quokka shows only the
  final `then 42`. User: "okay with that … can be considered noisy."
- **Why it happens:** the host treats every `value` at a site as a distinct
  capture to append. That's correct for a LOOP (distinct values, shown with a
  count) but wrong for a single value that EVOLVES (pending → settled).
- **Pending decision — how to tell "evolve" from "iterate":**
  - **Option A (host-only inference, no protocol change):** when a `value`
    arrives whose `type === "promise"` and the site's prior value was also a
    promise, replace instead of append. Cheap; brittle at the line-keyed
    renderer (multiple sites can share a line, so "replace the last preview"
    isn't always the right one).
  - **Option B (protocol `update?: true` on the `value` message):** the runner
    marks the settlement re-emit as an update; the host replaces the prior value
    for that siteId. Cleanest semantics — the spec already calls this a
    re-emission "with the same siteId" — but it's an additive change to a FROZEN
    interface, so it needs explicit sign-off (like the phase-5 amendments).
  - **Option C (session as source of truth):** renderer stops appending; session
    derives each line's previews from `siteValues` (per-site latest) and pushes
    the whole set. Bigger refactor; also cleans up the existing
    session/renderer duplication and naturally handles loops (latest or ×K).
- **Decision (user, 2026-06-12): Option B.** Added `update?: true` to the `value`
  message (`protocol/ipc.ts` + mirrored in `quoll-spec.md` frozen interface — an
  additive, non-breaking amendment). The runner sets it on the settlement re-emit
  (`runner/main.ts`); the host replaces the site's prior value instead of
  appending. To make "replace" exact, the renderer (`src/render/decorations.ts`)
  now keys value previews by **siteId** (was line) with a separate line-keyed
  bucket for console output, and `session.ts` routes updates to `updateSiteValue`.
  Result: the line shows `then 42`, not `Promise { <pending> }, then 42`.
- **Verified:** full gate green (9/9 eval incl. `async_settle`, 13 deno tests,
  build/typecheck/phase3/phase5). The eval harness was taught the same
  replace-on-`update` rule so it stays a faithful mirror.

## 2026-06-12 — Sandbox model: Deno deny-all; permissions only widen per-phase, always scoped

- **Context:** Quoll executes editor contents **on every keystroke, automatically,
  with no explicit run action** — including code from a freshly-cloned untrusted
  repo the user only opened to read. That auto-execution is the entire threat
  model; a malicious snippet must not be able to touch disk/network/env/processes.
  (Raised directly by a reviewer: "Where are you sandboxing the TS runs?")
- **Decision:** user code runs in a **Deno subprocess with zero permission
  grants** — `deno run --quiet --no-prompt <runner>` (`src/runner/client.ts:37`),
  **no `--allow-*` flags**, so Deno's deny-by-default model blocks filesystem,
  network, env, subprocess, and FFI. `--no-prompt` makes a denied access throw
  immediately instead of hanging on an interactive prompt. User code executes via
  a `data:` URL dynamic import *inside* that locked-down process
  (`runner/main.ts:208`), so it inherits deny-all; its only channel is stdio back
  to the host.
- **Guardrail for future phases:** permissions may only **widen per-phase, and
  always scoped** —
  - Phase 6 (project file imports) needs read access: grant
    `--allow-read=<projectRoot>`, never blanket `--allow-read`.
  - Phase 7 (jsdom / browser-like) changes the threat model again — re-evaluate
    before granting anything network-adjacent.
  - Net access should stay denied unless a feature explicitly demands it, and then
    only host-scoped.
- **Rejected:** running user code in the host/extension process or an
  unsandboxed Node child (no permission boundary — arbitrary fs/net/env access on
  every keystroke); interactive permission prompts (unworkable when re-running on
  each edit).
- **Known non-coverage (NOT solved by the permission sandbox):** Deno permissions
  gate *access*, not *resource use*. CPU/infinite loops are bounded only by the
  run-timeout + `runId` cancellation (the timeout is also the DoS guard); memory
  is not capped (would need OS-level limits, not done today). Track these
  separately from the sandbox.
- **Revisit if:** a phase needs a broader grant (re-scope, don't blanket), or we
  add memory/CPU ceilings. Any widening of permissions is itself a decision that
  belongs in this journal.

## 2026-06-12 — Copy Value copies the preview, not a deep serialization

- **Context:** Value Explorer nodes have a "Copy Value" action. A faithful "copy
  the whole object as JSON" needs another protocol round-trip to deep-serialize.
- **Decision:** v1 Copy copies the existing ≤200-char `preview` string only.
- **Rejected:** eager deep-serialization on every capture (unbounded memory, and
  most copies never happen); a synchronous full walk (can't — values live in the
  runner process behind the IPC boundary).
- **Revisit if:** users hit the truncation in practice. The honest fix is a new
  `expand`-style deep-copy round-trip — a natural **Phase 7** item. Tracked as a
  known limitation, not a bug.

## 2026-06-12 — `objectId` lifetime: runner lingers after `exit` (keep-alive)

- **Context:** the Value Explorer expands an `objectId` lazily *after* a run
  finishes, but `exit` was specced as terminal and the original frozen rule tied
  `objectId` validity to the runner process — which used to die on `exit`.
- **Decision:** `exit` now seals the **event log only**. The runner **process
  stays alive** to serve `expand` against its object registry until the host
  kills it — which already happens on the next keystroke-run or `quoll.stop`.
  Spec's `RemoteValue` lifetime note and the `exit` doc-comment updated to match.
- **Rejected:** (a) re-run the file to re-capture on expand — loses object
  identity across edits and re-runs user code on a click; (b) eagerly serialize
  whole objects at capture time — unbounded memory on hot loops.
- **Tradeoff accepted:** a lingering Deno process per session. Mitigation: the
  host already kills it on the next run / stop; harnesses (eval, phase-3/5
  checks) were taught to kill it so nothing hangs on process-close.
- **Revisit if:** lingering runners cause orphan-process / resource pain, or
  expand latency ever matters more than the memory saved. See `LOG.md`.

## 2026-06-12 — `expandResult` gains `error?: "evicted" | "unknown"`

- **Context:** the spec always mandated an eviction error on `expand` (the
  registry uses LRU eviction at 10 000 objects under a memory budget), but the
  frozen `expandResult` type had no field to express it.
- **Decision:** add optional `error?: "evicted" | "unknown"` to `expandResult`;
  `entries` is empty when `error` is set. `evicted` = id was real but reclaimed
  (recorded preview still renders — Time Machine degrades gracefully); `unknown`
  = id never existed / wrong run.
- **Rejected:** overloading an empty `entries: []` to mean "gone" (can't
  distinguish evicted-but-was-real from never-existed, and both need different
  host messaging — "gone" vs a correlation bug).
- **Revisit if:** we need finer eviction telemetry (e.g. distinguishing
  budget-evicted from explicitly-cleared). Additive, so no breaking change.
