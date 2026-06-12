import * as vscode from "vscode";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Quoll");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("quoll.start", startOnCurrentFile),
  );
  output.appendLine("[quoll] activated");
}

export function deactivate(): void {}

const SCRATCH_TEMPLATE = `// Quoll scratch
const greeting = "hello quoll";
console.log(greeting);
`;

async function startOnCurrentFile(): Promise<void> {
  let editor = vscode.window.activeTextEditor;
  if (!editor) {
    const doc = await vscode.workspace.openTextDocument({
      language: "javascript",
      content: SCRATCH_TEMPLATE,
    });
    editor = await vscode.window.showTextDocument(doc);
  }
  output.appendLine(
    `[quoll] started on ${editor.document.fileName} (${editor.document.languageId})`,
  );
  output.show(true);
}
