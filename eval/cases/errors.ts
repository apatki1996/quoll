const ok = "ran"; //=> "ran" //~ covered
throw new Error("kaboom"); //! kaboom
const never = "unreached"; //~ uncovered
