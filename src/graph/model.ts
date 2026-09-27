/**
 * Interactive Value Graphs (phase 11): a captured value drawn as the objects
 * it reaches and the references between them, rather than as a tree.
 *
 * Built entirely from the protocol's lazy `expand` round-trip — no new capture
 * data. What makes it a GRAPH rather than the value explorer drawn sideways is
 * identity: the runner hands out one `objectId` per object (a WeakMap in
 * `runner/serialize.ts`), so a node is keyed by it, and a second path to the
 * same object — a shared child, a doubly-linked list, a cycle — is a second
 * EDGE to one node instead of another copy of it.
 *
 * Deliberately vscode-free (like `render/aggregate.ts`), so the expansion
 * rules are unit-tested against a fake `expand`.
 */
import type { RemoteValue } from "../../protocol/index.ts";

/** The session's expand outcome, structurally (session.ts imports vscode). */
export type ExpandResult =
  | { entries: { key: string; value: RemoteValue }[] }
  | { error: "evicted" | "unknown" | "gone" };

export type Expand = (objectId: string) => Promise<ExpandResult>;

/** One property row inside a node. */
export interface GraphField {
  key: string;
  preview: string;
  /** The node this field references; absent for a primitive or a leaf. */
  target?: string;
}

export interface GraphNode {
  /** The runner's objectId — the node's identity. */
  id: string;
  type: string;
  preview: string;
  /**
   * The key path it was first reached by, JSON-encoded. This, not the id, is
   * what a user's expand/collapse is remembered by: ids are per RUN, and a
   * graph that follows a capture site is rebuilt on every run.
   */
  path: string;
  /** BFS distance from the root: the layout's column. */
  depth: number;
  /** Present once expanded; a stub (reachable, not opened) has none. */
  fields?: GraphField[];
  /** Fields past `MAX_FIELDS`, not drawn (the runner's own "…" included). */
  more?: number;
  /** Why an expansion failed ("evicted", "gone", …). */
  error?: string;
}

export interface ValueGraph {
  /** Undefined when the value isn't an object: nothing to draw. */
  root: string | undefined;
  /** Insertion order is discovery (BFS) order, which the layout relies on. */
  nodes: Map<string, GraphNode>;
  /** Did the node budget stop the walk before everything asked for opened? */
  truncated: boolean;
}

/** Which paths the user opened or closed, overriding the automatic depth. */
export interface Expansion {
  opened: ReadonlySet<string>;
  closed: ReadonlySet<string>;
}

/** Levels opened without asking. Deep enough to show a list's shape, shallow
 * enough that a big object doesn't open a wall. */
export const AUTO_DEPTH = 2;
/** Nodes opened automatically; past this only explicit opens happen. */
export const AUTO_NODES = 30;
/** Hard ceiling on nodes drawn, explicit opens included. */
export const MAX_NODES = 200;
/** Fields drawn per node; the rest are counted in `more`. */
export const MAX_FIELDS = 12;

/**
 * Values drawn as nodes. Functions are expandable in the explorer, but as graph
 * nodes they are noise (every method would sprout one); they stay a field.
 */
function isNode(value: RemoteValue): value is RemoteValue & { objectId: string } {
  return value.objectId !== undefined && value.type !== "function";
}

/** The path key a node's expand/collapse is remembered by. */
export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/**
 * Walk `root` breadth-first through `expand`, one level of requests at a time
 * (in parallel within a level). A node opens if the user opened it, or if it
 * is shallower than `AUTO_DEPTH`, not closed, and the automatic budget has
 * room; every object an open node references becomes at least a stub.
 */
export async function buildGraph(
  root: RemoteValue,
  expand: Expand,
  expansion: Expansion = { opened: new Set(), closed: new Set() },
): Promise<ValueGraph> {
  const nodes = new Map<string, GraphNode>();
  if (!isNode(root)) return { root: undefined, nodes, truncated: false };

  const add = (value: RemoteValue & { objectId: string }, path: string[], depth: number) => {
    const node: GraphNode = {
      id: value.objectId,
      type: value.type,
      preview: value.preview,
      path: pathKey(path),
      depth,
    };
    nodes.set(node.id, node);
    return { node, path };
  };

  let truncated = false;
  let autoOpened = 0;
  let level = [add(root, [], 0)];
  while (level.length > 0) {
    const opening = level.filter(({ node }) => {
      if (expansion.opened.has(node.path)) return true;
      if (node.depth >= AUTO_DEPTH || expansion.closed.has(node.path)) return false;
      if (autoOpened >= AUTO_NODES) {
        truncated = true;
        return false;
      }
      autoOpened++;
      return true;
    });
    const results = await Promise.all(opening.map(({ node }) => expand(node.id)));
    const next: typeof level = [];
    opening.forEach(({ node, path }, i) => {
      const result = results[i]!;
      if ("error" in result) {
        node.error = result.error;
        return;
      }
      node.fields = [];
      for (const { key, value } of result.entries) {
        if (node.fields.length >= MAX_FIELDS) {
          node.more = (node.more ?? 0) + 1;
          continue;
        }
        const field: GraphField = { key, preview: value.preview };
        if (isNode(value)) {
          field.target = value.objectId;
          if (!nodes.has(value.objectId)) {
            if (nodes.size >= MAX_NODES) {
              truncated = true;
              delete field.target; // drawn as its preview, not as an edge to nothing
            } else {
              next.push(add(value, [...path, key], node.depth + 1));
            }
          }
        }
        node.fields.push(field);
      }
    });
    level = next;
  }
  return { root: root.objectId, nodes, truncated };
}
