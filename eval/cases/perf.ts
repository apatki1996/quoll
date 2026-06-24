// Phase 8: `//?.` perf timing. The annotated line renders a `⏱ <n>ms` timing
// instead of the value; the duration itself is non-deterministic, so assert
// only the timing marker is present (contains, not exact).
function sum(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += i;
  return total;
}

const slow = sum(50000); //?. //=> ⏱
const plain = sum(1); //=> 0

// A perf line is still covered (timing and coverage are independent sites).
slow + plain; //~ covered
