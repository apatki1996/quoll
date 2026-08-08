// Phase 6: a project import must resolve and run. `double` comes from a sibling
// file; the entry runs as a data: URL, so its relative specifier is rewritten to
// an absolute file:// URL (resolve.ts) before the runner imports it.
import { double } from "./fixtures/util.ts";

const result = double(21); //== 42

// A re-export's specifier sits in a different AST node than a plain import and
// must be rewritten too — an unresolved one fails the data: URL entry outright.
export { double as twice } from "./fixtures/util.ts";

// Regression (AST-level rewrite): a string literal that merely LOOKS like an
// import must never be rewritten — under the old regex tier this line's value
// would have had its "./fixtures/util.ts" swapped for a file:// URL.
const trap = 'import { x } from "./fixtures/util.ts"'; //=> import { x } from "./fixtures/util.ts"

// And a string whose ENTIRE value is a resolvable specifier: only literals in
// import positions may be rewritten, never matching values elsewhere.
const spec = "./fixtures/util.ts"; //== "./fixtures/util.ts"
