/**
 * Host-side runner client: one Deno subprocess per run.
 * Cancellation = kill the process; the host discards messages from stale
 * runIds at the consumer.
 */

import { spawn } from "node:child_process";
import type { HostMsg, RunnerMsg } from "../../protocol/index.ts";

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
  /** Scoped read access for resolving project imports (Phase 6). Read-only,
   * never net/write/run — so imported code can read the project but can't
   * exfiltrate. Absent = deny-all (no imports). */
  allowReadDir?: string;
  onMessage: (msg: RunnerMsg) => void;
  /** Runner stderr (diagnostics) and spawn/parse failures. */
  onDiagnostic: (text: string) => void;
};

export function startRun(opts: StartRunOpts): RunHandle {
  // Default-deny: no net/env/run/write. The only loosening is a scoped
  // --allow-read for project imports (Phase 6); stdio is always available.
  const args = ["run", "--quiet", "--no-prompt"];
  if (opts.allowReadDir) args.push(`--allow-read=${opts.allowReadDir}`);
  args.push(opts.runnerMain);
  const child = spawn(opts.denoPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    opts.onDiagnostic(
      `failed to spawn runner (${opts.denoPath}): ${err.message}. ` +
        `Install Deno or set quoll.denoPath.`,
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
