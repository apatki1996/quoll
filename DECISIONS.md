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

Entries that compare Quoll against Quokka cite files under `screenshots/`. That
directory is deliberately **not tracked** (the captures include personal
context), so those references are the maintainer's local evidence only — each
entry states what the screenshot showed, so the reasoning stands without it.

---

## 2026-09-25 — Quoll's views belong in the Panel, not the Side Bar [DECIDED]

- **Context:** Values and the new Timeline were contributed to the `explorer`
  container, so they sat in the primary side bar under the file tree. Checked
  against Quokka, whose own docs are the reference: its entire UI is a **QUOKKA
  tab in the bottom panel**, split LOGS | QUOKKA SCRATCH, with the Time Machine
  and value graphs reached from that pane's toolbar
  (`screenshots/quokka/frame-main.png`, from the Quokka v2 announcement).
- **Decision:** One `quollPanel` viewsContainer in `contributes.viewsContainers.panel`,
  holding both views, which are renamed `Values` and `Timeline` (the container
  is already called Quoll). Nothing stays in `explorer`.
  - The panel is where a run's *output* goes in VS Code's own model — Problems,
    Output, Terminal, Debug Console are all there, and Quoll's values are the
    same kind of thing. See the VS Code UI docs on Panel vs Primary Side Bar.
  - It is also the shape the content wants: value previews and Timeline rows
    are wide and short, so horizontal room helps and side-bar width hurts. And
    it stops Quoll competing with the file tree for vertical space in the one
    container a user always has open.
- **Rejected:**
  - *Leaving them in the side bar* — what shipped in phases 5 and 11a, and what
    prompted this; it was never a considered choice, just the `yo code`
    default.
  - *A dedicated activity-bar container* — a third place to look, and the
    activity bar is for navigation surfaces you dwell in, not run output.
  - *Making it configurable* — VS Code already lets a user drag a view
    anywhere; a setting would just be a second, worse way to do that.
- **Revisit if:** the Timeline grows the horizontal strip + step view Quokka
  has (`screenshots/quokka/ttd-interactive-timeline.png`), which may want more
  height than a panel comfortably gives.
- **Covered by:** a manifest assertion in `src/test/extension.test.ts` —
  placement is a manifest-only fact, so focusing a view can't test it.

---

## 2026-09-20 — Phase 11a Timeline: one tape, two front ends [DECIDED]

- **Context:** Phase 11 is "Interactive Timeline + Value Graphs — webview
  consuming the same event log (color-coded function/line transitions, stack
  traces) and `RemoteValue` lazy expansion for visual data-structure graphs."
  The spec calls the phase cheap because the protocol pre-paid for it. Checking
  that before building: the tape phase 10 records carries `t`, `siteId`, `ts`
  and `seq`, which is everything a LINE-level timeline needs. It carries
  nothing about functions. `crates/quoll-core/src/instrument.rs` instruments
  statements, branches and expressions — there is no function-entry site — and
  the runner keeps no call stack. So the "cheap" claim holds for two thirds of
  the phase and not for the third that mentions functions.
- **Decision:** Ship the timeline over the existing tape, and only that.
  `timelineRows()` (pure, in `aggregate.ts` beside `stepIndices`) turns the tape
  into one row per Time Machine stop; `src/timeline/view.ts` renders them in a
  webview view next to the value explorer. Row `i` IS stop `i`, so a click is
  `stepTo(i)` and the whole editor rewinds with it — the Timeline and the Time
  Machine are one mechanism with two front ends, not two recordings.
  - A webview, not a TreeView: a timeline earns its place by showing the SHAPE
    of a run (kind, line, offset in time). A tree of the same events sorted by
    time would be the value explorer with a different comparator.
  - The page is inline HTML under a nonce CSP with `localResourceRoots: []` —
    it reads no files, loads nothing, and builds every row with `textContent`.
    A captured value is user data that reaches this page as text; it must never
    reach it as markup.
  - One command (`quoll.goToStop`) does both halves of a click, step and
    reveal, so the webview's click and a test's `executeCommand` take the same
    path. It returns whether it landed, because a webview can hold an index
    from a run that no longer exists.
- **Rejected:**
  - *Function transitions and stack traces now* — they need a `function`
    capture kind in the Rust pass plus a runner-side stack. That is core work
    with a protocol addition, not the frontend work this phase was budgeted as.
    Deferred deliberately; see below.
  - *Value graphs in the same change* — a second, independent feature (graph
    layout over the existing `expand` round-trip). It needs no new capture
    data, so it can land on its own without blocking or being blocked.
  - *A second recording for the timeline* — the failure mode phase 10 was
    designed against. The timeline reads the tape or it does not exist.
  - *Bundling a graph/chart library* — a row is a flexbox with four spans.
- **Revisit if:** a run's rows outgrow what a sidebar list can show (then it
  wants the horizontal strip Quokka has, and a real layout pass), or the
  function dimension gets built — that changes what a "stop" means and the row
  model with it.
