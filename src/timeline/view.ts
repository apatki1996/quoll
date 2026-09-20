import * as vscode from "vscode";
import { Commands } from "../constants.ts";
import type { QuollSession, TimelineRow } from "../session.ts";

/**
 * Interactive Timeline (phase 11): the run as a list of moments, in the order
 * they happened, rather than by source line like the value explorer.
 *
 * It consumes the Time Machine's tape (`QuollSession.timelineRows`) and owns
 * nothing: row `i` is stop `i`, so clicking one is `stepTo(i)` and the whole
 * editor rewinds with it. A second recording would be a second truth.
 *
 * A webview rather than a TreeView because the point of a timeline is the
 * SHAPE of a run — each row keyed to its kind and offset in time. A tree of
 * the same events sorted differently would just be the explorer again.
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
      // Untrusted by construction (it's a web page): take one number and
      // nothing else, and let the session bounds-check it.
      const index = (msg as { index?: unknown } | undefined)?.index;
      if (typeof index === "number" && Number.isInteger(index)) this.goTo(index);
    });
    view.onDidChangeVisibility(() => this.refresh()); // a hidden view drops its DOM
    this.refresh();
  }

  /** One command does both halves (step + reveal), so the webview's click and
   * a test's `executeCommand` take exactly the same path. */
  private goTo(index: number): void {
    void vscode.commands.executeCommand(Commands.goToStop, index);
  }

  private refresh(): void {
    if (!this.view?.visible) return;
    const rows = this.session?.timelineRows() ?? [];
    // This is vscode's Webview.postMessage, which takes one argument — not the
    // window.postMessage the rule is about.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    void this.view.webview.postMessage({ rows } satisfies { rows: TimelineRow[] });
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
  const nonce = nonceString();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0; margin: 0; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 8px; align-items: baseline; padding: 2px 8px; cursor: pointer;
       white-space: nowrap; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li.current { background: var(--vscode-list-activeSelectionBackground);
               color: var(--vscode-list-activeSelectionForeground); }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
  .value { background: var(--vscode-charts-blue); }
  .console { background: var(--vscode-charts-foreground); }
  .perf { background: var(--vscode-charts-purple); }
  .error { background: var(--vscode-charts-red); }
  .line { flex: none; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .preview { overflow: hidden; text-overflow: ellipsis; }
  .at { flex: none; margin-left: auto; opacity: 0.5; font-variant-numeric: tabular-nums; }
  .empty { padding: 8px; opacity: 0.7; }
</style>
</head>
<body>
<ol id="rows"></ol>
<p class="empty" id="empty">Nothing recorded yet.</p>
<script nonce="${nonce}">
  const list = document.getElementById("rows");
  const empty = document.getElementById("empty");
  const vscodeApi = acquireVsCodeApi();

  window.addEventListener("message", (event) => {
    const rows = event.data?.rows ?? [];
    empty.hidden = rows.length > 0;
    list.replaceChildren(...rows.map(row));
    const current = list.querySelector(".current");
    if (current) current.scrollIntoView({ block: "nearest" });
  });

  function row(r) {
    const li = document.createElement("li");
    li.className = r.current ? "current" : "";
    li.append(span("dot " + r.kind, ""), span("line", r.line ? "L" + r.line : ""),
              span("preview", r.preview), span("at", r.elapsedMs + "ms"));
    li.addEventListener("click", () => vscodeApi.postMessage({ index: r.index }));
    return li;
  }

  // textContent, never innerHTML: a preview is a user value, not markup.
  function span(className, text) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }
</script>
</body>
</html>`;
}

function nonceString(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
