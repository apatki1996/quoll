import * as assert from "node:assert";
import * as vscode from "vscode";

const EXTENSION_ID = "apatki.quoll";

/**
 * Smoke + glue tests: verify the VS Code wiring the Deno unit tests and the
 * golden eval harness can't reach — activation, command/view contributions,
 * config defaults, and the command entry points. The instrumentation,
 * aggregation, and serialization logic is covered elsewhere; nothing here
 * duplicates it.
 */
suite("Quoll extension", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("quoll.stop");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("activates", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.strictEqual(ext?.isActive, true);
  });

  test("declared commands are all registered", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const declared: string[] = ext!.packageJSON.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    const registered = await vscode.commands.getCommands(true);
    for (const command of declared) {
      assert.ok(registered.includes(command), `command not registered: ${command}`);
    }
    // Spot-check the three we depend on, in case the manifest is ever emptied.
    for (const command of ["quoll.start", "quoll.stop", "quoll.copyValue"]) {
      assert.ok(declared.includes(command), `command not declared in manifest: ${command}`);
    }
  });

  test("values view can be focused", async () => {
    // Resolves only if the quollValues view + its tree data provider are wired.
    await vscode.commands.executeCommand("quollValues.focus");
  });

  test("configuration defaults match the manifest", () => {
    const config = vscode.workspace.getConfiguration("quoll");
    assert.strictEqual(config.get("denoPath"), "deno");
    assert.strictEqual(config.get("debounceMs"), 300);
  });

  test("stop is a no-op when no session is running", async () => {
    // Must not throw even though nothing has been started.
    await vscode.commands.executeCommand("quoll.stop");
  });

  test("start with no active editor opens the scratch buffer", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const noEditorOpen = vscode.window.activeTextEditor === undefined;
    assert.ok(noEditorOpen, "expected no editor open");

    await vscode.commands.executeCommand("quoll.start");

    const editor = vscode.window.activeTextEditor;
    if (!editor) assert.fail("expected a scratch editor to open");
    assert.strictEqual(editor.document.languageId, "typescript");
    assert.ok(
      editor.document.getText().includes("Quoll scratch"),
      "scratch buffer should contain the template",
    );
  });
});
