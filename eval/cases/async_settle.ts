// Async settle (DECISIONS.md 2026-06-12, gaps 1 & 2): a Promise that resolves
// via a timer must show its SETTLED value, not the pending wrapper. Quokka
// waits for the outstanding timer and shows the then-value; Quoll captures `p`
// once as a pending wrapper and re-emits when it settles.
//
// The expectations below use EXACT match (not containment) so that re-introduced
// append-noise (a pending wrapper left in front of the settled value) FAILS — a
// containment check would pass on "<pending>, then 42" and hide the regression.
// Timer kept short (80ms) so the harness stays fast; the runner already waits
// this long (see async.ts), so the only piece under test is settlement re-emit.
const p = new Promise((resolve) => { //== then 42
  setTimeout(() => resolve(42), 80);
});
const settled = await p; //== 42
