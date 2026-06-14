// Regression guard for the fidelity gap that hid the bare-specifier failure:
// the unit tests and eval harness import the TS sources under node-ESM / Deno
// (where `import.meta.url` is defined), but the SHIPPED extension runs the
// esbuild CJS bundle — where esbuild stubs `import.meta` to `{}`, so anything
// depending on `import.meta.url` silently breaks. That dropped every run to the
// identity fallback (no instrumentation; bare specifiers left unresolved, so a
// bare `import "mathy"` died with Deno's "not a dependency").
//
// This bundles src/instrument/native.ts exactly as the real build does (CJS,
// platform node) and asserts loadNative() still loads the napi binary from the
// bundled form. It fails loudly if anyone reintroduces an import.meta-shaped
// dependency that survives source/Deno but breaks the bundle.
//
// Usage: node scripts/check-native-bundle.mjs   (skips cleanly if the napi
// binary for this platform isn't built — that's the legitimate fallback case).
import esbuild from "esbuild";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, "native", `quoll-core.${process.platform}-${process.arch}.node`);

if (!existsSync(binary)) {
  console.log(`SKIP check-native-bundle: no napi binary for ${process.platform}-${process.arch}`);
  console.log("  (run `node scripts/build-core.mjs` to exercise the native path)");
  process.exit(0);
}

// Bundle native.ts with the SAME settings as esbuild.mjs's extensionConfig, then
// re-export loadNative so we can call it against the bundled output.
const entry = `export { loadNative } from ${JSON.stringify(join(root, "src/instrument/native.ts"))};`;
const { outputFiles } = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node20",
});

// Load the bundle the same way VS Code loads dist/extension.js: as a real CJS
// file off disk. (Placed under dist/ so a relative `require` base matches the
// shipped layout, though loadNative resolves the binary via an absolute path.)
const dir = mkdtempSync(join(tmpdir(), "quoll-native-bundle-"));
const bundlePath = join(dir, "native-bundle.cjs");
writeFileSync(bundlePath, outputFiles[0].text);
let native;
try {
  native = createRequire(import.meta.url)(bundlePath).loadNative(root);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
assert.ok(
  native && typeof native.instrument === "function" && typeof native.listImports === "function",
  "loadNative returned null from the CJS bundle — the napi binary did not load. " +
    "The bundled extension would silently fall back to the identity path " +
    "(no instrumentation; bare specifiers unresolved). Check native.ts for an " +
    "import.meta dependency that esbuild stubs out in the CJS bundle.",
);

console.log("PASS check-native-bundle: napi binary loads from the esbuild CJS bundle");
