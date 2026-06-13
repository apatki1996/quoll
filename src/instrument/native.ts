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
    // import.meta.url (not __filename) so this module loads under BOTH the
    // esbuild CJS bundle (live host) and node-ESM type-strip (eval harness) —
    // letting both share prepareRun instead of duplicating the pipeline.
    const require = createRequire(import.meta.url);
    cached = require(file) as NativeBinding;
  } catch {
    cached = null; // no binary for this platform — caller falls back to identity
  }
  return cached;
}
