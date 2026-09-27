// Value-graph model + layout unit tests: `mise exec -- deno test src/graph/`
import { strict as assert } from "node:assert";
import type { RemoteValue } from "../../protocol/index.ts";
import { layoutGraph } from "./layout.ts";
import { AUTO_DEPTH, buildGraph, MAX_FIELDS, pathKey, type Expand } from "./model.ts";

/** An object reference as the runner would serialize it. */
const ref = (id: string, preview = id): RemoteValue => ({ type: "object", preview, objectId: id });
const num = (n: number): RemoteValue => ({ type: "number", preview: String(n) });

/** A fake runner: a heap of objects by id, and a log of what was expanded. */
function heap(objects: Record<string, [string, RemoteValue][]>): {
  expand: Expand;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    expand: (id) => {
      asked.push(id);
      const entries = objects[id];
      return Promise.resolve(
        entries
          ? { entries: entries.map(([key, value]) => ({ key, value })) }
          : { error: "evicted" as const },
      );
    },
  };
}

Deno.test("a cycle is one node with an edge back, not an infinite unrolling", async () => {
  // a.next = b, b.next = a
  const { expand } = heap({
    a: [
      ["value", num(1)],
      ["next", ref("b")],
    ],
    b: [
      ["value", num(2)],
      ["next", ref("a")],
    ],
  });
  const graph = await buildGraph(ref("a"), expand);
  assert.deepEqual([...graph.nodes.keys()], ["a", "b"]);
  assert.equal(graph.nodes.get("b")!.fields![1]!.target, "a");

  const layout = layoutGraph(graph);
  assert.deepEqual(
    layout.edges.map((e) => [e.from, e.to, e.back]),
    [
      ["a", "b", false],
      ["b", "a", true],
    ],
  );
});

Deno.test("a shared child is drawn once, with two edges into it", async () => {
  const { expand } = heap({
    root: [
      ["left", ref("x")],
      ["right", ref("x")],
    ],
    x: [["v", num(0)]],
  });
  const graph = await buildGraph(ref("root"), expand);
  assert.equal(graph.nodes.size, 2);
  assert.equal(layoutGraph(graph).edges.filter((e) => e.to === "x").length, 2);
});

Deno.test("opens AUTO_DEPTH levels by itself; deeper objects are stubs", async () => {
  // A linked list longer than the automatic depth.
  const { expand, asked } = heap({
    n0: [["next", ref("n1")]],
    n1: [["next", ref("n2")]],
    n2: [["next", ref("n3")]],
    n3: [],
  });
  const graph = await buildGraph(ref("n0"), expand);
  assert.equal(asked.length, AUTO_DEPTH);
  assert.ok(graph.nodes.get("n1")!.fields, "depth 1 opened");
  assert.equal(graph.nodes.get("n2")!.fields, undefined, "depth 2 is a stub");
  assert.equal(graph.nodes.has("n3"), false, "nothing past a stub");
});

Deno.test("opening and closing are remembered by PATH, so they survive new ids", async () => {
  const { expand } = heap({
    n0: [["next", ref("n1")]],
    n1: [["next", ref("n2")]],
    n2: [["next", ref("n3")]],
    n3: [],
  });
  const opened = new Set([pathKey(["next", "next"])]);
  const closed = new Set([pathKey([])]);
  // Closing the root wins over the automatic depth…
  const shut = await buildGraph(ref("n0"), expand, { opened: new Set(), closed });
  assert.equal(shut.nodes.size, 1);
  // …and an explicit open goes past it.
  const deep = await buildGraph(ref("n0"), expand, { opened, closed: new Set() });
  assert.ok(deep.nodes.get("n2")!.fields, "opened by path");
  assert.equal(deep.nodes.get("n2")!.path, pathKey(["next", "next"]));
});

Deno.test("functions stay fields; primitives are not nodes", async () => {
  const fn: RemoteValue = { type: "function", preview: "[Function: f]", objectId: "f" };
  const { expand } = heap({
    o: [
      ["f", fn],
      ["n", num(3)],
    ],
  });
  const graph = await buildGraph(ref("o"), expand);
  assert.deepEqual([...graph.nodes.keys()], ["o"]);
  assert.deepEqual(graph.nodes.get("o")!.fields, [
    { key: "f", preview: "[Function: f]" },
    { key: "n", preview: "3" },
  ]);
  assert.equal((await buildGraph(num(1), expand)).root, undefined);
});

Deno.test("wide objects are cut to MAX_FIELDS and counted", async () => {
  const entries: [string, RemoteValue][] = [];
  for (let i = 0; i < MAX_FIELDS + 5; i++) entries.push([String(i), num(i)]);
  const graph = await buildGraph(ref("wide"), heap({ wide: entries }).expand);
  const node = graph.nodes.get("wide")!;
  assert.equal(node.fields!.length, MAX_FIELDS);
  assert.equal(node.more, 5);
});

Deno.test("an expansion error is kept on the node, not thrown", async () => {
  const graph = await buildGraph(ref("gone"), heap({}).expand);
  assert.equal(graph.nodes.get("gone")!.error, "evicted");
});

Deno.test("layout: columns by depth, and a list's links run level", async () => {
  const { expand } = heap({
    n0: [["next", ref("n1")]],
    n1: [["next", ref("n2")]],
    n2: [],
  });
  const opened = new Set([pathKey(["next", "next"])]);
  const { nodes, edges } = layoutGraph(
    await buildGraph(ref("n0"), expand, { opened, closed: new Set() }),
  );
  const [a, b, c] = nodes;
  assert.ok(a!.x < b!.x && b!.x < c!.x, "one column per depth");
  assert.equal(a!.root, true);
  // Each node's header is level with the `next` row pointing at it, so every
  // link leaves and arrives at the same height.
  for (const { d } of edges) {
    const ys = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    assert.equal(ys[0], ys[ys.length - 1], d);
  }
});

Deno.test("layout: a back edge arcs into the target from above, inside the canvas", async () => {
  const { expand } = heap({ a: [["self", ref("a")]] });
  const layout = layoutGraph(await buildGraph(ref("a"), expand));
  const [edge] = layout.edges;
  assert.equal(edge!.back, true);
  const numbers = [...edge!.d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
  assert.ok(
    numbers.every((n) => n >= 0),
    `every point of ${edge!.d} is on the canvas`,
  );
  const [node] = layout.nodes;
  assert.equal(numbers[numbers.length - 1], node!.y, "it lands on the header's top edge");
});