- **Still open (phase 11's other halves):** function/line transition colouring
  and stack traces (needs the core change above), and Interactive Value Graphs.
  `quoll-spec.md` records both as remaining.
- **Covered by:** `timelineRows` unit tests in `src/render/aggregate_test.ts`
  (dense stop indices, cover excluded, elapsed time from the run's first event,
  an unattributable console line kept rather than dropped) and an integration
  test in `src/test/extension.test.ts` that jumps to a stop through the real
  command and reads the rewound state back through the hover.

---

## 2026-09-20 — Phase 10 Time Machine: replay a log prefix, don't snapshot [DECIDED]

- **Context:** Phase 10 in `quoll-spec.md` — step forward/back through a
  finished run. The protocol pre-paid for it: every runner message already
  carries `seq`, and the `Aggregator` is already a pure fold over that stream
  with no vscode in it.
- **Decision:** The session records each run's Aggregator-folded events into an
  in-memory tape (`done`/`exit`/`expandResult` fold to nothing, so they aren't
  recorded). A step builds a SECOND `Aggregator` over this run's sites and
  folds `log[0..stop]` into it — the same class, same rules as live — then
  paints that snapshot. Live painting is frozen while stepping; a new run
  resets the tape and resumes live.
  - `stepIndices` (in `aggregate.ts`, next to the fold it belongs to) picks the
    stops: `value` / `console` / `error` / `perf` — the events emitted AS THEY
    HAPPEN, so a prefix of them is a truthful picture of a moment.
  - **Coverage is not stepped.** The runner batches cover totals and flushes
    them once the run is over (`flushCover`, `runner/main.ts`), so every cover
    event sits after the last value in the tape and a prefix of a synchronous
    run contains none of them. Re-deriving the gutter from a prefix would
    therefore paint the whole file red at every stop. Coverage is a fact about
    the whole run rather than about a moment in it, so the live gutter stays
    put while stepping; only values, console and errors rewind. (Caught in
    review — the first draft claimed cover "replays as part of each prefix",
    which is true of the data structure and false of the actual event order.)
  - Stepping moves the whole editor, not just the inline values: hover and the
    value explorer read the stepped fold through one `current()` accessor.
  - Entering is a palette/status-bar action; `alt+left`/`alt+right`/`escape`
    are bound only under the `quoll.stepping` context key, so the mode shadows
    those keys only while you are in it. It does shadow them: on macOS
    `alt+arrow` is word navigation, and `escape` is VS Code's universal
    dismiss. Accepted because stepping is a mode with a visible status-bar
    indicator and a one-key exit — unlike a global binding, nothing is taken
    from anyone who never enters it.
  - The tape is capped at the FIRST 5000 events. A hot loop outruns any
    stepper, and evicting the head would renumber every stop under the user
    mid-session. When the cap is hit the status bar says so (`3/5000+`, with a
    tooltip), because stepping forward off a truncated tape lands on live
    rather than on the next event — a jump the user would otherwise not see
    coming. The counter also keeps updating while a run is still streaming, so
    a frozen editor in a growing run doesn't read as a hang.
- **Rejected:**
  - *Snapshotting rendered state per step* — two representations of one run
    that can disagree. Replaying the log through the real aggregator means a
    Time Machine frame is wrong only if the live render was wrong too.
  - *Persisting the log to disk* — that's phase 15 (sharing), which needs a
    file format and a retained-preview story anyway. Stepping a run you are
    looking at needs neither.
  - *Stepping per event, including `cover`* — truthful and unusable.
  - *A second `Aggregator` kept incrementally in sync* — a rebuild over ≤5000
    events is microseconds and can't drift.
  - *Stepping the runner itself (re-execute to a point)* — re-running user code
    to show the past is both slow and a side-effect hazard. The log is already
    the record.
- **Revisit if:** a real run hits the 5000-event cap (then window the tape, and
  say so in the status bar), or stepping through a long run feels like it needs
  stops at function boundaries rather than at values — that's phase 11's
  timeline, not a change here.
- **Covered by:** `stepIndices` + prefix-replay unit tests in
  `src/render/aggregate_test.ts` — including a promise that un-settles when you
  step back before it resolved (which is what a fresh aggregator per frame buys
  over an incrementally-updated one), and one that pins the cover ordering
  above so the coverage decision can't be quietly reverted — plus an
  integration test in
  `src/test/extension.test.ts` that steps a real run and reads the rewound
  values back through the hover.

---

## 2026-09-17 — The Rust toolchain is pinned; MSRV is declared separately [DECIDED]

- **Context:** `cargo clippy -- -D warnings` ran on a floating `stable`, so
  every six-week Rust release could fail CI on unchanged code with newly-added
  lints. The oxc 0.144 bump also raised the required rustc, and a checkout with
  an older `stable` failed with an error naming oxc's packages rather than this
  project's requirement — CI never saw it, because
  `dtolnay/rust-toolchain@stable` always installs the newest stable.
- **Decision:** pin the build toolchain in `/rust-toolchain.toml` (currently
  1.98.0 + clippy/rustfmt) and declare `rust-version` on the crate separately.
  They answer different questions: the file is what we build with, the MSRV is
  what the crate needs (1.96.0, the highest among the oxc 0.147 crates). The
  file lives at the repo ROOT because rustup resolves it from the working
  directory and `lint:rust` runs cargo from there with `--manifest-path`. CI
  drops the toolchain action entirely — every cargo call resolves the file
  anyway, so an action step would install a toolchain each invocation then
  overrides. Matches how Deno is already pinned via mise.
- **Rejected:** *naming the version in the CI action as well* (two places to
  bump, one of them ignored); *floating `stable` with clippy warnings
  non-fatal* (the `-D warnings` gate is what makes clippy worth running).
- **Trade-off accepted:** an oxc bump that raises the MSRV past the pin now
  fails CI until the same PR bumps the file. That visibility is the point — it
  turns a contributor's confusing build error into one deliberate line.
- **Revisit if:** the pin drifts far enough behind stable that contributors hit
  it, which is a calendar problem, not a design one.
- **Provenance:** cherry-picked from the parked `claude/merge-dependabot-prs-nofliv`
  branch; the MSRV was 1.95 there and is bumped here to match oxc 0.147.

---

## 2026-09-17 — Phase 7 browser runtime: jsdom from the project, env scrubbed at spawn [DECIDED]

- **Context:** Phase 7's other half. The spec flagged "jsdom under Deno is
  unproven for this use — sanity-check before phase 7", and the sandbox entry
  below warned that this phase "changes the threat model again". Both turned out
  to be the same question: what does jsdom need that deny-all denies?
- **Verified first, decided after:** jsdom 30 loads and works under Deno 2.8 —
  DOM, `querySelector`, `localStorage`, events, `getComputedStyle` — but needs
  **`--allow-env`**, because its `debug` dependency enumerates `process.env` on
  load. Nothing else: no net (jsdom loads no external resources by default), no
  write, no run.
- **Decision:**
  - **Grant `--allow-env`, and spawn the subprocess with a SCRUBBED
    environment** (`env: { PATH }` in `startRun`). The permission boundary and
    the data boundary are different tools; the cheaper one here is the data
    boundary — the grant's blast radius stops depending on what the user
    happens to have exported. `PATH` is the one survivor, because
    `quoll.denoPath` may legitimately be the bare `"deno"` and the exec lookup
    reads the CHILD's environment; dropping it breaks the spawn, not the
    sandbox. So browser-mode user code can read PATH, and with it the home
    directory and installed toolchains — a disclosure, not a channel, since
    net/write/run stay denied. Resolving `denoPath` to an absolute path in the
    host would make the env genuinely empty and is the fix if that ever matters.
  - **`quoll.runtime` is `machine`-scoped, like `quoll.denoPath`.** Browser mode
    widens the sandbox and makes every run load the project's own jsdom before
    the user's file, even a file that imports nothing. Left at the default
    `window` scope, a cloned repo's `.vscode/settings.json` could turn that on
    for someone who opened a file only to read it — the same move `denoPath`'s
    scope exists to prevent. `machine-overridable` does not help; it still
    allows the workspace override. Cost accepted: a DOM project cannot check
    browser mode into its workspace settings, so each user enables it once.
  - **Only browser mode is spawned that way.** Node mode has no env grant, so
    scrubbing there would buy nothing and would change behavior Deno itself
    depends on.
  - **jsdom resolves from the PROJECT's `node_modules`**, through the byonm
    setup phase 6 already built — no new plumbing, no extension-side copy, and
    a project pins the jsdom version it actually tests against. A project
    without it gets one clear error naming the fix, not a pile of
    `ReferenceError: document`.
  - **Mode is `quoll.runtime: "node" | "browser"`, default `node`**, passed to
    the runner as **argv[1]** — same reasoning as the timeout above: the `run`
    message is frozen, and `Deno.args` costs no permission. So Phase 7 also
    lands with no protocol change.
  - **The runner keeps nine globals** instead of taking jsdom's, for two
    different reasons. It OWNS `console` (the capture channel) and the four
    timers (the pending-work accounting the post-`done` wait reads), so jsdom's
    versions would break capture and run completion while looking right. The
    other four — `performance`, `btoa`, `atob`, `queueMicrotask` — are jsdom
    wrappers that DELEGATE BACK to the global they would replace, so copying one
    onto `globalThis` makes it its own callee and it recurses until the stack
    blows. `btoa` is the nastiest: jsdom's `catch` reports the overflow as "The
    string to be encoded contains invalid characters", blaming the caller's
    input, so `btoa("hi")` fails with a message about `"hi"`. Leaving Deno's
    originals also fixes `window.btoa(...)`, which then delegates to something
    real. The rule for adding to the set: a name belongs there if it is a
    runner-owned channel or a self-delegating wrapper, not merely because Deno
    has its own.
- **Rejected:**
  - *Bundling jsdom in the extension* — ~10MB in every VSIX for a mode most
    scratchpad users never enable, plus a second jsdom version to keep current,
    plus widening `--allow-read` to the extension directory. Revisit if people
    ask for browser mode in a scratch buffer that has no project.
  - *Scoped `--allow-env=VAR,...`* — the failing call is
    `Object.keys(process.env)`, which a scoped grant still denies.
  - *Keeping deny-all and shimming a DOM by hand* — a hand-rolled `document` is
    a lie that diverges from browser behavior exactly where a scratchpad is
    being used to learn what browsers do.
  - *A `run`-message field for the mode* — a breaking change to a frozen
    interface for something that is process invocation.
- **Known limitations:** a scratch buffer with no project root has no
  `node_modules` to resolve jsdom from, so browser mode needs a project; and a
  package manager that stores real files OUTSIDE the project root would fall
  outside `--allow-read=<projectRoot>` (pnpm's `.pnpm` directory is inside it,
  so the common case is covered).
- **Revisit if:** browser mode is wanted without a project (then bundle jsdom
  and widen the read scope to the extension dir, deliberately), or jsdom turns
  out to need a permission beyond env — that is a new threat-model decision,
  not an implementation detail.
- **Covered by:** `scripts/jsdom-check.mjs` (`pnpm run check:jsdom`), which
  spawns the real runner with the real flags and the real scrubbed env and
  asserts the DOM is installed, the self-delegating wrappers still work (a
  `btoa`/`atob` round-trip and a `queueMicrotask`, each of which recursed before
  they were protected), captures still stream, a pending DOM timer still holds
  the run open, and `node` mode still has no `document`.

---

## 2026-09-16 — Gap 2 closed: the async wait ceiling is `quoll.runTimeoutMs` [DECIDED]

- **Context:** "Gap 2 — Async wait budget" above set the direction (wait for
  outstanding timers, bounded by the run timeout) and the runner half-did it:
  it stays alive while timers are pending, but under a hard-coded
  `ASYNC_MAX_MS = 5000`. The 10s `setTimeout` from the original Quokka
  comparison — the very case that motivated the decision — still gave up at 5s.
- **Decision:** The ceiling is configurable (`quoll.runTimeoutMs`, default 10s,
  clamped 100ms–10min in the runner) and the host passes it to the runner as
  **argv[0]**, not as a `run` field: `protocol/ipc.ts` is frozen, and
  `Deno.args` costs no sandbox permission (an env var would need
  `--allow-env`). The 200ms poll interval stays internal and was renamed
  `ASYNC_POLL_MS` — the spec's `asyncGraceMs` *quiet-window* framing is retired,
  since what a user wants to tune is how long to wait, not how often we look.
- **Rejected:**
  - *Adding a timeout field to the `run` message* — a breaking protocol change
    for something that is process invocation, not protocol.
  - *An env var* — widens the sandbox (`--allow-env`) for no gain.
  - *Leaving 5s* — it contradicts the recorded decision and the reference
    behavior.
  - Left at the default **window** scope, unlike `denoPath`: the ceiling is a
    resource knob, not a trust boundary (it can't redirect or widen the
    sandbox, and the next run kills the process), and a project with slow
    async is exactly who should be able to raise it in workspace settings.
- **Revisit if:** a run that legitimately waits the full ceiling makes the
  editor feel stuck. It shouldn't: `runId` cancellation means the next
  keystroke kills the in-flight run, so the wait only costs something when the
  user has stopped typing.
- **Covered by:** `scripts/timeout-check.mjs` (`pnpm run check:timeout`), which
  runs the runner under a small ceiling and asserts both sides — a 700ms timer
  is waited out and re-emitted as `then 42` with `update: true` and
  `exit: complete`, while a never-quiet interval exits `timeout` at the ceiling.
  Note a SILENT `setInterval` is deliberately untracked and does not hold a run
  open (see `patchTimers`).

---

## 2026-09-16 — Value Peek phase A: hover values, no re-run [DECIDED]

- **Context:** The shelved "Value Peek (Quokka Pro parity)" item in `LOG.md`.
  Every expression is already a capture site with a full source span, so a
  hover can answer "what was this?" from state the run already reported. The
  same note flagged a smaller bug: the inline decoration truncates at 120 chars
  and silently drops the tail.
- **Decision:** Build phase A only — `Aggregator.siteAt(line, column)` returns
  the *innermost* value site whose span covers the position, a `HoverProvider`
  (`src/hover.ts`) renders its capture history, and the hover carries an
  `Explore value` command link that reveals that site in the existing Quoll
  Values tree (`quoll.exploreValue` → `TreeView.reveal`, which is why the view
  is now created with `createTreeView` and roots carry stable `site:<id>` ids).
  No re-run, no re-eval, no new instrumentation, no protocol change.
  - Site spans are half-open (Oxc `Span.end` is emitted unadjusted), so the
    hover test is `column < endColumn`; an inclusive test matched the character
    *after* an expression and handed boundary positions to the outer site.
    `protocol/capture.ts` now says so on `CaptureSite` (comment only — the
    frozen shape is unchanged).
  - The hover ignores `quoll.values: "comments"`: quiet mode suppresses
    *unrequested* inline values, and a hover is a request.
  - Decoration `hoverMessage` is attached **only when the text was truncated**,
    so it doesn't double up with the value hover on every line. It is the only
    hover for console/error text, which is line-attributed and has no site.
- **Rejected:**
  - *Expanding objects inside the hover* (deep-serialize on hover) — the
    explorer already does lazy `expand`; the link reuses it for free.
  - *Phase B (`quoll.inlineValues: "always" | "hover"`)* and *phase C
    (value-on-selection via the dormant `selection` ExtraSite)* — B is a
    clutter-reduction setting worth having only once the hover has been lived
    with; C is the only phase that touches the native boundary.
    **Amended 2026-09-17:** phase C shipped after all — see the `extraSites`
    entry below, whose core work Logpoints (phase 9) needed anyway, so the
    native-boundary cost was paid once for both. Phase B is still deferred.
  - *Widening `SiteInfo` with optional span fields* — sites always have spans
    in production, so the fields are required and the unit tests build sites
    through a helper.
- **Revisit if:** hovering a hot loop's line feels heavy (the hover caps at the
  last 20 captures and summarizes the rest), or users ask for the value without
  the inline clutter — that's phase B, not a redesign.
