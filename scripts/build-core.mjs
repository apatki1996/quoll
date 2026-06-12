// Builds the Rust core and places the napi binary where the extension loads it:
// native/quoll-core.<platform>-<arch>.node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crate = join(root, "crates", "quoll-core");

execFileSync("cargo", ["build", "--release"], { cwd: crate, stdio: "inherit" });

const ext = { darwin: "dylib", linux: "so", win32: "dll" }[process.platform];
const prefix = process.platform === "win32" ? "" : "lib";
const built = join(crate, "target", "release", `${prefix}quoll_core.${ext}`);
const out = join(root, "native", `quoll-core.${process.platform}-${process.arch}.node`);

mkdirSync(join(root, "native"), { recursive: true });
copyFileSync(built, out);
console.log(`core → ${out}`);
