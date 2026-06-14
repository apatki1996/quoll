import { createRequire } from "node:module";

/** Shape of the napi binding (snake_case Rust → camelCase via napi-rs). */
export type NativeBinding = {
  /** Parse-only module-request listing (static import/export sources +
   * string-literal dynamic imports), for resolving before instrument(). */
  listImports(source: string, filename: string, jsx: boolean): string[];
  instrument(
    source: string,
    opts: {
      filename: string;
      jsx: boolean;
      /** Specifier → replacement, applied at the AST level before codegen. */
      rewrites?: Record<string, string>;
    },
  ): {
    code: string;
    mapJson: string;
    sites: {
      id: number;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
      kind: string;
    }[];
    errors: { message: string; line?: number }[];
  };
};

let cached: NativeBinding | null | undefined;

export function loadNative(extensionRoot: string): NativeBinding | null {
  if (cached !== undefined) return cached;
  const file = `${extensionRoot}/native/quoll-core.${process.platform}-${process.arch}.node`;
  try {
    // `file` is ABSOLUTE, so createRequire's base only needs to be a valid path,
    // not a meaningful one. Use process.execPath rather than import.meta.url:
    // esbuild stubs import.meta to `{}` in the CJS bundle (the shipped extension),
    // so import.meta.url is undefined there and createRequire(undefined) THROWS —
    // which this catch would swallow, silently dropping every run to the identity
    // fallback (no instrumentation, bare specifiers left unresolved). process.execPath
    // is a real absolute path under BOTH the CJS bundle (live host) and the node-ESM
    // type-strip (eval harness), so both share the real prepareRun pipeline.
    const require = createRequire(process.execPath);
    cached = require(file) as NativeBinding;
  } catch {
    cached = null; // no binary for this platform — caller falls back to identity
  }
  return cached;
}
