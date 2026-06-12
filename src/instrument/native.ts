import { createRequire } from "node:module";

/** Shape of the napi binding (snake_case Rust → camelCase via napi-rs). */
export type NativeBinding = {
  instrument(
    source: string,
    opts: { filename: string; jsx: boolean },
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
    const require = createRequire(__filename);
    cached = require(file) as NativeBinding;
  } catch {
    cached = null; // no binary for this platform — caller falls back to identity
  }
  return cached;
}
