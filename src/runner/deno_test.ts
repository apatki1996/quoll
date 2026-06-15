// Deno detection tests: `mise exec -- deno test --allow-run --allow-env --allow-sys --allow-read src/runner/deno_test.ts`
// (--allow-run to probe binaries, --allow-env for $SHELL, --allow-sys for homedir().)
import { strict as assert } from "node:assert";
import { detectDeno, probeDeno } from "./deno.ts";

// The test process IS Deno, so its own executable is a guaranteed-real binary.
const REAL_DENO = Deno.execPath();
const BOGUS = "/nonexistent/definitely-not-deno";

Deno.test("probeDeno: true for a real Deno binary", async () => {
  assert.equal(await probeDeno(REAL_DENO), true);
});

Deno.test("probeDeno: false for a missing path", async () => {
  assert.equal(await probeDeno(BOGUS), false);
});

Deno.test("probeDeno: false for a non-Deno binary", async () => {
  // `/bin/sh` exists and runs but is not Deno — guards against a denoPath
  // pointed at the wrong executable passing the probe.
  assert.equal(await probeDeno("/bin/sh"), false);
});

Deno.test("detectDeno: honors a working explicit path verbatim", async () => {
  assert.equal(await detectDeno(REAL_DENO), REAL_DENO);
});

Deno.test("detectDeno: undefined for an explicit path that doesn't work", async () => {
  // An explicit (non-default) choice is never silently replaced by detection.
  assert.equal(await detectDeno(BOGUS), undefined);
});

Deno.test("detectDeno: auto-detects when given the bare default", async () => {
  // `deno` is on PATH in the test runner, so the candidate sweep finds it.
  const resolved = await detectDeno("deno");
  assert.ok(resolved, "expected a resolved Deno path");
});
