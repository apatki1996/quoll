import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stage the runner's runtime files into a temp dir that has NO `package.json`
 * ancestor, and return the staged entry path (Phase 6, Option 1).
 *
 * Why: Deno's byonm (`--node-modules-dir=manual`) anchors npm resolution to the
 * MAIN MODULE's nearest `package.json`. Run in place, the runner sits inside the
 * extension — which has a `package.json` — so byonm would resolve the
 * EXTENSION's `node_modules`, never the user's project, and `cwd` is only a
 * fallback it never reaches. Staged under `os.tmpdir()` the runner has no
 * `package.json` above it, so byonm falls back to cwd — which `startRun` sets to
 * the project root. This is the standard "resolve from the project root, not the
 * tool's install dir" pattern (NODE_PATH / Jest modulePaths / webpack context),
 * applied to Deno's cwd-fallback. See DECISIONS.md "how to anchor npm resolution".
 *
 * The runtime closure is just `main.ts` + `serialize.ts`: the `protocol/*`
 * imports are `import type` and erased by Deno before resolution — the same
 * invariant that lets the packaged extension omit `protocol/` (see
 * `runner/main.ts`). A future VALUE import from `protocol/` would need staging
 * here too; the runner comment guards against that.
 */
const RUNTIME_FILES = ["main.ts", "serialize.ts"] as const;

/** Cached per extensionRoot: stage once per process, reuse every run. */
const staged = new Map<string, string>();
const stagedDirs: string[] = [];
let exitHooked = false;

export function stageRunner(extensionRoot: string): string {
  const cached = staged.get(extensionRoot);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "quoll-runner-"));
  for (const f of RUNTIME_FILES) {
    copyFileSync(join(extensionRoot, "runner", f), join(dir, f));
  }
  const main = join(dir, "main.ts");
  staged.set(extensionRoot, main);
  stagedDirs.push(dir);
  hookCleanup();
  return main;
}

function hookCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  // Best-effort: the OS reclaims tmpdir regardless, so a failed rm here is not
  // worth surfacing (the process is already exiting).
  process.once("exit", () => {
    for (const dir of stagedDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // process is exiting; OS tmp cleanup is the backstop.
      }
    }
  });
}
