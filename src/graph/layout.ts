/**
 * Value-graph layout: columns by distance from the root, left to right.
 *
 * Computed on the host, not in the webview, so it is pure and unit-tested and
 * the page only draws what it is handed. It is deliberately simple — no
 * crossing minimisation — because the shapes a scratchpad graphs are mostly
 * lists and trees, and one rule makes those read well: a node's header sits
 * level with the field that first points at it. A linked list's links run
 * flat; a tree fans out from each parent's own rows.
 */
import type { GraphNode, ValueGraph } from "./model.ts";

export const HEADER = 22;
export const ROW = 18;
const PAD = 4;
const COLUMN_GAP = 64;
const NODE_GAP = 14;
const MIN_WIDTH = 110;
const MAX_WIDTH = 260;
/** How far a back edge's arc rises above the nodes. */
const ARC = 40;
/** Rough glyph width at the webview's font size; nodes clip past MAX_WIDTH. */
const CHAR = 7;

/** A node, placed. Rows are the fields, plus one for `more` when set. */
export interface PlacedNode {
  id: string;
  path: string;
  type: string;
  preview: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Undefined for a stub (not opened); `[]` for an opened empty object. */
  rows?: { key: string; preview: string; linked: boolean }[];
  more?: number;
  error?: string;
  root: boolean;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** SVG path data, field port to target header. */
  d: string;
  /** Points back to the same or an earlier column: a cycle or a back-link. */
  back: boolean;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

function widthOf(node: GraphNode): number {
  const texts = [
    `${node.type} ${node.preview}`,
    ...(node.fields ?? []).map((f) => `${f.key}: ${f.target ? "" : f.preview}`),
  ];
  const longest = Math.max(...texts.map((t) => t.length));
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * CHAR + 2 * PAD + 16));
}

function heightOf(node: GraphNode): number {
  // An expansion that failed has no fields but does have a row to show: why.
  const rows = (node.fields?.length ?? 0) + (node.more ? 1 : 0) + (node.error ? 1 : 0);
  return rows === 0 && !node.fields ? HEADER : HEADER + rows * ROW + PAD;
}

/** Does a link point back to the same or an earlier column? */
function isBack({ from, to }: { from: PlacedNode; to: PlacedNode }): boolean {
  return to.x <= from.x;
}

/** The y of a field row's centre — where its edge leaves the node. */
function portY(node: PlacedNode, field: number): number {
  return node.y + HEADER + field * ROW + ROW / 2;
}

export function layoutGraph(graph: ValueGraph): GraphLayout {
  // Columns in discovery order, which is BFS order: a parent is always placed
  // before anything it points at, so its port positions are known.
  const columns: GraphNode[][] = [];
  for (const node of graph.nodes.values()) (columns[node.depth] ??= []).push(node);

  const xs: number[] = [];
  let x = PAD;
  for (const column of columns) {
    xs.push(x);
    x += Math.max(0, ...(column ?? []).map(widthOf)) + COLUMN_GAP;
  }

  const placed = new Map<string, PlacedNode>();
  /** Where each node wants to sit: level with the first field pointing at it. */
  const wanted = new Map<string, number>();
  columns.forEach((column, depth) => {
    let nextFree = PAD;
    for (const node of column ?? []) {
      const y = Math.max(nextFree, (wanted.get(node.id) ?? PAD + HEADER / 2) - HEADER / 2);
      const place: PlacedNode = {
        id: node.id,
        path: node.path,
        type: node.type,
        preview: node.preview,
        x: xs[depth]!,
        y,
        width: widthOf(node),
        height: heightOf(node),
        root: node.id === graph.root,
        ...(node.fields
          ? {
              rows: node.fields.map((f) => ({
                key: f.key,
                preview: f.preview,
                linked: f.target !== undefined,
              })),
            }
          : {}),
        ...(node.more ? { more: node.more } : {}),
        ...(node.error ? { error: node.error } : {}),
      };
      placed.set(node.id, place);
      nextFree = y + place.height + NODE_GAP;
      node.fields?.forEach((f, i) => {
        if (f.target !== undefined && !wanted.has(f.target)) wanted.set(f.target, portY(place, i));
      });
    }
  });

  // A back edge (cycle, parent link) can't run leftwards through the columns
  // between; it arcs over the top into the target's header instead. Any graph
  // that has one gets a band above the nodes for those arcs to use.
  const links: { from: PlacedNode; field: number; to: PlacedNode }[] = [];
  for (const node of graph.nodes.values()) {
    const from = placed.get(node.id)!;
    node.fields?.forEach((field, i) => {
      const to = field.target === undefined ? undefined : placed.get(field.target);
      if (to) links.push({ from, field: i, to });
    });
  }
  const band = links.some(isBack) ? ARC : 0;
  for (const n of placed.values()) n.y += band;

  const edges: PlacedEdge[] = links.map((link) => {
    const { from, field, to } = link;
    const sx = from.x + from.width;
    const sy = portY(from, field);
    if (isBack(link)) {
      const tx = to.x + to.width / 2;
      const ty = to.y;
      const d = `M ${sx} ${sy} C ${sx + ARC} ${sy}, ${tx} ${ty - ARC}, ${tx} ${ty}`;
      return { from: from.id, to: to.id, d, back: true };
    }
    // Forward: a plain S-curve into the target's header, level with it.
    const tx = to.x;
    const ty = to.y + HEADER / 2;
    const mid = sx + (tx - sx) / 2;
    const d = `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
    return { from: from.id, to: to.id, d, back: false };
  });

  let width = 0;
  let height = 0;
  for (const n of placed.values()) {
    width = Math.max(width, n.x + n.width + PAD);
    height = Math.max(height, n.y + n.height + PAD);
  }
  // A back edge's first control point reaches ARC past its source.
  return { nodes: [...placed.values()], edges, width: width + (band ? ARC : 0), height };
}
