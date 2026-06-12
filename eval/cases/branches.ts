const flag = true; //=> true //~ covered
const pick = flag ? "yes" : "no"; //=> "yes" //~ partial
const sc = flag || "unused"; //~ partial
const both = flag && "taken"; //=> "taken" //~ covered
const fallback = null ?? "default"; //=> "default" //~ covered
