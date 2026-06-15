import * as vscode from "vscode";
import { Commands, EXTENSION_ID, OUTPUT_CHANNEL, Views } from "./constants.ts";
import { ValueExplorer } from "./explorer/tree.ts";
import { detectDeno, probeDeno } from "./runner/deno.ts";
import { QuollSession } from "./session.ts";

let output: vscode.OutputChannel;
let extensionRoot: string;
let session: QuollSession | undefined;
let explorer: ValueExplorer;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  extensionRoot = context.extensionUri.fsPath;
  explorer = new ValueExplorer();
  context.subscriptions.push(
    output,
    explorer,
    vscode.window.registerTreeDataProvider(Views.values, explorer),
    vscode.commands.registerCommand(Commands.start, startOnCurrentFile),
    vscode.commands.registerCommand(Commands.stop, () => {
      stopSession();
      output.appendLine("[quoll] session stopped");
    }),
    vscode.commands.registerCommand(Commands.copyValue, (node: unknown) => {
      const text = explorer.copyText(node as Parameters<ValueExplorer["copyText"]>[0]);
      if (text !== undefined) void vscode.env.clipboard.writeText(text);
    }),
  );
  output.appendLine("[quoll] activated");
}

export function deactivate(): void {
  stopSession(); // silent teardown; logging here may race output disposal
}

const SCRATCH_TEMPLATE = `// Quoll scratch
const greeting = "hello quoll";
console.log(greeting);

setTimeout(() => console.log("…and later"), 50);
`;

async function startOnCurrentFile(): Promise<void> {
  // Open the target editor first — harmless without Deno, and it means a missing
  // binary surfaces as an actionable prompt next to a real buffer, not an empty
  // no-op. (It also keeps the command resolving promptly: awaiting the prompt
  // itself would hang a headless host where nothing dismisses it.)
  let editor = vscode.window.activeTextEditor;
  if (!editor) {
    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: SCRATCH_TEMPLATE,
    });
    editor = await vscode.window.showTextDocument(doc);
  }

  // Only spawn a run once we have a Deno. Detection is non-blocking; a miss
  // fires the actionable prompt WITHOUT awaiting it (the spawn ENOENT would
  // otherwise only land in the hidden output channel). resolveDenoPath persists
  // an auto-detected path to global settings, so the per-run config.denoPath()
  // read picks it up thereafter.
  const deno = await resolveDenoPath();
  if (!deno) {
    void promptForDeno();
    return;
  }
  session?.dispose();
  session = new QuollSession(editor.document, output, extensionRoot);
  explorer.setSession(session);
  output.show(true);
}

function stopSession(): void {
  session?.dispose();
  session = undefined;
  explorer.setSession(undefined);
}

const DENO_INSTALL_URL = "https://docs.deno.com/runtime/getting_started/installation/";

/**
 * Resolve a working Deno binary, or undefined when none is found. An
 * auto-detected path is persisted to GLOBAL (user) settings — `quoll.denoPath`
 * is `machine`-scoped, so that's the only place it can be set (a workspace can't
 * choose the sandbox binary), and where the per-run config read will then find
 * it. Non-blocking: it never shows UI, so the Start command can await it safely.
 */
async function resolveDenoPath(): Promise<string | undefined> {
  const section = vscode.workspace.getConfiguration(EXTENSION_ID);
  // Only a user (global) setting can pin the binary, so an explicit choice is
  // whatever the user themselves put there — not a workspace value.
  const explicit = section.inspect<string>("denoPath")?.globalValue;
  const resolved = await detectDeno(explicit ?? section.get<string>("denoPath", "deno"));
  // Persist only a real discovered path: re-writing the bare "deno" default (or
  // an already-explicit value) would just churn settings.json.
  if (resolved && resolved !== explicit && resolved !== "deno") {
    await section.update("denoPath", resolved, vscode.ConfigurationTarget.Global);
  }
  return resolved;
}

/**
 * Actionable "can't find Deno" notification. Fire-and-forget (callers `void`
 * it): awaiting a notification would hang a headless host, and on the happy
 * "Locate Deno…" path it re-runs Start itself once the path is saved.
 */
async function promptForDeno(): Promise<void> {
  const section = vscode.workspace.getConfiguration(EXTENSION_ID);
  const LOCATE = "Locate Deno…";
  const SETTINGS = "Open Settings";
  const INSTALL = "Install Deno";
  const pick = await vscode.window.showErrorMessage(
    "Quoll can't find Deno. It runs your code in a sandboxed Deno process — set the path to your Deno binary to continue.",
    LOCATE,
    SETTINGS,
    INSTALL,
  );
  if (pick === LOCATE) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Select Deno binary",
      title: "Locate the Deno executable",
    });
    const path = picked?.[0]?.fsPath;
    if (path && (await probeDeno(path))) {
      await section.update("denoPath", path, vscode.ConfigurationTarget.Global);
      void startOnCurrentFile(); // retry now that Deno resolves
    } else if (path) {
      void vscode.window.showErrorMessage(`That isn't a working Deno binary: ${path}`);
    }
  } else if (pick === SETTINGS) {
    void vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `${EXTENSION_ID}.denoPath`,
    );
  } else if (pick === INSTALL) {
    void vscode.env.openExternal(vscode.Uri.parse(DENO_INSTALL_URL));
  }
}
