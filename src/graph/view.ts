import * as vscode from "vscode";
import type { RemoteValue } from "../../protocol/index.ts";
import { Views } from "../constants.ts";
import type { QuollSession } from "../session.ts";
import { layoutGraph, type GraphLayout } from "./layout.ts";
import { buildGraph, type Expansion } from "./model.ts";

/**
 * What a graph is OF.
 * - `site`   — the value a capture site produced (its latest, or capture
 *              `index` of a loop). FOLLOWS the site: every run, and every Time
 *              Machine step, redraws it from that site's value then — the way
 *              inline values follow the code.
 * - `object` — a value found by expanding another (a tree child). It has no
 *              site to follow, so it belongs to the run it came from, and says
 *              so once that run is gone rather than drawing ids a new runner
 *              process has never heard of.
 */
export type GraphTarget =
  | { kind: "site"; siteId: number; index?: number }
  | { kind: "object"; value: RemoteValue; generation: number };

/** Everything the page draws, in one message. */
type Update =
  | { state: "empty"; message: string }
  | ({ state: "graph"; title: string; note?: string; build: number } & GraphLayout);

/**
 * Interactive Value Graphs (phase 11): the Graph view in the Quoll panel.
 *
 * The host walks and lays the graph out (`model.ts`, `layout.ts` — pure and
 * unit-tested); the page draws the layout as SVG and posts back a node's path
 * when it is clicked, which opens or closes it. Opening is remembered by key
 * PATH rather than objectId, so a followed site keeps what you opened across
 * runs, whose ids are all new.
 */
export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session: QuollSession | undefined;
  private sessionSub: vscode.Disposable | undefined;
  private target: GraphTarget | undefined;
  private expansion: { opened: Set<string>; closed: Set<string> } = {
    opened: new Set(),
    closed: new Set(),
  };
  /** Paths open in the current drawing — what a click on one toggles FROM. */
  private lastOpenPaths = new Set<string>();
  /** What the current drawing is of: skip rebuilding an identical graph on
   * every session update (a streaming run fires many). */
  private drawn: string | undefined;
  /** Bumped per build; a slower, older build that finishes late is dropped,
   * and a click stamped with an older build is refused. */
  private build = 0;
  private last: Update = { state: "empty", message: EMPTY };

  setSession(session: QuollSession | undefined): void {
    this.sessionSub?.dispose();
    if (session !== this.session) {
      // A target belongs to its session. Run generations restart at 1 in
      // every session and objectIds restart at o1 in every runner, so an old
      // target would resolve against the new session as if it were current —
      // drawing an unrelated object, or another file's line.
      this.target = undefined;
      this.expansion = { opened: new Set(), closed: new Set() };
      this.lastOpenPaths = new Set();
      this.drawn = undefined;
      this.build++; // and a build still expanding against the old runner is void
    }
    this.session = session;
    this.sessionSub = session?.onDidUpdate(() => void this.redraw());
    void this.redraw();
  }

  /** Graph `target`, starting from the automatic depth, and bring the view up. */
  async show(target: GraphTarget): Promise<boolean> {
    this.target = target;
    this.expansion = { opened: new Set(), closed: new Set() };
    await vscode.commands.executeCommand(`${Views.graph}.focus`);
    return this.redraw(true);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: unknown) => {
      // A web page's message: take the expected fields and nothing else.
      const { type, path, build } = (msg ?? {}) as Record<string, unknown>;
      if (type === "ready") this.post();
      if (type === "toggle" && typeof path === "string" && build === this.build) {
        this.toggle(path);
      }
    });
    view.onDidChangeVisibility(() => this.post()); // a hidden view drops its DOM
  }

  /** Open a closed node or close an open one, remembered by path. */
  toggle(path: string): void {
    const { opened, closed } = this.expansion;
    const isOpen = this.lastOpenPaths.has(path);
    opened.delete(path);
    closed.delete(path);
    (isOpen ? closed : opened).add(path);
    void this.redraw(true);
  }

  /** Rebuild if what the target resolves to changed (or `force`). Resolves
   * to whether a graph is on screen afterwards. */
  private async redraw(force = false): Promise<boolean> {
    const resolved = this.resolve();
    if ("message" in resolved) {
      this.build++; // a build still expanding must not paint over this
      this.drawn = undefined;
      this.last = { state: "empty", message: resolved.message };
      this.post();
      return false;
    }
    const { root, title, key } = resolved;
    if (!force && key === this.drawn) return this.last.state === "graph";
    const session = this.session!;
    const build = ++this.build;
    const expansion: Expansion = this.expansion;
    const graph = await buildGraph(root, (id) => session.expand(id), expansion);
    if (build !== this.build) return false; // superseded while expanding
    this.drawn = key;
    if (graph.root === undefined) {
      this.last = { state: "empty", message: `${title} is ${root.preview} — not an object.` };
      this.post();
      return false;
    }
    this.lastOpenPaths = new Set(
      [...graph.nodes.values()].filter((n) => n.fields).map((n) => n.path),
    );
    const note = graph.truncated
      ? "Some objects were left closed to keep the graph readable — click one to open it."
      : undefined;
    this.last = {
      state: "graph",
      title,
      build,
      ...(note ? { note } : {}),
      ...layoutGraph(graph),
    };
    this.post();
    return true;
  }

  /** The value to draw now, or why there isn't one. `key` identifies the
   * drawing: same key, same graph. */
  private resolve(): { root: RemoteValue; title: string; key: string } | { message: string } {
    const target = this.target;
    const session = this.session;
    if (!target) return { message: EMPTY };
    if (!session) return { message: "No Quoll session is running." };
    const generation = session.runGeneration;
    if (target.kind === "object") {
      if (target.generation !== generation) {
        return {
          message:
            "This graph was of a value from an earlier run. Graph a value from the " +
            "Values view or a hover to follow it as you edit.",
        };
      }
      return {
        root: target.value,
        title: "Value",
        key: `${generation}:${target.value.objectId}`,
      };
    }
    const site = session.valueRoots().find((r) => r.siteId === target.siteId);
    const values = site?.values ?? [];
    const index = target.index ?? values.length - 1;
    const root = values[index];
    if (!site || !root) {
      return { message: "That expression hasn't produced a value in this run (yet)." };
    }
    const capture = target.index === undefined ? "" : ` #${index + 1}`;
    return {
      root,
      title: `Line ${site.line}${capture}`,
      // Stepping the Time Machine can land on another capture of the same
      // site, so the capture's own id is part of the key, not just the run.
      key: `${generation}:${target.siteId}:${index}:${root.objectId ?? root.preview}`,
    };
  }

  private post(): void {
    if (!this.view?.visible) return;
    // vscode's Webview.postMessage takes one argument, unlike window's.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    void this.view.webview.postMessage(this.last);
  }

  dispose(): void {
    this.sessionSub?.dispose();
  }
}

