import * as vscode from "vscode";
import { Commands } from "../constants.ts";
import type { TimelineRow } from "../render/aggregate.ts";
import type { QuollSession } from "../session.ts";

/**
 * Interactive Timeline (phase 11): the run as a list of moments, in the order
 * they happened, rather than by source line like the value explorer.
 *
 * It consumes the Time Machine's tape (`QuollSession.timelineRows`) and owns
 * nothing: row `i` is stop `i`, so clicking one is `stepTo(i)` and the whole
 * editor rewinds with it. A second recording would be a second truth.
 *
 * A webview rather than a TreeView because this is on the way to Quokka's
 * horizontal strip, which a tree cannot draw. Until that lands, the page owes
 * a tree's affordances by hand — so each row is a real `<button>`, and
 * keyboard and screen-reader support come from the platform, not from us.
 */
export class TimelineView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session: QuollSession | undefined;
  private sessionSub: vscode.Disposable | undefined;

  setSession(session: QuollSession | undefined): void {
    this.sessionSub?.dispose();
    this.session = session;
    this.sessionSub = session?.onDidUpdate(() => this.refresh());
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // No local resource roots: everything is inline, so the webview needs no
    // read access to the extension directory at all.
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: unknown) => {
      // Untrusted by construction (it's a web page): take the fields we expect
      // and nothing else. "ready" is the page saying it is listening — a
      // re-shown view is a new frame that can miss a post already in flight,
      // so it asks rather than waiting for the next run to redraw it.
      const { type, index, generation } = (msg ?? {}) as Record<string, unknown>;
      if (type === "ready") this.refresh();
      if (typeof index === "number" && typeof generation === "number") {
        void vscode.commands.executeCommand(Commands.goToStop, index, generation);
      }
    });
    view.onDidChangeVisibility(() => this.refresh()); // a hidden view drops its DOM
    this.refresh();
  }

  private refresh(): void {
    if (!this.view?.visible) return;
    const session = this.session;
    const update: { rows: TimelineRow[]; current: number; generation: number } = {
      rows: session?.timelineRows() ?? [],
      current: session?.currentStop ?? -1,
      // Stamped so a click from a run that has since been replaced is refused
      // rather than landing on an unrelated event (see `runGeneration`).
      generation: session?.runGeneration ?? -1,
    };
    // vscode's Webview.postMessage takes one argument, unlike window's.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    void this.view.webview.postMessage(update);
  }

  dispose(): void {
    this.sessionSub?.dispose();
  }
}

/**
 * The page. Inline script + style under a nonce CSP, no bundler entry and no
 * asset round-trip: it renders rows it is handed and posts back an index.
 * Colours come from the theme's own variables, so it follows the editor.
 */
function html(cspSource: string): string {
  const nonce = crypto.randomUUID();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0; margin: 0; }
  ol { list-style: none; margin: 0; padding: 0; }
  ol:empty::after { content: "Nothing recorded yet."; display: block; padding: 8px;
                    opacity: 0.7; }
  button { display: flex; gap: 8px; align-items: baseline; width: 100%; padding: 2px 8px;
           cursor: pointer; white-space: nowrap; text-align: left; background: none;
           border: none; color: inherit; font: inherit; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button[aria-current="true"] { background: var(--vscode-list-activeSelectionBackground);
                                color: var(--vscode-list-activeSelectionForeground); }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%;
         background: var(--vscode-charts-foreground); }
  .dot.value { background: var(--vscode-charts-blue); }
  .dot.perf { background: var(--vscode-charts-purple); }
  .dot.error { background: var(--vscode-charts-red); }
  .line { flex: none; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .preview { overflow: hidden; text-overflow: ellipsis; }
  .at { flex: none; margin-left: auto; opacity: 0.5; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<ol id="rows" aria-label="Quoll timeline"></ol>
<script nonce="${nonce}">
  const list = document.getElementById("rows");
  const vscodeApi = acquireVsCodeApi();
  let generation = -1;

  window.addEventListener("message", (event) => {
    const data = event.data ?? {};
    generation = data.generation ?? -1;
    render(data.rows ?? [], data.current ?? -1);
  });

  // Rows are updated IN PLACE and the tail trimmed, never rebuilt: a run can
  // record thousands of stops, and replacing every node on every update throws
  // away scroll position and keyboard focus along with the nodes.
  function render(rows, current) {
    while (list.children.length > rows.length) list.lastElementChild.remove();
    while (list.children.length < rows.length) list.append(newRow());
    rows.forEach((row, index) => fill(list.children[index], row, index === current));
    const active = list.querySelector('[aria-current="true"]');
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function newRow() {
    const li = document.createElement("li");
    const button = document.createElement("button");
    // A real button, so Enter/Space, focus and the screen-reader role are the
    // platform's job. The handler reads its own position at click time, so a
    // reused node never carries a stale index.
    button.append(span("dot"), span("line"), span("preview"), span("at"));
    button.addEventListener("click", () => {
      vscodeApi.postMessage({ index: [...list.children].indexOf(li), generation });
    });
    li.append(button);
    return li;
  }

  function fill(li, row, isCurrent) {
    const button = li.firstElementChild;
    const [dot, line, preview, at] = button.children;
    dot.className = "dot " + row.kind;
    line.textContent = row.line ? "L" + row.line : "";
    preview.textContent = row.preview; // textContent, never innerHTML: user value
    at.textContent = row.elapsedMs + "ms";
    button.setAttribute("aria-current", String(isCurrent));
    button.setAttribute(
      "aria-label",
      (row.line ? "Line " + row.line + ", " : "") + row.kind + ": " + row.preview,
    );
  }

  function span(className) {
    const el = document.createElement("span");
    el.className = className;
    return el;
  }

  // A re-shown view is a fresh frame that may have missed a post in flight.
  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
