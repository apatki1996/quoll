const n = 3; //=> 3 //~ covered
if (n > 2) console.log("big"); //=> "big" //~ covered
if (n > 10) console.log("never"); //~ partial
for (let i = 0; i < 2; i++) console.log(i); //== 0, 0, 1 //~ covered
while (n < 0) console.log("nope"); //~ partial