- **Covered by:** `siteAt` unit test in `src/render/aggregate_test.ts`
  (innermost-wins, quiet mode) + an integration test in
  `src/test/extension.test.ts` that runs a real session and follows the hover's
  Explore Value link (the only test that exercises run → capture → hover).

---

## 2026-08-21 — `extraSites`: value-on-selection and Logpoints [DECIDED]

- **Context:** the slice the Phase 8 entry deferred. `InstrumentOpts.extraSites`
  was declared in the frozen protocol but never *produced* by the core, so
  `selection` and `logpoint` were the only `CaptureSiteKind`s nothing could emit
  — even though `aggregate.ts` had listed both in `OPT_IN_KINDS` since Phase 8.
  Two parity rows were blocked behind one piece of core work.
- **Decision:**
  - **The two kinds get DIFFERENT granularity, because their sources do.** A VS
    Code breakpoint marks a *line*, so a logpoint is a line set checked exactly
    like `//?`. An editor selection marks a *span*, so a selection is an anchor
    offset that claims the innermost capture containing it — children are
    visited before parents, so selecting `x * 2` in `xs.map(x => x * 2)` reveals
    the arrow body and leaves the enclosing call quiet. One shared granularity
    was tried on paper and fails: breakpoints report column 0, which sits before
    every initializer span and would match nothing.
  - **An anchor no capture contains falls back to its LINE.** Double-clicking
    the name in `const x = compute()` puts the anchor outside every capture
    span; without the fallback the reveal is silently empty, which reads as a
    broken feature rather than a precise one. A post-pass re-tags that line's
    `expr` sites — only `expr`, since `perf`/`branch`/`statement` encode
    mechanism rather than opt-in policy.
  - **`//?.` outranks an anchor and never consumes one.** Perf changes the
    capture *mechanism* (time the expression instead of reading it); letting a
    selection turn a timed line back into a value read would break the `//?.`
    contract for as long as the cursor happened to sit there.
  - **Columns convert UTF-16 → bytes at the napi boundary** (`prepareRun`), not
    at each call site. Every producer of an `ExtraSite` is a VS Code API, and
    the core indexes source by byte offset; converting once, where the contract
    lives, keeps callers passing editor positions verbatim.
  - **Collected only in quiet mode.** In `all` mode every expression already
    renders, so the tag would change no pixel while each drag-select and
    breakpoint toggle cost a Deno process.
