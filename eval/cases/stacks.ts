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

// An error's stack is where it was THROWN, not where it was reported.
function fail() {
  throw new Error("last"); //! last //^ fail < (top level)
}
fail();
