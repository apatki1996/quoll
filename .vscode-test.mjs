import { defineConfig } from "@vscode/test-cli";

// Runs the bundled smoke/glue suite (out/test, built by `node esbuild.mjs
// --test`) in a throwaway VS Code instance. No workspaceFolder: the suite is
// self-contained, and a clean profile is what makes the config-defaults
// assertions meaningful.
export default defineConfig({
  files: "out/test/**/*.test.js",
  mocha: {
    ui: "tdd",
    timeout: 20000, // first run downloads + launches VS Code
  },
});
