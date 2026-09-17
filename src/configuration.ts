import * as vscode from "vscode";
import { EXTENSION_ID } from "./constants.ts";
import type { ValuesMode } from "./render/aggregate.ts";

/** Defaults declared once here; intended to match `package.json` `contributes.configuration`. */
const DEFAULTS = {
  denoPath: "deno",
  debounceMs: 300,
  values: "all",
  runTimeoutMs: 10_000,
  runtime: "node",
} as const;

/** `node` = plain Deno; `browser` = a jsdom window installed as globals. */
export type Runtime = "node" | "browser";

const section = () => vscode.workspace.getConfiguration(EXTENSION_ID);

/** Typed accessors over the `quoll` configuration section. */
export const config = {
  denoPath: () => section().get<string>("denoPath", DEFAULTS.denoPath),
  debounceMs: () => section().get<number>("debounceMs", DEFAULTS.debounceMs),
  values: () => section().get<ValuesMode>("values", DEFAULTS.values),
  runTimeoutMs: () => section().get<number>("runTimeoutMs", DEFAULTS.runTimeoutMs),
  runtime: () => section().get<Runtime>("runtime", DEFAULTS.runtime),
};
