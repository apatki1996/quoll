import * as vscode from "vscode";
import { Commands, OUTPUT_CHANNEL, Views } from "./constants.ts";
import { ValueExplorer } from "./explorer/tree.ts";
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
  let editor = vscode.window.activeTextEditor;
  if (!editor) {
    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: SCRATCH_TEMPLATE,
    });
    editor = await vscode.window.showTextDocument(doc);
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
