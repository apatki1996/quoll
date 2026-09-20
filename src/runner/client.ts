/**
 * Host-side runner client: one Deno subprocess per run.
 * Cancellation = kill the process; the host discards messages from stale
 * runIds at the consumer.
 */

import { spawn } from "node:child_process";
import type { HostMsg, RunnerMsg } from "../../protocol/index.ts";
import { EXTENSION_ID } from "../constants.ts";

export type RunHandle = {
  cancel(): void;
  /**
   * Write a follow-up HostMsg (`expand`) to the live runner. Returns false
   * when the process is already gone — the caller treats that as
   * "value no longer available".
   */
  send(msg: HostMsg): boolean;
  /** Resolves when the subprocess exits (any reason). */
  exited: Promise<void>;
};

export type StartRunOpts = {
  denoPath: string;
  /** Absolute path to runner/main.ts. */
  runnerMain: string;
  runId: number;
  code: string;
  entry: string;
  /**
   * Project root (Phase 6). Drives three scoped loosenings — and nothing else:
   * - `--allow-read=<root>`: file:// project imports are loadable (module
   *   loads from a data: entry need read permission). Read-only, never
   *   net/write/run — imported code can read the project but can't exfiltrate.
   * - subprocess cwd: with `--node-modules-dir=manual` AND a runner staged to a
   *   neutral temp dir (no package.json ancestor — see stageRunner), Deno's
   *   byonm falls back to cwd, so npm: specifiers resolve in THIS project's
   *   node_modules — local-only and deterministic (without manual mode, Deno
   *   would fall back to its global npm cache and even the network: wrong
   *   packages, silently; without staging, byonm would anchor to the
   *   extension's own package.json instead of the project).
   * Absent = deny-all (no imports).
   */
  projectRoot?: string;
  /**
   * How long the runner may wait, after the synchronous run finishes, for
   * outstanding timers/promises to settle before it gives up ("timeout").
   * Passed as a CLI arg — the `run` message is a frozen interface, and
   * `Deno.args` costs no sandbox permission.
   */
  runTimeoutMs: number;
  /**
   * Phase 7 browser runtime: run with a jsdom window installed as globals.
   * This is the one mode that grants `--allow-env`, because jsdom's
   * dependencies enumerate `process.env` on load — so the subprocess is spawned
   * with a scrubbed environment holding only PATH (see below), and the grant
   * reaches nothing else the user has exported.
   */
  browser: boolean;
  onMessage: (msg: RunnerMsg) => void;
  /** Runner stderr (diagnostics) and spawn/parse failures. */
  onDiagnostic: (text: string) => void;
};

export function startRun(opts: StartRunOpts): RunHandle {
  // Default-deny: no net/env/run/write. The only loosening is the scoped
  // projectRoot trio (read/cwd/byonm — see StartRunOpts); stdio is always
  // available. --sloppy-imports lets transitive PROJECT deps (real files
  // loaded by Deno, not rewritten by the host) use extensionless/index
  // specifiers, matching what the host's resolver accepts for the entry.
  // --no-remote: block remote (http/https/jsr) module specifiers. Without it,
  // user code can exfiltrate via a computed `import("https://…/" + secret)` URL
  // even though --allow-net denies fetch (remote imports are a separate Deno
  // capability). Local file:///npm:/node: imports are unaffected.
  const args = [
    "run",
    "--quiet",
    "--no-prompt",
    "--no-remote",
    "--node-modules-dir=manual",
    "--sloppy-imports",
  ];
  if (opts.projectRoot) args.push(`--allow-read=${opts.projectRoot}`);
  // See StartRunOpts.browser: the grant is paired with the scrubbed env below,
  // so all it can enumerate is the one variable we put there.
  if (opts.browser) args.push("--allow-env");
  args.push(opts.runnerMain, String(opts.runTimeoutMs), opts.browser ? "browser" : "node");
  const child = spawn(opts.denoPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.projectRoot,
    // Only browser mode needs this: without --allow-env, Deno already denies
    // every read, so node mode keeps the inherited environment (and with it
    // whatever Deno itself reads) untouched. PATH survives because denoPath
    // may legitimately be the bare "deno" (see candidatePaths) and the exec
    // lookup reads the CHILD's environment — dropping it would break the spawn
    // rather than the sandbox. So browser-mode user code CAN read PATH, and
    // with it the home directory and installed toolchains: a disclosure, not a
    // channel (net/write/run stay denied). Resolving denoPath to an absolute
    // path in the host would let this be a truly empty env — worth doing if
    // the disclosure ever matters.
    ...(opts.browser ? { env: { PATH: process.env.PATH ?? "" } } : {}),
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    // ENOENT = the denoPath binary doesn't exist (vs. a real spawn failure).
    // The Start-time probe (ensureDeno) is the primary guard with an actionable
    // prompt; this only fires if the binary vanishes mid-session, so a clear
    // output-channel line is enough.
    opts.onDiagnostic(
      err.code === "ENOENT"
        ? `Deno not found at "${opts.denoPath}". Set ${EXTENSION_ID}.denoPath or install Deno.`
        : `failed to spawn runner (${opts.denoPath}): ${err.message}.`,
    );
  });
  // A failed spawn (ENOENT) destroys the stdio streams with an error; without
  // a listener the buffered stdin write below becomes an uncaught exception
  // in the extension host. child.on("error") above already reports the cause.
  child.stdin.on("error", () => {});

  const runMsg: HostMsg = { t: "run", runId: opts.runId, code: opts.code, entry: opts.entry };
  child.stdin.write(JSON.stringify(runMsg) + "\n");

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        opts.onMessage(JSON.parse(line) as RunnerMsg);
      } catch {
        opts.onDiagnostic(`unparseable runner message: ${line}`);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => opts.onDiagnostic(chunk.trimEnd()));

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });

  return {
    cancel() {
      child.kill();
    },
    send(msg: HostMsg): boolean {
      if (child.killed || child.stdin.destroyed || !child.stdin.writable) return false;
      child.stdin.write(JSON.stringify(msg) + "\n");
      return true;
    },
    exited,
  };
}
