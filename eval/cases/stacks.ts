// Phase 11 call stacks. Every function body is framed (enter / try / finally
// leave), and an await or yield takes its frame OFF the stack while suspended.
// The //=> values prove the framing changes nothing the program can see; the
// //^ stacks (innermost first) prove the frames are right.

function inner(n: number) {
  return n * 2; //=> 6 //^ inner < outer < (top level)
}
function outer(n: number) {
  return inner(n) + 1; //=> 7 //^ outer < (top level)
}
const r = outer(3); //=> 7 //^ (top level)

const tens = [1, 2].map((x) =>
  x * 10, //=> 20 //^ (anonymous) < (top level)
);
const named = (s: string) => s.toUpperCase(); //=> "OK" //^ named < (top level)
named("ok");

function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1); //=> 6 //^ fact < (top level)
}
fact(3);

// `this`, `arguments` and the return value survive the wrapping.
function count() {
  return arguments.length; //=> 3
}
count(1, 2, 3);

class Base {
  constructor(readonly v: number) {}
}
class Box extends Base {
  constructor(v: number) {
    super(v);
  }
  scale(k: number) {
    return this.v * k; //=> 12 //^ Box.scale < (top level)
  }
}
new Box(4).scale(3);

// A suspended frame is off the stack: `sync` runs while `slow` awaits, and
// must not be reported as running inside it. After resuming from a microtask
// the stack is just the async function — nothing called it from there.
async function slow() {
  await null;
  return "slow"; //=> "slow" //^ slow
}
function sync() {
  return "sync"; //=> "sync" //^ sync < (top level)
}
slow();
sync();

// A rejected await lands in `catch` without passing through `resume`.
async function recover() {
  try {
    await Promise.reject(new Error("no"));
  } catch {
    return "recovered"; //=> "recovered" //^ recover
  }
}
recover();

// `for await` resumes each iteration, and after the loop, from implicit awaits.
async function drain() {
  let total = 0;
  for await (const v of [1, 2]) {
    total += v; //=> 3 //^ drain
  }
  return total; //=> 3 //^ drain
}
drain();

// A generator resumes on its CALLER's stack.
function* pair() {
  const sent = yield 1;
  return sent; //=> "hi" //^ pair < (top level)
}
const it = pair();
it.next();
it.next("hi");

// `.throw()` resumes a generator into its catch, on the caller's stack —
// again without passing through `resume`.
function* guarded() {
  try {
    yield 1;
  } catch (e) {
    return "caught " + e; //=> "caught x" //^ guarded < (top level)
  }
}
const gi = guarded();
gi.next();
gi.throw("x");

// An async generator drained by `for await`, with a labelled `continue`.
async function* ticks() {
  yield 1;
  await null;
  yield 2;
}
async function consume() {
  const out: number[] = [];
  loop: for await (const v of ticks()) {
    if (v === 1) continue loop;
    out.push(v);
  }
  return out; //=> [ 2 ] //^ consume
}
consume();

// Reactions and timers run from the event loop, not from the module body.
Promise.resolve(3).then((v) =>
  v + 1, //=> 4 //^ (anonymous)
);
setTimeout(function tick() {
  const t = 1 + 1; //=> 2 //^ tick
}, 1);

// A body's function declarations stay function-scoped under the framing: in a
// block, `var` + `function` of one name would be a redeclaration error.
function shadowed() {
  var g = 1;
  function g() {}
  return g; //=> 1
}
shadowed();

// Implicit awaits suspend too. Each probe runs while one of these is
// suspended, so the suspended function must be missing from its stack.
// An async generator's `return x` awaits x before finishing.
async function* returnsLate() {
  return new Promise((ok) => setTimeout(ok, 5));
}
function probeReturn() {
  return 1; //^ probeReturn < (top level)
}
returnsLate().next();
probeReturn();
// `await using` awaits its disposal at the end of the block.
async function disposes() {
  await using res = {
    async [Symbol.asyncDispose]() {
      await new Promise((ok) => setTimeout(ok, 5));
    },
  };
  return 1;
}
// The `await using` rewrite nests the rest of the block, so it must never
// change what a name means: a closure reading a later `const` keeps working
// (the rewrite stands down), and a later function declaration stays hoisted.
async function keepsScope() {
  const read = () => late;
  await using res = { async [Symbol.asyncDispose]() {} };
  const late = "late";
  return read(); //=> "late"
}
keepsScope();
async function keepsHoisting() {
  const early = helper();
  await using res = { async [Symbol.asyncDispose]() {} };
  function helper() {
    return "hoisted";
  }
  return early; //=> "hoisted"
}
keepsHoisting();
function probeDispose() {
  return 1; //^ probeDispose < (top level)
}
disposes();
probeDispose();

// Leaving a `for await` for an OUTER label still resumes the frame.
async function breaksOut() {
  outer: {
    for await (const x of [1, 2]) {
      break outer;
    }
  }
  return "after"; //=> "after" //^ breaksOut
}
breaksOut();

// After a top-level await the module body runs inside a microtask. A reaction
// queued before it resumed was not called by it…
function fromReaction() {
  return 2; //=> 2 //^ fromReaction < (anonymous)
}
await null;
const settled = Promise.resolve();
settled.then(() => 0).then(() => fromReaction());
await settled;
// …while a call made by the resumed statement itself was.
function fromResumed(v: number) {
  return v; //=> 5 //^ fromResumed < (top level)
}
const resumed = fromResumed(await 5);

// An error's stack is where it was THROWN, not where it was reported.
function fail() {
  throw new Error("last"); //! last //^ fail < (top level)
}
fail();
