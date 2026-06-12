function add(a: number, b: number): number {
  return a + b; //=> 5
}
const sum = add(2, 3); //=> 5 //~ covered

const square = (n: number): number => n * n;
const sq = square(4); //=> 16
