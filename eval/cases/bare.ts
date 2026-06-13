// Phase 6: bare specifiers resolve in the PROJECT's node_modules (fixture
// packages checked in under eval/cases/node_modules). The host rewrites bare →
// npm:<name>; the runner's --node-modules-dir=manual + cwd=projectRoot keeps
// resolution local-only (no global cache, no network). One CJS package (main
// field) and one ESM package (exports map) — the two shapes that matter.
import greeter from "quoll-cjs-greeter";
import { twice } from "quoll-esm-math";

const g = greeter.greet("quoll"); //== "hello quoll"
const t = twice(21); //== 42
