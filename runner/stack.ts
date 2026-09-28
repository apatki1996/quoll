/**
 * The shadow call stack (phase 11): what the Timeline's function transitions
 * and stack traces are built from.
 *
 * The instrumented code drives it (see `crates/quoll-core/src/instrument.rs`):
 * every function body calls `enter` first and `leave` in a `finally`; inside an
 * async function or generator every `await`/`yield` is bracketed by `suspend`
 * and `resume`, because a suspended frame is NOT on the stack while other code
 * runs; and `cover` (already called before every statement) records where the
 * innermost frame is.
 *
 * Frames are per-CALL tokens, not function ids, so recursion and two
 * concurrent calls of one async function stay distinct. Every operation that
 * removes a frame truncates to BELOW it rather than popping blindly, and every
 * operation that restores one makes it the top rather than pushing blindly —
 * so a frame that somehow missed its exit can't leave the stack wrong for the
 * rest of the run: the next exit or resume beneath it cleans it up.
 */

import type { StackFrame, StackInfo } from "../protocol/index.ts";

/** Innermost frames sent per event. Deep recursion is the case this caps: a
 * 10k-deep stack on each of thousands of events would dwarf the values. */
export const MAX_FRAMES = 64;

export interface Frame {
  /** The `function` capture site. */
  readonly fn: number;
  /** Statement/branch site this frame most recently entered. */
  at?: number;
  /** For a bottom frame the MODULE BODY called: the top-level statement it
   * was called from. Absent when the event loop called it (a timer, a
   * promise reaction), which has no source position to show. */
  from?: number;
}

export class ShadowStack {
  private readonly frames: Frame[] = [];
  /** Snapshots taken where a value was THROWN, keyed by the thrown object. */
  private readonly thrown = new WeakMap<object, StackInfo>();
  /** Top-level statement currently executing, when the stack is empty. */
  private topAt: number | undefined;
  /**
   * Is the module body running right now? An empty stack means top-level code
   * OR the event loop, and only the first calls into anything from a
   * position. Set by top-level `cover` and `topResume`; cleared by
   * `topSuspend`, which the Rust pass puts at every top-level `await` and at
   * the end of the module. (A clear at the next microtask checkpoint backs
   * that up for a body that throws part-way — but only backs it up: once a
   * top-level `await` has resumed, the module runs INSIDE a microtask, and
   * reactions already queued would run before that clear.)
   */
  private topActive = false;
  private readonly defer: (cb: () => void) => void;

  /** `defer` must be the runtime's real `queueMicrotask`, captured before
   * user code can replace it. */
  constructor(defer: (cb: () => void) => void) {
    this.defer = defer;
  }

  enter(fn: number): Frame {
    const frame: Frame = { fn };
    if (this.frames.length === 0 && this.topActive) frame.from = this.topAt;
    this.frames.push(frame);
    return frame;
  }

  /** The body is done — returned, threw, or a generator was `.return()`ed.
   * A frame already suspended is simply not there, which is fine. */
  leave(frame: Frame): void {
    const i = this.frames.lastIndexOf(frame);
    if (i >= 0) this.frames.length = i;
  }

  /** Off the stack until it resumes. Returns `value` untouched: it's the
   * awaited/yielded operand, passed through. */
  suspend<T>(frame: Frame, value?: T): T | undefined {
    this.leave(frame);
    return value;
  }

  /** Back on top of whatever stack the resumption happens on. Returns the
   * awaited/sent value untouched. */
  resume<T>(frame: Frame, value: T): T {
    this.reenter(frame);
    return value;
  }

  /** Idempotent: make `frame` the top, pushing it only if it isn't there. */
  reenter(frame: Frame): void {
    const i = this.frames.lastIndexOf(frame);
    if (i >= 0) {
      this.frames.length = i + 1;
      return;
    }
    // Whatever called it when it ENTERED is gone: a resumed async function
    // runs on an empty stack, a resumed generator on its new caller's. So
    // `from` is decided afresh, exactly as `enter` decides it.
    if (this.frames.length === 0 && this.topActive) frame.from = this.topAt;
    else delete frame.from;
    this.frames.push(frame);
  }

  /**
   * The module body suspended at a top-level `await` (or finished): whatever
   * runs until it resumes was not called by it. Returns `value` untouched.
   */
  topSuspend<T>(value?: T): T | undefined {
    this.topActive = false;
    return value;
  }

  /** The module body resumed from a top-level `await`: calls it makes now
   * come from the statement it was suspended in. Returns `value` untouched. */
  topResume<T>(value: T): T {
    this.markTop();
    return value;
  }

  /** A statement or branch site was entered: that is where the top frame is. */
  cover(siteId: number): void {
    const top = this.frames[this.frames.length - 1];
    if (top) {
      top.at = siteId;
      return;
    }
    this.topAt = siteId;
    this.markTop();
  }

  /** The module body is running. The deferred clear is only a fallback now —
   * `topSuspend` clears it exactly — for a body that throws part-way. */
  private markTop(): void {
    if (this.topActive) return;
    this.topActive = true;
    this.defer(() => {
      this.topActive = false;
    });
  }

  /**
   * A throw is passing out of `frame`. The first frame to see a given object
   * is the one it was thrown from (or thrown through, if it was a primitive
   * a caller wrapped), so that snapshot is kept and later ones ignored —
   * by the time the error is REPORTED, the stack has already unwound.
   */
  unwind(frame: Frame, thrown: unknown): void {
    this.reenter(frame);
    // A throw leaving a frame the MODULE BODY called is about to land in the
    // module body — which, if it doesn't catch it, stops right there, and the
    // `topSuspend` at its end never runs. If it does catch it, the catch
    // block's first statement marks the body running again.
    if (this.frames[0] === frame && frame.from !== undefined) this.topActive = false;
    if ((typeof thrown === "object" && thrown !== null) || typeof thrown === "function") {
      if (!this.thrown.has(thrown)) this.thrown.set(thrown, this.snapshot());
    }
  }

  /** The stack where `err` was thrown; top level if it never left a frame. */
  thrownFrom(err: unknown): StackInfo {
    if ((typeof err === "object" && err !== null) || typeof err === "function") {
      return this.thrown.get(err) ?? {};
    }
    return {};
  }

  /** The stack right now, outermost first, as the protocol carries it. A
   * copy: `at` keeps moving after the event that asked is long gone. */
  snapshot(): StackInfo {
    const n = this.frames.length;
    if (n === 0) return {};
    const bottom = this.frames[0]!;
    const cut = Math.max(0, n - MAX_FRAMES);
    const out: StackFrame[] = [];
    if (cut === 0 && bottom.from !== undefined) out.push({ at: bottom.from });
    for (let i = cut; i < n; i++) {
      const { fn, at } = this.frames[i]!;
      out.push(at === undefined ? { fn } : { fn, at });
    }
    return cut === 0 ? { frames: out } : { frames: out, stackDepth: n };
  }
}
