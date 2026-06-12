const start = "begin"; //=> "begin"
setTimeout(() => {
  const late = 40 + 2; //=> 42 //~ covered
}, 80);
const resolved = await Promise.resolve("tla"); //=> "tla"
