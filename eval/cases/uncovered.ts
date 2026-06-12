const cond = false; //=> false //~ covered
if (cond) {
  console.log("never"); //~ uncovered
}
function unused(): string {
  return "dead"; //~ uncovered
}
console.log("after"); //=> "after" //~ covered