- **No protocol change:** `ExtraSite`, `ExtraSiteKind` and both site kinds were
  already frozen. Third phase running that the upfront design pre-paid for.
- **Rejected:**
  - *Injecting NEW captures at arbitrary sub-expressions* (so selecting `bar` in
    `foo(bar)` reads `bar` itself, as Quokka does) — wrapping an arbitrary
    expression is not semantics-preserving: `obj.m()` → `__quoll.log(id, obj.m)()`
    silently drops the `this` binding, and assignment targets and patterns are
    not expressions at all. Nearest-enclosing-capture is truthful and safe;
    genuine sub-expression capture needs its own safe-position analysis first.
  - *Re-running on every selection change* — cursor moves dominate that channel.
    Only non-empty selections count, and only when the opt-in set actually
    changed (`extraKey`), so clearing a selection that revealed nothing is free.
  - *A `quoll.showValueAtSelection` command* — a gesture users already make
    (double-click, drag) beats a palette command they have to learn.
  - *Honouring only breakpoints with `logMessage` set* — the spec says
    "breakpoints in Quoll files", and a plain breakpoint is the gesture people
    reach for. Revisit if the two need to mean different things.
- **Golden case:** `selection.ts` — anchored, innermost-wins, line-fallback and
  logpoint, plus a line whose emoji prefix makes a byte/UTF-16 mix-up change the
  answer. Verified to FAIL with the feature removed and again with the column
  conversion removed, so it is a real net and not a tautology.
