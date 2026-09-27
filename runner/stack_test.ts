// Shadow call stack unit tests: `mise exec -- deno test runner/`
import { strict as assert } from "node:assert";
import { MAX_FRAMES, ShadowStack } from "./stack.ts";

/** A stack whose microtask checkpoint the test fires by hand. */
function manual(): { stack: ShadowStack; checkpoint: () => void } {
  let queued: (() => void)[] = [];
  const stack = new ShadowStack((cb) => queued.push(cb));
  return {
    stack,
    checkpoint: () => {
      const run = queued;
      queued = [];
      for (const cb of run) cb();
    },
  };
}

Deno.test("nested calls snapshot outermost first, with where each frame is", () => {
  const { stack } = manual();
  const outer = stack.enter(1);
  stack.cover(10);
  stack.enter(2);
  stack.cover(20);
  assert.deepEqual(stack.snapshot(), {
    frames: [
      { fn: 1, at: 10 },
      { fn: 2, at: 20 },
    ],
  });
  stack.leave(stack.enter(3)); // a call that returned leaves nothing behind
  stack.cover(21);
  assert.deepEqual(stack.snapshot(), {
    frames: [
      { fn: 1, at: 10 },
      { fn: 2, at: 21 },
    ],
  });
  stack.leave(outer); // leaving a frame drops anything left above it too
  assert.deepEqual(stack.snapshot(), {});
});

Deno.test("a snapshot is a copy: later statements don't rewrite it", () => {
  const { stack } = manual();
  stack.enter(1);
  stack.cover(10);
  const taken = stack.snapshot();
  stack.cover(11);
  assert.deepEqual(taken, { frames: [{ fn: 1, at: 10 }] });
});

Deno.test("a call from the module body records the top-level statement", () => {
  const { stack } = manual();
  stack.cover(5); // top-level statement
  stack.enter(1);
  assert.deepEqual(stack.snapshot(), { frames: [{ at: 5 }, { fn: 1 }] });
});

Deno.test("after the microtask checkpoint, an empty-stack call came from the event loop", () => {
  const { stack, checkpoint } = manual();
  stack.cover(5);
  checkpoint(); // module body finished; a timer fires later
  stack.enter(1);
  assert.deepEqual(stack.snapshot(), { frames: [{ fn: 1 }] });
});

Deno.test("a suspended frame is off the stack; resuming puts it on the new one", () => {
  const { stack, checkpoint } = manual();
  stack.cover(5);
  const asyncFn = stack.enter(1);
  assert.equal(stack.suspend(asyncFn, "awaited"), "awaited"); // passes the operand through
  const sibling = stack.enter(2); // called from the module body while 1 awaits
  assert.deepEqual(stack.snapshot(), { frames: [{ at: 5 }, { fn: 2 }] });
  stack.leave(sibling);
  checkpoint(); // the module body is done; the await's reaction runs
  // Resumed from a microtask: nothing is beneath it — not even the top-level
  // statement that originally called it.
  assert.equal(stack.resume(asyncFn, 42), 42);
  assert.deepEqual(stack.snapshot(), { frames: [{ fn: 1 }] });
});

Deno.test("reenter is idempotent and never duplicates a frame", () => {
  const { stack } = manual();
  const f = stack.enter(1);
  stack.reenter(f);
  stack.reenter(f);
  assert.deepEqual(stack.snapshot(), { frames: [{ fn: 1 }] });
});

Deno.test("an error keeps the stack of its THROW, not of its report", () => {
  const { stack } = manual();
  const outer = stack.enter(1);
  const inner = stack.enter(2);
  const err = new Error("x");
  stack.unwind(inner, err);
  stack.leave(inner);
  stack.unwind(outer, err); // rethrown through: the first snapshot wins
  stack.leave(outer);
  assert.deepEqual(stack.thrownFrom(err), { frames: [{ fn: 1 }, { fn: 2 }] });
  assert.deepEqual(stack.thrownFrom("a primitive has no identity"), {});
  assert.deepEqual(stack.thrownFrom(new Error("never thrown through a frame")), {});
});

Deno.test("deep recursion sends the innermost frames and the real depth", () => {
  const { stack } = manual();
  stack.cover(5);
  for (let i = 0; i < MAX_FRAMES + 10; i++) stack.enter(1);
  const { frames, stackDepth } = stack.snapshot();
  assert.equal(frames?.length, MAX_FRAMES);
  assert.ok(
    frames?.every((f) => f.fn === 1),
    "the top-level position is cut with the outer frames",
  );
  assert.equal(stackDepth, MAX_FRAMES + 10);
});
