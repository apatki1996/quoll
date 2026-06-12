// Phase 6: a project import must resolve and run. `double` comes from a sibling
// file; the entry runs as a data: URL, so its relative specifier is rewritten to
// an absolute file:// URL (resolve.ts) before the runner imports it.
import { double } from "../fixtures/util.ts";

const result = double(21); //== 42
