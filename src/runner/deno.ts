/**
 * Deno binary resolution — vscode-free so it's unit-testable without a VS Code
 * instance (see deno_test.ts).
 *
 * The whole sandbox bottoms out at "denoPath is honest Deno": Quoll only passes
 * permission flags; the binary enforces them. Detection here therefore matters
 * for security as well as UX — but it's safe to probe well-known install
 * locations, because this only ever runs on the USER's machine with the user's
 * own privileges (threat-model A: anyone who can plant a binary there already
 * has code execution as the user). The path the WORKSPACE could influence is
 * the dangerous one, and that's closed off separately: `quoll.denoPath` is
 * `machine`-scoped (see package.json), so a cloned repo's settings can never
 * choose the binary — only the user's (or remote's) settings can.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PROBE_TIMEOUT_MS = 3000;
const SHELL_TIMEOUT_MS = 4000;

/** True iff `path` runs and identifies itself as Deno (not some other binary). */
export function probeDeno(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      // `deno --version` prints "deno x.y.z\n…". Matching it rejects a
      // mis-pointed denoPath (e.g. at `node`) here, instead of letting it fail
      // cryptically on the first run.
      resolve(!err && /^deno\s/i.test(stdout));
    });
  });
}

/** Well-known install locations, in fast-to-probe order (PATH first). */
function candidatePaths(): string[] {
  const home = homedir();
  return [
    "deno", // PATH — the common case
    join(home, ".deno", "bin", "deno"), // official installer
    join(home, ".local", "share", "mise", "shims", "deno"), // mise shim
    "/opt/homebrew/bin/deno", // Homebrew (Apple silicon)
    "/usr/local/bin/deno", // Homebrew (Intel) / manual install
  ];
}

/**
 * Ask the user's LOGIN shell where deno is. Covers the common macOS case where
 * VS Code, launched from Finder/Dock/Spotlight, never inherited the shell PATH
 * — so the plain "deno" probe fails even though `deno` works in the user's
 * terminal (mise, asdf, nvm-style version managers live in shell rc files).
 */
function fromLoginShell(): Promise<string | undefined> {
  const shell = process.env.SHELL;
  if (!shell || process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // `-i` so the shell sources the rc that sets up the version manager; take
    // the last non-empty line, since rc noise can print before the path.
    execFile(shell, ["-lic", "command -v deno"], { timeout: SHELL_TIMEOUT_MS }, (err, stdout) => {
      // Last non-empty line: rc noise can print before the path. (A plain
      // reverse scan — `findLast`/`toReversed` are ES2023, past the lib target.)
      const lines = stdout.split("\n");
      let path: string | undefined;
      for (let i = lines.length - 1; i >= 0 && !path; i--) {
        const trimmed = lines[i]?.trim();
        if (trimmed) path = trimmed;
      }
      resolve(err ? undefined : path);
    });
  });
}

/**
 * Resolve a working Deno binary. An explicit `configured` path (anything other
 * than the bare "deno" default) is honored as-is: probed and returned if it
 * works, else undefined — an explicit user choice is never silently replaced
 * with an auto-detected one. With no explicit choice, probe the candidate list,
 * then fall back to the login shell. Returns the working path (which may differ
 * from `configured`, so the caller can persist it) or undefined when nothing
 * answers.
 */
export async function detectDeno(configured: string | undefined): Promise<string | undefined> {
  if (configured && configured !== "deno") {
    return (await probeDeno(configured)) ? configured : undefined;
  }
  for (const candidate of candidatePaths()) {
    if (await probeDeno(candidate)) return candidate;
  }
  const shellPath = await fromLoginShell();
  if (shellPath && (await probeDeno(shellPath))) return shellPath;
  return undefined;
}
