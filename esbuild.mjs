import esbuild from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const test = process.argv.includes("--test");

/** Recursively collect `*.test.ts` under a directory (esbuild's JS API doesn't glob). */
function findTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(path));
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

// Surfaces esbuild errors in VS Code's Problems panel (paired with the
// connor4312.esbuild-problem-matchers extension, recommended in
// .vscode/extensions.json) and prints the [watch] markers tasks.json keys on.
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
    });
  },
};

// Tests run under Mocha in the extension host: bundle each `*.test.ts` to
// out/test/ (cjs, vscode external — provided by the host). @vscode/test-cli
// loads the built .js files; see .vscode-test.mjs.
const testConfig = {
  entryPoints: findTests("src/test"),
  outdir: "out/test",
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  plugins: [problemMatcherPlugin],
};

const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  plugins: [problemMatcherPlugin],
};

const ctx = await esbuild.context(test ? testConfig : extensionConfig);

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