- **Known limitations:** selecting on a line with no capture at all (a
  `console.log` line, a bare `}`) reveals nothing — there is no captured value
  to show, and inventing one would violate truthful-over-cosmetic. The
  line-granular fallback is also narrower than "never silently empty" suggests:
  it matches a site's START or END line, so an anchor on a MIDDLE line of a
  multi-line expression (selecting `.map` on line 2 of a three-line chain)
  claims nothing and falls back to nothing.
- **Revisit if:** sub-expression values are asked for often enough to justify
  the safe-wrap analysis; or logpoints need to carry a `logMessage` expression
  rather than simply opting their line in.

## 2026-06-19 — Phase 8 live comments: `//?`, `//?.`, and quiet mode [DECIDED]

- **Context:** Phase 8's first slice. Quokka's `//?` shows a line's value and
  `//?.` shows its execution time. Quoll is already always-on (every expression
  renders), so the open question was what `//?` *adds* here, and how to time a
  line honestly.
- **Decision:**
  - **Comment extraction lives in the Oxc pass, not a host regex.** The parser
    already exposes `program.comments` with original-source spans; we read them
    in `lib.rs` (`collect_annotations`) BEFORE the transformer consumes the AST,
    so comment lines are in the same coordinate space the Instrumenter tags
    sites in. Strict match: the char immediately after `//` must be `?` (so
    `// ? prose` never triggers); `?.` → perf, `?` → comment. This reuses the
    Phase-6 lesson (import rewriting moved regex→AST) — never pattern-match
    Quoll semantics over generated text.
  - **`//?` re-tags the site `kind: "comment"`; it does not change capture.**
    Under always-on it renders identically to `expr`. Its real job is to be the
    opt-in marker for **quiet mode** (new `quoll.values: "all" | "comments"`
    setting). In `comments` mode the host filters inline values to opt-in kinds
    (`comment`/`selection`/`logpoint`); console and `//?.` timings still show;
    coverage and the explorer are untouched. This is the render-time FILTER the
    always-on entry (2026-06-12) promised, now delivered.
  - **`//?.` emits a `perf` site that wraps the expression in a thunk**
    (`__quoll.perf(id, () => expr)`). A call argument evaluates eagerly, so the
    expression must be DEFERRED or there'd be nothing left to time. The runner
    times the thunk call and emits the existing `perf` protocol message; the
    line renders `⏱ <n>ms` instead of the value. Only the SYNCHRONOUS evaluation
    is timed — consistent with the sync capture model.
- **No protocol change:** `perf` and the `comment`/`perf` kinds were already in
  the frozen interface (the `kind`/`extraSites` pre-payment). Another validation
  of the upfront design — Phase 8 was frontend/core work, not a protocol break.
