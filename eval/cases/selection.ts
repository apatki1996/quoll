//@values comments
// Phase 8/9: capture sites supplied by the CALLER (an editor selection, a
// VS Code breakpoint) instead of by a source comment. Quiet mode renders only
// opt-in lines, so each value below proves an anchor landed where it was
// aimed, and each bare `//==` proves none of them leaked onto a neighbour.
//@select 18:17  — inside the init `20 + 3`: the anchor claims that capture.
//@select 20:18  — inside `n * 10`: the INNERMOST capture wins, so
//   the enclosing `.map(...)` call stays quiet.
//@select 19:6   — on the NAME `named`, outside every capture span: falls back to line
//   granularity rather than revealing nothing at all.
//@logpoint 21      — a breakpoint marks a LINE, so the whole line opts in.
//@select 22:24  — the anchor's line carries a non-ASCII prefix:
//   its emoji are 4 bytes but 2 UTF-16 units each, so passing the editor's
//   column through as a byte offset would slip the anchor OUT of `s + "!"`
//   and reveal the enclosing `.map(...)` result instead of the two elements.

const quiet = 1 + 1; //==
const anchored = 20 + 3; //== 23
const named = 6 * 7; //== 42
[1, 2].map((n) => n * 10); //== 10, 20
const logged = 5 - 1; //~ covered //== 4
["🎯", "🎯"].map((s) => s + "!"); //== "🎯!", "🎯!"
const {
  first, //==
  second, //==
} = { first: 1, second: 2 }; //== { first: 1, second: 2 }
const left = 1; const right = 2; //== 2
//@select 24:4  — on a pattern name on a MIDDLE line of a destructuring, outside
//   every capture and on neither end line of one: the innermost STATEMENT's
//   own values answer, which the line fallback alone could never reach.
//@select 27:22 — on the NAME `right`: its statement answers, so `left` on the
//   same line stays quiet (the line fallback would reveal both).
