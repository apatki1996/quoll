import * as assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
    // Spot-check the ones we depend on, in case the manifest is ever emptied.
    for (const command of ["quoll.start", "quoll.stop", "quoll.copyValue", "quoll.stepBack"]) {
      assert.ok(declared.includes(command), `command not declared in manifest: ${command}`);
    }
  });

  test("values view can be focused", async () => {
    // Resolves only if the quollValues view + its tree data provider are wired.
    await vscode.commands.executeCommand("quollValues.focus");
  });

  test("timeline view can be focused", async () => {
    // Resolves only if quollTimeline + its webview provider are registered.
    await vscode.commands.executeCommand("quollTimeline.focus");
  });

  test("configuration defaults match the manifest", () => {
    const config = vscode.workspace.getConfiguration("quoll");
    assert.strictEqual(config.get("denoPath"), "deno");
    assert.strictEqual(config.get("debounceMs"), 300);
    assert.strictEqual(config.get("values"), "all");
    // Also duplicated in src/configuration.ts DEFAULTS and, as the fallback
    // for a missing/garbage argv, in runner/main.ts. Drift is what this asserts.
    assert.strictEqual(config.get("runTimeoutMs"), 10_000);
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

  // The only test that needs a real run: hover values come from the live
  // Aggregator, so this covers the whole path (run → capture → siteAt → hover)
  // that neither the Deno unit tests (no vscode) nor the eval harness (no
  // editor) can reach. It therefore needs the native core AND Deno — the
  // cross-OS matrix has neither, so there it skips and the ubuntu job that
  // builds both runs it for real.
  test("hover shows the value captured at that expression", async function () {
    if (!hasNativeCore()) return this.skip();
    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: "const answer = 6 * 7;\n",
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("quoll.start");

    const inside = new vscode.Position(0, 16); // inside `6 * 7`
    const hover = await waitFor(async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        inside,
      );
      return hovers.find((h) => hoverText(h).includes("42"));
    });
    assert.ok(hover, "expected a Quoll hover showing 42");
    // The hover's Explore Value link carries the site id; following it must
    // actually reveal that site in the tree. The command reports whether it
    // landed, so a lost root, a missing view, or a dropped id fails here
    // instead of silently doing nothing.
    const siteId = hoverText(hover).match(/exploreValue\?%5B(\d+)%5D/)?.[1];
    assert.ok(siteId, "hover should offer an Explore Value command link");
    const revealed = await vscode.commands.executeCommand<boolean>(
      "quoll.exploreValue",
      Number(siteId),
    );
    assert.strictEqual(revealed, true, "Explore Value should reveal the site in the values tree");
  });

  // Time Machine (phase 10): stepping back re-renders the run from a PREFIX of
  // its event log. Asserted through the hover, the only stepped surface a test
  // can read back (editor decorations aren't queryable from the host), which
  // also proves the step moves more than the inline values.
  test("stepping back rewinds captured values; live restores them", async function () {
    if (!hasNativeCore()) return this.skip();
    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: "const doubled = [1, 2, 3].map((n) => n * 2);\n",
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("quoll.start");

    const inside = new vscode.Position(0, 39); // inside the callback's `n * 2`
    const live = await waitFor(async () => {
      const text = await hoverAt(doc, inside);
      return text?.includes("6") ? text : undefined;
    });
    assert.ok(live, "expected the map callback's captures (2, 4, 6) in a hover");

    // The run's last event isn't necessarily this site's, so step until this
    // site actually loses its last capture — bounded, it's a handful of events.
    let rewound: string | undefined;
    for (let i = 0; i < 20 && rewound === undefined; i++) {
      await vscode.commands.executeCommand("quoll.stepBack");
      const text = await hoverAt(doc, inside);
      if (text !== undefined && !text.includes("6")) rewound = text;
    }
    assert.ok(rewound, `stepping back never dropped a capture (still: ${live})`);

    await vscode.commands.executeCommand("quoll.live");
    const restored = await hoverAt(doc, inside);
    assert.ok(restored?.includes("6"), `resuming live should restore the run (got: ${restored})`);
  });

  // Timeline (phase 11) rides on the same tape: clicking a row is the command
  // asserted here, and it must park the Time Machine on that stop — which the
  // hover then reads back. The row-building itself is unit-tested in
  // src/render/aggregate_test.ts (no vscode needed).
  test("a timeline stop parks the Time Machine on that frame", async function () {
    if (!hasNativeCore()) return this.skip();
    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: "const doubled = [1, 2, 3].map((n) => n * 2);\n",
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("quoll.start");

    const inside = new vscode.Position(0, 39); // inside the callback's `n * 2`
    const live = await waitFor(async () => {
      const text = await hoverAt(doc, inside);
      return text?.includes("6") ? text : undefined;
    });
    assert.ok(live, "expected the map callback's captures before jumping");

    // Stop 0 is the run's first recorded value, so the callback cannot have
    // produced its last capture yet.
    const landed = await vscode.commands.executeCommand<boolean>("quoll.goToStop", 0);
    assert.strictEqual(landed, true, "goToStop should report that it landed");
    const atFirstStop = await hoverAt(doc, inside);
    assert.ok(
      atFirstStop === undefined || !atFirstStop.includes("6"),
      `the first stop should predate the last capture (got: ${atFirstStop})`,
    );

    // An index from no run at all is refused rather than throwing.
    await vscode.commands.executeCommand("quoll.stop");
    const afterStop = await vscode.commands.executeCommand<boolean>("quoll.goToStop", 0);
    assert.strictEqual(afterStop, false, "goToStop should refuse when no session is running");
  });
});

/**
 * Without the napi binary the pipeline falls back to identity instrumentation
 * (no capture sites, so no values and no hover) — a skip, not a failure.
 *
 * The skip is the one way this test could quietly stop testing anything, so
 * the CI job that DOES build the core sets QUOLL_REQUIRE_NATIVE=1: there, a
 * missing binary is a failure. Otherwise a renamed build output would leave
 * the only end-to-end editor test silently skipped and CI green.
 */
function hasNativeCore(): boolean {
  const root = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
  const found =
    root !== undefined &&
    existsSync(join(root, "native", `quoll-core.${process.platform}-${process.arch}.node`));
  if (!found && process.env.QUOLL_REQUIRE_NATIVE === "1") {
    assert.fail("QUOLL_REQUIRE_NATIVE=1 but the native core is missing — did build:core move?");
  }
  return found;
}

/** Quoll's hover at a position (the one carrying the Explore value link). */
async function hoverAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<string | undefined> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    doc.uri,
    position,
  );
  const hover = hovers.find((h) => hoverText(h).includes("Explore value"));
  return hover && hoverText(hover);
}

function hoverText(hover: vscode.Hover): string {
  return hover.contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n");
}

/** Poll until `attempt` yields something, or give up (a run takes ~a second). */
async function waitFor<T>(attempt: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