const EMPTY =
  "Graph a value to see the objects it reaches and how they link — " +
  "Graph Value on an entry in Values, or on a hover in the editor.";

/**
 * The page: draws the layout it is handed as SVG, nothing more. Every string
 * that came from the user's program goes in through `textContent`; the only
 * attributes set from data are numbers and class names from a fixed set.
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
  header { display: flex; gap: 12px; align-items: baseline; padding: 4px 8px; }
  header .title { font-weight: 600; }
  header .note, .empty { opacity: 0.7; }
  .empty { padding: 8px; margin: 0; }
  #canvas { overflow: auto; }
  svg { display: block; font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px; }
  .node > rect.box { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background));
                     stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  .node.root > rect.box { stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
  .node rect.head { fill: var(--vscode-list-hoverBackground); cursor: pointer; }
  .node .head-hit { cursor: pointer; }
  .node .head-hit:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .node text { fill: var(--vscode-foreground); dominant-baseline: middle; }
  .node .type { fill: var(--vscode-charts-blue); }
  .node .key { opacity: 0.7; }
  .node .linked { fill: var(--vscode-charts-blue); }
  .node .dim { opacity: 0.6; font-style: italic; }
  .node .error { fill: var(--vscode-charts-red); }
  path.edge { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 1.2; opacity: 0.8; }
  path.edge.back { stroke: var(--vscode-charts-orange); stroke-dasharray: 4 3; }
  marker path { fill: var(--vscode-charts-blue); }
  marker#arrow-back path { fill: var(--vscode-charts-orange); }
</style>
</head>
<body>
<header id="bar" hidden><span class="title" id="title"></span><span class="note" id="note"></span></header>
<p class="empty" id="empty"></p>
<div id="canvas"></div>
<script nonce="${nonce}">
  const SVG = "http://www.w3.org/2000/svg";
  const HEADER = 22, ROW = 18, PAD = 6;
  const vscodeApi = acquireVsCodeApi();
  const bar = document.getElementById("bar");
  const empty = document.getElementById("empty");
  const canvas = document.getElementById("canvas");

  window.addEventListener("message", (event) => render(event.data ?? {}));

  function el(name, attrs, text) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text; // user data: text, never markup
    return node;
  }

  function render(data) {
    canvas.replaceChildren();
    if (data.state !== "graph") {
      bar.hidden = true;
      empty.hidden = false;
      empty.textContent = data.message ?? "";
      return;
    }
    empty.hidden = true;
    bar.hidden = false;
    document.getElementById("title").textContent = data.title;
    document.getElementById("note").textContent =
      data.nodes.length + (data.nodes.length === 1 ? " object" : " objects") +
      (data.note ? " · " + data.note : "");

    const svg = el("svg", { width: data.width, height: data.height, role: "img",
                            "aria-label": "Value graph of " + data.title });
    const defs = el("defs");
    for (const id of ["arrow", "arrow-back"]) {
      const marker = el("marker", { id, viewBox: "0 0 8 8", refX: 8, refY: 4,
                                    markerWidth: 7, markerHeight: 7, orient: "auto" });
      marker.append(el("path", { d: "M0,0 L8,4 L0,8 z" }));
      defs.append(marker);
    }
    svg.append(defs);
    for (const edge of data.edges) {
      svg.append(el("path", { d: edge.d, class: edge.back ? "edge back" : "edge",
                              "marker-end": edge.back ? "url(#arrow-back)" : "url(#arrow)" }));
    }
    for (const node of data.nodes) svg.append(drawNode(node, data.build));
    canvas.append(svg);
  }

  function drawNode(node, build) {
    const open = node.rows !== undefined;
    const g = el("g", { class: node.root ? "node root" : "node",
                        transform: "translate(" + node.x + "," + node.y + ")" });
    g.append(el("rect", { class: "box", width: node.width, height: node.height, rx: 3 }));
    // A nested <svg> clips its content to the node: long previews end at the
    // border instead of running into the next column.
    const clip = el("svg", { width: node.width, height: node.height });
    clip.append(el("rect", { class: "head", width: node.width, height: HEADER, rx: 3 }));
    const head = el("text", { x: PAD, y: HEADER / 2 });
    head.append(el("tspan", { class: "type" }, (open ? "▾ " : "▸ ") + node.type + " "),
                el("tspan", {}, node.preview));
    clip.append(head);
    (node.rows ?? []).forEach((row, i) => {
      const text = el("text", { x: PAD, y: HEADER + i * ROW + ROW / 2 });
      text.append(el("tspan", { class: "key" }, row.key + ": "));
      text.append(row.linked ? el("tspan", { class: "linked" }, "●")
                             : el("tspan", {}, row.preview));
      clip.append(text);
    });
    let extra = (node.rows ?? []).length;
    if (node.more) {
      clip.append(el("text", { x: PAD, y: HEADER + extra * ROW + ROW / 2, class: "dim" },
                     "… " + node.more + " more"));
      extra++;
    }
    if (node.error) {
      clip.append(el("text", { x: PAD, y: HEADER + extra * ROW + ROW / 2, class: "error" },
                     node.error === "evicted"
                       ? "evicted from the runner's memory — re-run to inspect"
                       : "no longer available — re-run to inspect"));
    }
    g.append(clip);
    // The header is the node's one control: open or close it. Focusable and
    // keyboard-operable, since an SVG group gets none of that for free.
    const hit = el("rect", { class: "head-hit", width: node.width, height: HEADER,
                             fill: "transparent", tabindex: 0, role: "button",
                             "aria-expanded": String(open),
                             "aria-label": node.type + " " + node.preview +
                               (open ? ", open" : ", closed") });
    const toggle = () => vscodeApi.postMessage({ type: "toggle", path: node.path, build });
    hit.addEventListener("click", toggle);
    hit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    g.append(hit);
    return g;
  }

  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