- **Rejected:**
  - *Host-regex comment detection* — corrupts strings containing `//?`-shaped
    text and drifts from the AST (same failure the import rewrite hit).
  - *Timing the value eagerly* (`__quoll.perf(id, expr)`) — the expr is already
    evaluated by the time perf runs; nothing to measure. The thunk is required.
  - *Making `//?` a distinct capture path* — needless; it's the same value
    capture with a kind tag, which is exactly what quiet-mode filtering needs.
- **Golden cases:** `perf.ts` (asserts the `⏱` marker, not the non-deterministic
  duration) and `comments.ts` (quiet mode via a new `//@values comments` harness
  directive: opt-in line shows, auto line suppressed, coverage still works).
- **Deferred to the next slice:** value-on-selection + Logpoints, both via
  `InstrumentOpts.extraSites` (declared in the protocol, not yet produced by the
  core) — they share the extraSites plumbing and a command surface.
- **Revisit if:** multi-line expressions need annotation attachment beyond the
  start/end-line match used here; or quiet mode wants per-file/inline control
  rather than a workspace setting.

## 2026-06-14 — Sandbox trust root: `denoPath` is `machine`-scoped + auto-resolved [DECIDED]

- **Context:** the deny-all Deno sandbox (see the 2026-06-12 sandbox-model entry)
  only holds if the binary at `quoll.denoPath` is *honest Deno* — Quoll merely
  passes permission flags; the binary enforces them. So the whole security model
  reduces to "who chooses that binary." Two threat models fall out:
  - **A — attacker already on the user's machine** (can plant a fake `deno`,
    edit PATH or *user* settings): not Quoll's problem. They already have code
    execution as the user; no tool that shells out to an external binary can
    defend against its own enforcement binary being swapped. Out of scope.
  - **B — a cloned/hostile repo chooses the binary for you:** the real vector.
    `vscode.workspace.getConfiguration("quoll").get("denoPath")` reads the
    *merged* config, which includes the workspace's **committed**
    `.vscode/settings.json`. A repo could ship `"quoll.denoPath": "./evil"` and,
    on **Quoll: Start**, have the extension spawn an attacker binary with the
    user's privileges — defeating the sandbox before it exists.
- **Decision (two layers):**
  1. **`quoll.denoPath` is `scope: "machine"`** (`package.json`) — settable only
     in user/remote settings; a workspace `.vscode/settings.json` is hard-refused
     by VS Code ("This setting can only be applied in user settings…"). This is
     defense-in-depth *behind* Workspace Trust (Quoll declares no
     `capabilities.untrustedWorkspaces`, so it stays disabled until the user
     trusts the folder).
  2. **Auto-resolve the binary on the user's own machine** (`src/runner/deno.ts`,
     vscode-free + unit-tested): probe PATH → `~/.deno/bin` → mise shim →
     Homebrew → then ask the **login shell** (`$SHELL -lic 'command -v deno'`).
     The login-shell step fixes the common macOS case where a GUI-launched VS
     Code never inherited the shell PATH (mise/asdf users have a working `deno`
     in their terminal but not on the app's PATH). An auto-detected path is
     persisted to **Global (user)** settings — the only scope `machine` allows.
     A missing Deno raises an **actionable** `showErrorMessage` (Locate Deno… /
     Open Settings / Install Deno) at Start instead of silent empty output
     (`resolveDenoPath` + `promptForDeno` in `src/extension.ts`). The prompt is
     fire-and-forget: the Start command opens the editor and returns without
     awaiting it (awaiting a notification would hang a headless host — caught by
     the VS Code integration test timing out).
- **Aggressive probing here is safe** precisely because it only runs on the
  user's machine with their privileges (threat-model A territory — not an
  escalation). The dangerous, workspace-influenced path is closed off separately
  by the `machine` scope.
- **Rejected:**
  - **`machine-overridable` scope** — the name misleads: it *explicitly allows*
    workspace/folder override, so it does NOT close threat-model B. Verified live
    — a `machine-overridable` `denoPath` showed "(Also modified in Workspace)" in
    the settings UI, i.e. the workspace value was still honored. `machine` is the
    correct scope for an executable path.
  - **Leaving the bare `"deno"` default with no detection** — silent failure for
    every GUI-PATH / marketplace user (empty output, error buried in the hidden
    output channel). The whole point is to never present silence.
  - **Filtering/inspecting user code for malicious intent in the Rust core** —
    a losing game (static "is this bad?" detection) and the wrong layer. All
    security stays in the capability sandbox; the instrumenter rewrites code
    faithfully, malicious parts included.
- **Revisit if:** we add any other executable-path setting (apply the same
  `machine` scope + auto-resolve pattern), or remote-dev surfaces a case where
  the per-machine binary needs a different resolution than the login-shell probe.

## 2026-06-12 — Phase 6 bare specifiers: how to anchor npm resolution [DECIDED 2026-06-13 — Option 1]

- **Context:** relative project imports work (rewritten to absolute `file://`),
  but bare specifiers (`import _ from "lodash"`) fail. We need to decide HOW the
  runner finds the user's `node_modules` before landing the bare-specifier path
  (commit B). This entry records the analysis so the call is informed, not the
  call itself.
- **Root cause (verified by probes against Deno 2.8.3, not docs):** Deno's
  bring-your-own-node_modules (byonm, `--node-modules-dir=manual`) anchors npm
  resolution to the **main module's nearest `package.json`** — which is the
  RUNNER's location. The runner ships *inside* the extension (which has a
  `package.json`), so byonm looks in the extension's `node_modules`, never the
  user's project. `cwd` is only a *fallback*, used when the main module has no
  `package.json` ancestor. The user's code is imported via a `data:` URL, which
  has no filesystem location, so it can't anchor resolution either — this is the
  cost of the data:-URL sandbox choice (see the deny-all sandbox entry).
