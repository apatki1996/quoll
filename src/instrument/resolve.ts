/**
 * Phase 6 — relative import resolution (vscode-free; shared by the live host
 * and the eval harness so the harness tests the real logic).
 *
 * The runner executes the entry as an in-memory `data:` URL, which has no base
 * — so a relative specifier like `./util.ts` can't resolve (Deno: "relative URL
 * with a cannot-be-a-base base"). We rewrite the entry's relative specifiers to
 * absolute `file://` URLs (which a `data:` module CAN import, verified), so Deno
 * loads the real sibling files from disk. Returns the resolved dependency paths
 * so the host can watch them and re-run on change.
 *
 * v1 scope: relative specifiers (`./`, `../`) only. Bare specifiers
 * (`node_modules`, tsconfig `paths`) are left untouched — they resolve through
 * the same seam later without changing this contract.
 *
 * NB: the rewrite is a targeted regex over import/export/dynamic-import string
 * literals, not a full parse — good enough for v1; move to Oxc-span extraction
 * if a string literal in non-import position ever false-matches in practice.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".cts"];

/** `from "x"`, `import "x"`, `export … from "x"`, or `import("x")`. */
const SPECIFIER = /(\b(?:from|import|export\s*\*\s*from)\s*\(?\s*)(["'])(\.\.?\/[^"']*)\2/g;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Node/Deno-style resolution of a relative specifier to an absolute file. */
export function resolveSpecifier(specifier: string, fromDir: string): string | undefined {
  const base = resolvePath(fromDir, specifier);
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexed = join(base, `index${ext}`);
    if (isFile(indexed)) return indexed;
  }
  return undefined;
}

export type RewriteResult = {
  /** Entry code with relative specifiers rewritten to absolute file:// URLs. */
  code: string;
  /** Absolute paths the entry directly imports (for the watch graph). */
  deps: string[];
};

/**
 * Rewrite the entry's relative import specifiers to absolute file:// URLs.
 * Unresolvable specifiers are left as-is (they surface as a real runtime error
 * rather than being silently dropped).
 */
export function rewriteImports(code: string, entryPath: string): RewriteResult {
  const fromDir = dirname(entryPath);
  const deps = new Set<string>();
  const rewritten = code.replace(SPECIFIER, (whole, prefix: string, quote: string, spec: string) => {
    const abs = resolveSpecifier(spec, fromDir);
    if (!abs) return whole;
    deps.add(abs);
    return `${prefix}${quote}${pathToFileURL(abs).href}${quote}`;
  });
  return { code: rewritten, deps: [...deps] };
}
