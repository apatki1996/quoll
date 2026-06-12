interface Point {
  x: number;
  y: number;
}
enum Color {
  Red,
  Green,
}
const p: Point = { x: 1, y: 2 }; //=> { x: 1, y: 2 }
const c: Color = Color.Green; //=> 1
function dist<T extends Point>(pt: T): number {
  return pt.x + pt.y; //=> 3
}
const d = dist(p); //=> 3 //~ covered
