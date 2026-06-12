# Quoll

A free, open-source live scratchpad for VS Code — an alternative to [Quokka.js](https://quokkajs.com).

Quoll runs your JavaScript/TypeScript as you type and shows what your code actually does, right in the editor:

- **Inline values** — expression results and variable values appear next to the code that produced them
- **Live code coverage** — gutter indicators show which lines ran, didn't run, or partially ran
- **Inline runtime errors** — exceptions and unhandled rejections surface on the line that threw them
- **Console output** — `console.log` results render inline at the call site
- **TypeScript out of the box** — no build step or config needed
- **Sandboxed execution** — code runs in a permission-locked Deno process with no file system or network access

## Status

Quoll is in early, active development. The current build supports single-file scratchpads with the features above. The roadmap (see [`quoll-spec.md`](quoll-spec.md)) targets full feature parity with Quokka.js, including the value explorer, project imports with change detection, live comments (`//?`), logpoints, time machine, CPU profiling, and more.

## How it works

- A **Rust core** (built on [Oxc](https://oxc.rs)) parses, type-strips, and instruments your code in a single pass, producing one source map — so values and coverage always land on the right line.
- A **Deno runner** executes the instrumented code in a sandbox and streams values, coverage, and errors back over a simple NDJSON protocol.
- The **VS Code extension** debounces your keystrokes, re-runs on change, and renders results as editor decorations.

## Getting started (from source)

Quoll isn't on the marketplace yet — you run it as a development extension.

**Prerequisites:** Node.js with [pnpm](https://pnpm.io), a Rust toolchain, and [Deno](https://deno.com) 2.x (a [mise](https://mise.jdx.dev) pin is included).

```sh
pnpm install
node scripts/build-core.mjs   # builds the native instrumentation core
pnpm run build
```

Then open the repo in VS Code, press **F5** to launch the extension development host, open a `.ts` or `.js` file, and run **Quoll: Start** from the command palette. If Deno isn't on your PATH, point `quoll.denoPath` at the binary in your settings.

To run the test suite (the golden-eval harness):

```sh
pnpm run eval
```

## Contributing

Contributions are welcome — bug reports, feature requests, and PRs alike. A few pointers:

- [`quoll-spec.md`](quoll-spec.md) is the source of truth for architecture and the phased roadmap.
- The interfaces in `protocol/` are frozen contracts between the extension, runner, and instrumentation core — changes there need discussion first (open an issue).
- New behavior in the instrument → run → render pipeline should come with a golden-eval case in `eval/cases/`.

If you're unsure where to start, open an issue and ask.

## License

[MIT](LICENSE)