- **Empirically established (each a probe, recorded so we don't re-derive):**
  - runner entry under a `package.json` tree + `cwd=project` → FAIL (anchors to
    the runner's tree, ignores cwd).
  - `--config <file>` DOES re-anchor byonm, BUT the config must physically sit
    in the project root (a config shipped with the extension, or pointed at from
    outside the project, does not work). So it only helps projects that already
    have a `deno.json`/`deno.jsonc`.
  - runner entry in a dir with NO `package.json` ancestor + `cwd=project` →
    **works**, including a `package.json`-only project (no deno.json), with no
    writes and no config — byonm falls back to cwd. (`hello quoll 42` against a
    real fixture.)
  - `import type` targets are stripped at runtime, so the runner's runtime
    closure is just `runner/main.ts` + `runner/serialize.ts` (`protocol/*` are
    type-only) — "moving the runner" means copying two small files.
- **How Quokka achieves a "secure environment" (INFERENCE — Quokka is
  closed-source; reasoned from the Node platform + observable behavior, NOT
  authoritative):** Quokka almost certainly does NOT sandbox. It runs your code
  in a stock **Node.js** process, which has no real permission system, so the
  code has full fs/net/env/subprocess access — identical to `node yourfile.js`.
  (Even Node's `vm` module is explicitly not a security boundary for untrusted
  code, so any scope isolation there isn't a sandbox either.) Quokka's model is
  **trust, not isolation**: you opt a *specific file you're actively editing*
  into it, on code you already trust; the boundary is your decision to run it,
  not a runtime jail. Pen-testing wouldn't surface "sandbox escapes" because
  there is no sandbox — running the edited file with user privileges is the
  intended design. **Therefore Quoll's threat model is deliberately STRONGER
  than Quokka's:** Quoll auto-runs on every keystroke, including freshly-cloned
  untrusted repos opened only to read — which is exactly why Quoll runs under
  Deno deny-all where Quokka can lean on trust. "Match Quokka's capabilities in
  Quoll's honest idiom" (the truthful-over-cosmetic principle) extends to
  security: match the live-eval capability without inheriting the full-trust
  posture.
- **What the linked sources add (and a correction):**
  - `denoland/deno#6694` ("Runtime features to support Quokka.js", filed by the
    Quokka team) reveals the actual mechanism: they instrument by **duck-punching
    `fs.readFileSync`** so Node loads the *real file path* but receives
    *instrumented content* — real-path module resolution AND real stack-trace
    paths **without writing instrumented code to disk**. They also **recycle
    runner processes** (`unref`/`ref` a socket) for keystroke speed. **This trick
    is Node-only:** Deno exposes no compiler/loader hook (`deno#1739`), which is
    exactly what blocked their Deno support. **Correction to the inference above:**
    Quokka does NOT necessarily write a transformed copy of your code to disk — in
    Node it swaps content in-memory. The data:-URL is Quoll's Deno-native
    equivalent of "don't write user code to disk," and Option 1 (stage runner +
    `cwd`) is the closest we can get to Quokka's *no-write, real-resolution*
    property given Deno has no readFileSync seam.
  - `wallabyjs/quokka#456` (Deno-support request): confirms Quokka is Node-first
    and leans on Node's `node_modules` walk; little else.
  - `secure.software` scan of the Quokka VS Code extension: findings are
    **bundled-dependency CVEs** (lodash, uglify-js, rollup, ws, tar-fs, xmldom…)
    plus "execution-hijacking"/embedded-credential flags — rated **SAFE overall,
    no malware** (CVE specifics as reported by the scanner; treat as approximate).
    Decision-relevant: these are NOT sandbox-escape findings — consistent with
    "Quokka has no sandbox to escape." The comparable risk axis for Quoll is our
    OWN dependency hygiene (the extension's bundled JS deps), kept small by a Rust
    napi core + Deno + a thin esbuild bundle. Track separately from the user-code
    sandbox.
- **Option 1 (stage the runner in a neutral temp dir; KEEP the data: URL) —
  recommended:**
  - *Mechanism:* copy `main.ts` + `serialize.ts` into an OS temp dir (no
    `package.json` ancestor); spawn `deno run <tmp>/main.ts` with
    `cwd=projectRoot`. byonm falls back to cwd → resolves the project's
    `node_modules`. User code still travels via the data: URL; nothing of the
    user's is written to disk.
  - *Benefits:* universal (deno.json AND package.json-only projects); preserves
    every data:-URL sandbox property (never writes user code to disk, never
    mutates the user's project, no-import files still run pure deny-all); small
    additive change (a staging helper + a path swap in `client.ts`); only inert,
    static, cacheable runner files touch disk.
  - *Drawbacks:* adds a temp-dir lifecycle (create/cleanup, invalidate on
    extension-version change); assumes the OS temp root has no `package.json`
    ancestor (true on macOS/Linux/Windows defaults — worth a guard); does NOT
    simplify the data:-URL line-attribution regex; npm execution still rides on
    Deno's node-compat (already exercised by the CJS + ESM fixtures).
- **Comparison:**

  | approach | user code on disk | mutates user project | bare imports | sandbox |
  |---|---|---|---|---|
  | Quokka (Node) | no — in-memory content swap (readFileSync patch, Node-only) | no (real paths, not rewritten on disk) | free | none — trust-based, full-privilege Node |
  | Quoll today (data:, runner in place) | no | no | broken | Deno deny-all (+read project) |
  | Quokka-style for Quoll (write into project) | yes, every keystroke | yes | free | weaker — writes into the untrusted repo |
  | **Option 1** | no | no | works | Deno deny-all (+read project) |

- **Alternatives still on the table:**
  - *Option 0 — write instrumented code to a real file in the project* (the
    Quokka route): relative+bare resolve "for free" and stack traces get real
    file paths (simpler than the data:-URL regex), BUT it writes a transformed
    copy of the user's code into their working tree every keystroke — the exact
    thing the data:-URL design avoids; weakest story for the untrusted-repo
    threat model; needs per-run temp lifecycle + cleanup.
  - *Option 2 — `--config` to the project's deno.json:* simplest, but Deno-config
    projects only; npm-only projects (the common case) get nothing; the eval
    fixture would need a committed `deno.json`.
  - *Option 3 — host-resolve bare → absolute `file://`* (like relative): all in
    shared TS, universal, but CJS packages (`module.exports`) may not load via a
    bare `file://` import without npm: node-compat — the CJS fixture is the risk.
- **Precedent — anchoring resolution to a chosen root (not the tool's own
  install dir) is standard practice, not a hack.** Node resolves `node_modules`
  by walking up from the *importing file's* directory, so a tool that runs your
  code *in place* gets project resolution free; a tool whose own code lives
  elsewhere points resolution back at a chosen root. Established mechanisms that
  do exactly that:
  - **Node core — `NODE_PATH`** (documented env var adding resolution roots) and
    **`require.resolve(req, { paths })`** (resolve from arbitrary roots). The
    canonical "resolve from the working directory, not from my install location"
    pattern is `require.resolve(m, { paths: [process.cwd()] })`, packaged as
    sindresorhus's `resolve-cwd`. This is the closest direct analog to Option 1:
    runner lives elsewhere, resolution anchored to `cwd=projectRoot`.
  - **Jest** runs your code in its own harness but anchors module resolution to
    the project root via `roots`, `moduleDirectories`, and `modulePaths` — the
    docs describe `modulePaths` as literally "an alternative API to setting the
    `NODE_PATH` environment variable."
  - **webpack** gathers `resolve.modules` search dirs from the **context**
    directory (defaults to cwd), i.e. root-anchored, not loader-location-anchored.
  - **Deno itself** walks up to the nearest `package.json` and uses cwd as the
    discovery base when none is closer — the exact documented behavior Option 1
    leverages.
  Takeaway: Option 1 is Node-ecosystem-standard "resolve from the project root"
  applied to Deno's cwd-fallback. The only Quoll-specific twist is staging the
  runner in a neutral dir so cwd (not the runner's own `package.json`) wins.
- **Decision (user, 2026-06-13): Option 1.** It captures Quokka's cwd-anchored
  resolution win without Quokka's full-trust posture and without writing into the
  user's project, at the cost of a small temp-dir lifecycle. The OPEN analysis is
  kept in full (not trimmed) so a future revisit has the context that produced
  the call.
- **Implementation (commit B):** `src/runner/stage.ts` copies the runner's
  runtime closure (`main.ts` + `serialize.ts` — `protocol/*` is `import type`,
  erased; same invariant that lets the package omit `protocol/`) into an
  `os.tmpdir()` dir with no `package.json` ancestor, cached per process, cleaned
  on exit. `session.ts` + `eval/run.mjs` spawn that staged path; `client.ts`
  already sets `cwd=projectRoot` + `--node-modules-dir=manual` + `--sloppy-imports`
  + `--allow-read=projectRoot`. `--sloppy-imports` is part of this landing: it
  lets transitive PROJECT deps (real files Deno loads, not host-rewritten) use
  extensionless/index specifiers, matching what the host resolver accepts for the
  entry. Secondary fix: `resolveRequests` now maps unprefixed Node builtins
  (`fs`) to `node:fs` (via `node:module` `isBuiltin`), not `npm:fs`. Verified:
  `bare.ts` green (CJS `main` + ESM `exports`), full gate green.
- **Revisit if:** the temp-dir assumption (no `package.json` above the OS temp
  root) ever bites; or the data:-URL design is revisited wholesale (then Option 0
  becomes attractive for resolution + stack-trace simplicity).
- **References:**
  - `denoland/deno#6694` — Quokka team's runtime requirements for Deno
    (readFileSync duck-punch, process recycling, no compiler API → blocked):
    https://github.com/denoland/deno/issues/6694
  - `wallabyjs/quokka#456` — Deno support request (Quokka is Node-first):
    https://github.com/wallabyjs/quokka/issues/456
  - secure.software scan of `wallabyjs/quokka-vscode` — bundled-dependency CVEs,
    rated SAFE, no sandbox-escape findings:
    https://secure.software/vscode/packages/wallabyjs/quokka-vscode/vulnerabilities
  - Precedent for cwd/root-anchored resolution:
    - Node `NODE_PATH` + `require.resolve(req, { paths })`:
      https://nodejs.org/api/modules.html
    - `resolve-cwd` (`require.resolve(m, { paths: [process.cwd()] })`):
      https://github.com/sindresorhus/resolve-cwd
    - Jest `roots` / `moduleDirectories` / `modulePaths` (NODE_PATH analog):
      https://jestjs.io/docs/configuration
    - webpack `resolve.modules` from the context dir:
      https://webpack.js.org/configuration/resolve/
    - Deno node/npm resolution (nearest package.json, `nodeModulesDir`):
      https://docs.deno.com/runtime/fundamentals/node/

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
    before granting anything network-adjacent. **Done 2026-09-17:** browser mode
    grants `--allow-env` and nothing else — net stays denied, and the
    subprocess is spawned with an empty environment so the grant hands out
    nothing. See the Phase 7 entry at the top.
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
