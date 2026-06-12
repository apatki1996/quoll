// Registry + expansion unit tests: `mise exec -- deno test runner/`
// NB: the registry is module-global (one run per process in production), so
// tests share it; the eviction test floods it and therefore runs LAST.

import { strict as assert } from "node:assert";
import { expandObject, settledPromiseValue, toRemoteValue } from "./serialize.ts";

function entriesOf(objectId: string) {
  const outcome = expandObject(objectId);
  assert.ok("entries" in outcome, `expected entries, got ${JSON.stringify(outcome)}`);
  return outcome.entries;
}

Deno.test("primitives carry no objectId", () => {
  for (const v of [1, "x", true, 7n, undefined, null, Symbol("s")]) {
    assert.equal(toRemoteValue(v).objectId, undefined);
  }
  // preview-only object types
  assert.equal(toRemoteValue(new Date(0)).objectId, undefined);
  assert.equal(toRemoteValue(/re/).objectId, undefined);
  assert.equal(toRemoteValue(Promise.resolve(1)).objectId, undefined);
});

Deno.test("settled promise: then/catch idiom, primitive carries no objectId", () => {
  const fulfilled = settledPromiseValue("fulfilled", 42);
  assert.equal(fulfilled.type, "promise");
  assert.equal(fulfilled.preview, "then 42");
  assert.equal(fulfilled.objectId, undefined);

  const rejected = settledPromiseValue("rejected", "boom");
  assert.equal(rejected.preview, 'catch "boom"');
  assert.equal(rejected.objectId, undefined);
});

Deno.test("settled promise: resolved object is expandable", () => {
  const remote = settledPromiseValue("fulfilled", { name: "Ada" });
  assert.ok(remote.objectId, "expandable resolved value should register an objectId");
  assert.deepEqual(
    entriesOf(remote.objectId).map((e) => [e.key, e.value.preview]),
    [["name", '"Ada"']],
  );
});

Deno.test("same object captured twice keeps one objectId", () => {
  const obj = { a: 1 };
  const first = toRemoteValue(obj);
  const second = toRemoteValue(obj);
  assert.ok(first.objectId);
  assert.equal(first.objectId, second.objectId);
});

Deno.test("object expansion: own props, in order", () => {
  const remote = toRemoteValue({ name: "Ada", year: 1815 });
  const entries = entriesOf(remote.objectId!);
  assert.deepEqual(
    entries.map((e) => [e.key, e.value.preview]),
    [["name", '"Ada"'], ["year", "1815"]],
  );
});

Deno.test("nested objects are expandable through entries", () => {
  const remote = toRemoteValue({ inner: { deep: true } });
  const [inner] = entriesOf(remote.objectId!);
  assert.equal(inner.value.type, "object");
  assert.ok(inner.value.objectId);
  const deep = entriesOf(inner.value.objectId!);
  assert.deepEqual(deep.map((e) => [e.key, e.value.preview]), [["deep", "true"]]);
});

Deno.test("array expansion: indices, overflow marker, length", () => {
  const remote = toRemoteValue(Array.from({ length: 150 }, (_, i) => i));
  const entries = entriesOf(remote.objectId!);
  assert.equal(entries.length, 102); // 100 indices + "…" + length
  assert.deepEqual(entries[0], { key: "0", value: { type: "number", preview: "0" } });
  assert.equal(entries[100]!.key, "…");
  assert.equal(entries[100]!.value.preview, "(+50 more)");
  assert.deepEqual(entries[101], { key: "length", value: { type: "number", preview: "150" } });
});

Deno.test("typed array expansion", () => {
  const remote = toRemoteValue(new Uint8Array([7, 9]));
  const entries = entriesOf(remote.objectId!);
  assert.deepEqual(
    entries.map((e) => [e.key, e.value.preview]),
    [["0", "7"], ["1", "9"], ["length", "2"]],
  );
});

Deno.test("map expansion: key previews, size; keys are not registered", () => {
  const keyObj = { k: 1 };
  const remote = toRemoteValue(new Map<unknown, unknown>([["a", 1], [keyObj, 2]]));
  const entries = entriesOf(remote.objectId!);
  assert.deepEqual(
    entries.map((e) => [e.key, e.value.preview]),
    [['"a"', "1"], ["{ k: 1 }", "2"], ["size", "2"]],
  );
});

Deno.test("set expansion: indices and size", () => {
  const remote = toRemoteValue(new Set(["x", "y"]));
  const entries = entriesOf(remote.objectId!);
  assert.deepEqual(
    entries.map((e) => [e.key, e.value.preview]),
    [["0", '"x"'], ["1", '"y"'], ["size", "2"]],
  );
});

Deno.test("error expansion: name/message/stack first", () => {
  const remote = toRemoteValue(new RangeError("boom"));
  const entries = entriesOf(remote.objectId!);
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.key, e.value.preview]), [
    ["name", '"RangeError"'],
    ["message", '"boom"'],
  ]);
  assert.equal(entries[2]!.key, "stack");
});

Deno.test("user getters are never invoked during expansion", () => {
  const trap = {};
  Object.defineProperty(trap, "boom", {
    get() {
      throw new Error("getter ran");
    },
    enumerable: true,
    configurable: true,
  });
  const remote = toRemoteValue(trap);
  const entries = entriesOf(remote.objectId!); // must not throw
  assert.deepEqual(entries, [
    { key: "boom", value: { type: "function", preview: "[Getter]" } },
  ]);
});

Deno.test("unknown id vs evicted id (LRU budget) — runs last", () => {
  const unknown = expandObject("o999999999");
  assert.deepEqual(unknown, { error: "unknown" });
  assert.deepEqual(expandObject("not-an-id"), { error: "unknown" });

  const victim = toRemoteValue({ victim: true });
  for (let i = 0; i < 10_000; i++) toRemoteValue({ i }); // flood past MAX_OBJECTS
  assert.deepEqual(expandObject(victim.objectId!), { error: "evicted" });

  // re-capturing an evicted object revives its (stable) id
  const revived = toRemoteValue({ victim: true });
  assert.ok("entries" in expandObject(revived.objectId!));
});
