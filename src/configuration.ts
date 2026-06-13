import * as vscode from "vscode";
import { EXTENSION_ID } from "./constants.ts";

/** Defaults declared once here; intended to match `package.json` `contributes.configuration`. */
const DEFAULTS = { denoPath: "deno", debounceMs: 300 } as const;

const section = () => vscode.workspace.getConfiguration(EXTENSION_ID);

/** Typed accessors over the `quoll` configuration section. */
export const config = {
  denoPath: () => section().get<string>("denoPath", DEFAULTS.denoPath),
  debounceMs: () => section().get<number>("debounceMs", DEFAULTS.debounceMs),
};
