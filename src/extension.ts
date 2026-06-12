import * as vscode from "vscode";
import type { RunnerMsg } from "../protocol/index.ts";
import { startRun, type RunHandle } from "./runner/client.ts";

let output: vscode.OutputChannel;
let runnerMain: string;

let currentRunId = 0;
let currentRun: RunHandle | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Quoll");
  runnerMain = context.asAbsolutePath("runner/main.ts");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("quoll.start", startOnCurrentFile),
    new vscode.Disposable(() => currentRun?.cancel()),
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
  runDocument(editor.document);
  output.show(true);
}

function runDocument(doc: vscode.TextDocument): void {
  currentRun?.cancel();
  const runId = ++currentRunId;
  const denoPath = vscode.workspace.getConfiguration("quoll").get<string>("denoPath", "deno");

  output.appendLine(`[quoll] run #${runId} ${doc.fileName}`);
  currentRun = startRun({
    denoPath,
    runnerMain,
    runId,
    code: doc.getText(),
    entry: doc.fileName,
    onMessage: handleRunnerMsg,
    onDiagnostic: (text) => output.appendLine(`[runner] ${text}`),
  });
}

function handleRunnerMsg(msg: RunnerMsg): void {
  if (msg.runId !== currentRunId) return; // stale run
  switch (msg.t) {
    case "console":
      output.appendLine(msg.args.map((a) => a.preview).join(" "));
      break;
    case "error":
      output.appendLine(`✗ ${msg.message}`);
      if (msg.stack) output.appendLine(msg.stack);
      break;
    case "done":
      output.appendLine(`[quoll] done in ${msg.durationMs}ms`);
      break;
    case "exit":
      if (msg.reason !== "complete") output.appendLine(`[quoll] exit: ${msg.reason}`);
      break;
    default:
      // value/perf/cover (phase 4+), expandResult (phase 5).
      break;
  }
}
