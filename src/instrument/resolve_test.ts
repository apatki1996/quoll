// Resolver unit tests: `mise exec -- deno test --allow-read --allow-write src/ runner/`
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectDeps, resolveSpecifier, rewriteImports } from "./resolve.ts";

const tmp = Deno.makeTempDirSync({ prefix: "quoll-resolve-" });
writeFileSync(join(tmp, "util.ts"), "export const x = 1;\n");
writeFileSync(join(tmp, "plain.js"), "export const y = 2;\n");
mkdirSync(join(tmp, "lib"));
writeFileSync(join(tmp, "lib", "index.ts"), "export const z = 3;\n");

Deno.test("resolveSpecifier: exact path", () => {
  assert.equal(resolveSpecifier("./util.ts", tmp), join(tmp, "util.ts"));
});

Deno.test("resolveSpecifier: tries extensions when omitted", () => {
  assert.equal(resolveSpecifier("./util", tmp), join(tmp, "util.ts"));
  assert.equal(resolveSpecifier("./plain", tmp), join(tmp, "plain.js"));
});

Deno.test("resolveSpecifier: directory index", () => {
  assert.equal(resolveSpecifier("./lib", tmp), join(tmp, "lib", "index.ts"));
});

Deno.test("resolveSpecifier: undefined for missing", () => {
  assert.equal(resolveSpecifier("./nope", tmp), undefined);
});

Deno.test("collectDeps: transitive graph, cycle-safe, entry excluded", () => {
  writeFileSync(join(tmp, "a.ts"), `import "./b.ts";\n`);
  writeFileSync(join(tmp, "b.ts"), `import "./a.ts";\nexport const b = 1;\n`); // a<->b cycle
  const entryCode = `import "./util.ts";\nimport "./lib";\nimport "./a.ts";\n`;
  const deps = collectDeps(entryCode, join(tmp, "main.ts")).sort();
  assert.deepEqual(
    deps,
    [join(tmp, "a.ts"), join(tmp, "b.ts"), join(tmp, "lib", "index.ts"), join(tmp, "util.ts")].sort(),
  );
});

Deno.test("rewriteImports: relative -> file://, collects deps, leaves bare alone", () => {
  const code = [
    `import { x } from "./util.ts";`,
    `import "node:assert";`,
    `import { readFile } from "fs";`,
    `export * from "./lib";`,
    `const p = import("./plain.js");`,
  ].join("\n");
  const { code: out, deps } = rewriteImports(code, join(tmp, "main.ts"));

  const utilUrl = pathToFileURL(join(tmp, "util.ts")).href;
  const libUrl = pathToFileURL(join(tmp, "lib", "index.ts")).href;
  const plainUrl = pathToFileURL(join(tmp, "plain.js")).href;
  assert.ok(out.includes(utilUrl), "static import rewritten");
  assert.ok(out.includes(libUrl), "export-from rewritten");
  assert.ok(out.includes(plainUrl), "dynamic import rewritten");
  assert.ok(out.includes(`"node:assert"`), "bare node: specifier untouched");
  assert.ok(out.includes(`from "fs"`), "bare specifier untouched");
  assert.deepEqual(
    [...deps].sort(),
    [join(tmp, "lib", "index.ts"), join(tmp, "plain.js"), join(tmp, "util.ts")].sort(),
  );
});
