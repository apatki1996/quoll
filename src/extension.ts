import * as vscode from "vscode";
import { Commands, EXTENSION_ID, OUTPUT_CHANNEL, Views } from "./constants.ts";
import { ValueExplorer } from "./explorer/tree.ts";
import { TimelineView } from "./timeline/view.ts";
import { detectDeno, probeDeno } from "./runner/deno.ts";
import { QuollSession } from "./session.ts";

let output: vscode.OutputChannel;
let extensionRoot: string;
let session: QuollSession | undefined;
let explorer: ValueExplorer;
let timeline: TimelineView;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  extensionRoot = context.extensionUri.fsPath;
  explorer = new ValueExplorer();
  timeline = new TimelineView();
  // A TreeView (not just a registered provider) because Explore Value reveals
  // the hovered site in it.
  const valuesView = vscode.window.createTreeView(Views.values, { treeDataProvider: explorer });
  explorer.setView(valuesView);
  context.subscriptions.push(
    output,
    explorer,
    timeline,
    vscode.window.registerWebviewViewProvider(Views.timeline, timeline),
    valuesView,
    vscode.commands.registerCommand(Commands.start, startOnCurrentFile),
    vscode.commands.registerCommand(Commands.stop, () => {
      stopSession();
      output.appendLine("[quoll] session stopped");
    }),
    vscode.commands.registerCommand(Commands.copyValue, (node: unknown) => {
      const text = explorer.copyText(node as Parameters<ValueExplorer["copyText"]>[0]);
      if (text !== undefined) void vscode.env.clipboard.writeText(text);
    }),
    vscode.commands.registerCommand(Commands.exploreValue, (siteId: number) =>
      explorer.reveal(siteId),
    ),
    // Time Machine (phase 10). No-ops without a session — the keybindings are
    // gated on the stepping context key, but the palette entries are not.
    vscode.commands.registerCommand(Commands.stepBack, () => session?.stepBy(-1)),
    vscode.commands.registerCommand(Commands.stepForward, () => session?.stepBy(1)),
    vscode.commands.registerCommand(Commands.live, () => session?.goLive()),
    // A Timeline click: park the Time Machine on that stop and scroll to the
    // line it happened on. Returns whether it landed.
    vscode.commands.registerCommand(Commands.goToStop, (index: number, generation?: number) =>
      goToStop(index, generation),
    ),
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
  timeline.setSession(session);
  output.show(true);
}

function stopSession(): void {
  session?.dispose();
  session = undefined;
  explorer.setSession(undefined);
  timeline.setSession(undefined);
}

/**
 * Park the Time Machine on a Timeline stop and reveal the line it happened on.
 *
 * `generation` is the run the caller's index belongs to. The Timeline is a
 * separate surface that can still be showing a previous run's rows — every
 * edit starts a new run — and an index that is merely IN RANGE for the new
 * tape would otherwise land on an unrelated event. Checking the index alone
 * only catches the case where the new run happens to be shorter.
 */
function goToStop(index: number, generation?: number): boolean {
  if (generation !== undefined && generation !== session?.runGeneration) return false;
  const row = session?.timelineRows()[index];
  if (!row) return false; // no session, or an index past this run's stops
  session!.stepTo(index);
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === session!.doc);
  if (editor && row.line >= 1 && row.line <= editor.document.lineCount) {
    const range = editor.document.lineAt(row.line - 1).range;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return true;
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
