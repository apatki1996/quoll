import * as vscode from "vscode";
import { QuollSession } from "./session.ts";

let output: vscode.OutputChannel;
let extensionRoot: string;
let session: QuollSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Quoll");
  extensionRoot = context.extensionUri.fsPath;
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("quoll.start", startOnCurrentFile),
    vscode.commands.registerCommand("quoll.stop", stopSession),
    new vscode.Disposable(stopSession),
  );
  output.appendLine("[quoll] activated");
}

export function deactivate(): void {}

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
  output.show(true);
}

function stopSession(): void {
  session?.dispose();
  session = undefined;
  output.appendLine("[quoll] session stopped");
}
