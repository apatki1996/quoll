import * as vscode from "vscode";
import { Commands } from "../constants.ts";
import type { StackTrace, TimelineRow } from "../render/aggregate.ts";
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
 *
 * The function dimension: each row carries the call it happened in, so the
 * page colours a band by function, indents by depth and names the function
 * where the call changes; the stop the Time Machine is parked on gets its
 * full stack trace beside the list, each frame a jump to its line.
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
      const { type, index, line, generation } = (msg ?? {}) as Record<string, unknown>;
      if (type === "ready") this.refresh();
      if (typeof generation !== "number") return;
      if (type === "frame" && typeof line === "number") {
        // A stack frame: show where it is, without moving the Time Machine —
        // the trace belongs to the stop it's parked on.
        if (generation === this.session?.runGeneration) revealLine(this.session.doc, line);
      } else if (typeof index === "number") {
        void vscode.commands.executeCommand(Commands.goToStop, index, generation);
      }
    });
    view.onDidChangeVisibility(() => this.refresh()); // a hidden view drops its DOM
    this.refresh();
  }

  private refresh(): void {
    if (!this.view?.visible) return;
    const session = this.session;
    const current = session?.currentStop;
    const update: {
      rows: TimelineRow[];
      current: number;
      trace: StackTrace | undefined;
      generation: number;
    } = {
      rows: session?.timelineRows() ?? [],
      current: current ?? -1,
      // Only the parked stop's: a trace per row would ship every stack of a
      // 5000-stop run on every update, to show one of them.
      trace: current === undefined ? undefined : session?.stackTraceAt(current),
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
 * Scroll a line of `doc` into view, if it's visible — a Timeline row's jump
 * and a stack frame's. It does NOT move the cursor: a selection change is an
 * input to the session (value-on-selection), and in quiet mode could start a
 * re-run that throws away the very moment being looked at. 1-based; out of
 * range is a no-op, since the line came from a run older than the buffer.
 */
export function revealLine(doc: vscode.TextDocument, line: number): void {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  if (!editor || line < 1 || line > doc.lineCount) return;
  const range = doc.lineAt(line - 1).range;
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
  /* The panel is wide and short: the moments on the left, the parked moment's
     call stack beside them. Narrow, the stack drops underneath. */
  main { display: flex; align-items: flex-start; }
  #rows { flex: 1 1 auto; min-width: 0; }
  aside { flex: 0 0 32%; min-width: 180px; position: sticky; top: 0; padding: 4px 8px;
          border-left: 1px solid var(--vscode-panel-border, transparent); box-sizing: border-box; }
  @media (max-width: 480px) {
    main { flex-direction: column; align-items: stretch; }
    aside { border-left: none; border-top: 1px solid var(--vscode-panel-border, transparent); }
  }
  h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
       margin: 2px 0 4px; opacity: 0.8; }
  .hint { opacity: 0.7; margin: 0; }
  ol { list-style: none; margin: 0; padding: 0; }
  #rows:empty::after { content: "Nothing recorded yet."; display: block; padding: 8px;
                       opacity: 0.7; }
  button { display: flex; gap: 8px; align-items: baseline; width: 100%;
           padding: 2px 8px 2px calc(8px + var(--depth, 0) * 12px);
           cursor: pointer; white-space: nowrap; text-align: left; background: none;
           border: none; color: inherit; font: inherit; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button[aria-current="true"] { background: var(--vscode-list-activeSelectionBackground);
                                color: var(--vscode-list-activeSelectionForeground); }
  /* The function band: one colour per function, so a run reads as blocks of
     calls; the name is only spelled out where the call changes. */
  #rows li { border-left: 3px solid transparent; }
  #rows li.fn0 { border-left-color: var(--vscode-charts-blue); }
  #rows li.fn1 { border-left-color: var(--vscode-charts-green); }
  #rows li.fn2 { border-left-color: var(--vscode-charts-orange); }
  #rows li.fn3 { border-left-color: var(--vscode-charts-purple); }
  #rows li.fn4 { border-left-color: var(--vscode-charts-yellow); }
  #rows li.fn5 { border-left-color: var(--vscode-charts-red); }
  #rows li.enters { border-top: 1px solid var(--vscode-panel-border, transparent); }
  .fn { flex: none; opacity: 0.75; font-style: italic; }
  .fn:empty { display: none; }
  #trace button { padding: 1px 4px; }
  #trace .name { overflow: hidden; text-overflow: ellipsis; }
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
<main>
<ol id="rows" aria-label="Quoll timeline"></ol>
<aside aria-labelledby="trace-title">
  <h2 id="trace-title">Call stack</h2>
  <p class="hint" id="trace-hint">Select a moment to see the calls it happened in.</p>
  <ol id="trace" aria-labelledby="trace-title"></ol>
</aside>
</main>
<script nonce="${nonce}">
  const list = document.getElementById("rows");
  const traceList = document.getElementById("trace");
  const traceHint = document.getElementById("trace-hint");
  const vscodeApi = acquireVsCodeApi();
  const FN_COLOURS = 6;
  let generation = -1;

  window.addEventListener("message", (event) => {
    const data = event.data ?? {};
    generation = data.generation ?? -1;
    render(data.rows ?? [], data.current ?? -1);
    renderTrace(data.trace);
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
    button.append(span("dot"), span("line"), span("fn"), span("preview"), span("at"));
    button.addEventListener("click", () => {
      vscodeApi.postMessage({ index: [...list.children].indexOf(li), generation });
    });
    li.append(button);
    return li;
  }

  function fill(li, row, isCurrent) {
    const button = li.firstElementChild;
    const [dot, line, fn, preview, at] = button.children;
    li.className =
      (row.fn === undefined ? "" : "fn" + (row.fn % FN_COLOURS)) +
      (row.transition ? " enters" : "");
    button.style.setProperty("--depth", String(Math.min(row.depth, 12)));
    dot.className = "dot " + row.kind;
    line.textContent = row.line ? "L" + row.line : "";
    fn.textContent = row.transition ? row.fnName : ""; // user-chosen name: text only
    preview.textContent = row.preview; // textContent, never innerHTML: user value
    at.textContent = row.elapsedMs + "ms";
    button.setAttribute("aria-current", String(isCurrent));
    button.setAttribute(
      "aria-label",
      (row.line ? "Line " + row.line + ", " : "") +
        "in " + row.fnName + ", " +
        row.kind + ": " + row.preview,
    );
  }

  // The parked stop's stack, innermost first. Small (the runner caps it), so
  // rebuilt outright; each frame is a button that jumps to its line.
  function renderTrace(trace) {
    traceList.replaceChildren();
    traceHint.hidden = trace !== undefined;
    if (trace === undefined) return;
    for (const frame of trace.frames) {
      const button = document.createElement("button");
      const name = span("name");
      name.textContent = frame.name;
      const line = span("line");
      line.textContent = frame.line ? "L" + frame.line : "";
      button.append(name, line);
      button.setAttribute(
        "aria-label",
        frame.name + (frame.line ? ", line " + frame.line : ""),
      );
      button.addEventListener("click", () => {
        if (frame.line) vscodeApi.postMessage({ type: "frame", line: frame.line, generation });
      });
      const li = document.createElement("li");
      li.append(button);
      traceList.append(li);
    }
    if (trace.elided > 0) {
      const li = document.createElement("li");
      li.className = "hint";
      li.textContent = "… " + trace.elided + " more " + (trace.elided === 1 ? "frame" : "frames");
      traceList.append(li);
    }
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
