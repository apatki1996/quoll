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
 * Specifier FINDING has two tiers: the native binding's parse-accurate
 * `listImports` (used via `resolveRequests` + a `collectDeps` lister — a user
 * string that merely looks like an import can never false-match), and the
 * regex below as the identity-fallback tier (no native binary), which keeps
 * the known string-literal false-positive risk. RESOLUTION (this module) is
 * shared by both tiers.
 */
import { readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
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

export type ResolvedRequests = {
  /** Specifier → absolute file:// URL, for the native AST-level rewrite. */
  rewrites: Record<string, string>;
  /** Absolute paths of the entry's resolved relative imports (direct deps). */
  deps: string[];
};

/** `node:`, `npm:`, `jsr:`, `https:`, `data:`, … — and `C:\` (Windows). */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolve the entry's module requests (from the native `listImports`).
 * - relative → absolute file:// URL (a data: entry can't resolve relative);
 * - bare Node builtin (`fs`, `path`, `fs/promises`) → `node:<spec>` — Deno
 *   needs the explicit prefix, and `npm:fs` would just fail to resolve;
 * - other bare → `npm:<spec>` (resolved by Deno in the PROJECT's node_modules:
 *   the runner gets `--node-modules-dir=manual` + cwd=projectRoot, which is
 *   what keeps this local-only — see StartRunOpts.projectRoot);
 * - scheme'd specifiers (node:, npm:, https:, …) pass through;
 * - unresolvable relative specifiers are left alone so they surface as a real
 *   runtime error rather than being silently dropped.
 */
export function resolveRequests(requests: readonly string[], entryPath: string): ResolvedRequests {
  const fromDir = dirname(entryPath);
  const rewrites: Record<string, string> = {};
  const deps = new Set<string>();
  for (const spec of requests) {
    if (isRelative(spec)) {
      const abs = resolveSpecifier(spec, fromDir);
      if (!abs) continue;
      rewrites[spec] = pathToFileURL(abs).href;
      deps.add(abs);
    } else if (!HAS_SCHEME.test(spec) && !spec.startsWith("/")) {
      rewrites[spec] = isBuiltin(spec) ? `node:${spec}` : `npm:${spec}`;
    }
  }
  return { rewrites, deps: [...deps] };
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
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
  const rewritten = code.replace(
    SPECIFIER,
    (whole, prefix: string, quote: string, spec: string) => {
      const abs = resolveSpecifier(spec, fromDir);
      if (!abs) return whole;
      deps.add(abs);
      return `${prefix}${quote}${pathToFileURL(abs).href}${quote}`;
    },
  );
  return { code: rewritten, deps: [...deps] };
}

/** Relative specifiers in `code` (the set rewriteImports/collectDeps target). */
function relativeSpecifiers(code: string): string[] {
  return [...code.matchAll(SPECIFIER)].map((m) => m[3]!); // group 3 present on any match
}

/**
 * The TRANSITIVE set of project files the entry statically imports (absolute
 * paths) — the watch graph for auto-rerun. Reads each dep from disk and follows
 * its relative imports; cycles are handled via the visited set. Dynamic imports
 * with computed specifiers and bare specifiers (node_modules) are not followed
 * (v1). The entry's own path is NOT included (the editor already re-runs on it).
 *
 * `listRequests` lets the caller supply the parse-accurate native lister
 * (prepareRun does); the default is the regex tier. Either may return bare
 * specifiers — only relative ones are followed.
 */
export function collectDeps(
  entryCode: string,
  entryPath: string,
  listRequests: (code: string, path: string) => string[] = (code) => relativeSpecifiers(code),
): string[] {
  const seen = new Set<string>();
  const visit = (code: string, fromPath: string): void => {
    const fromDir = dirname(fromPath);
    for (const spec of listRequests(code, fromPath)) {
      if (!isRelative(spec)) continue;
      const abs = resolveSpecifier(spec, fromDir);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      try {
        visit(readFileSync(abs, "utf8"), abs);
      } catch {
        // unreadable dep — still worth watching, but can't follow its imports.
      }
    }
  };
  visit(entryCode, entryPath);
  return [...seen];
}
