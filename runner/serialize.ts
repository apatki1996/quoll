/**
 * Serialization (phase 5): type classification, display previews, and the
 * object registry behind lazy expansion (`expand` → `expandResult`).
 *
 * Registry lifetime matches the process (one run per process): values are
 * registered as they're captured and stay expandable until the host kills
 * the runner (next run / session stop), under an LRU memory budget.
 */

import type { RemoteValue, RemoteValueType } from "../protocol/index.ts";

const MAX_PREVIEW = 200;
/** Registry budget: object count as the bytes proxy (CDP does the same). */
const MAX_OBJECTS = 10_000;
/** Per-expand entry cap; a trailing "…" entry reports what was elided. */
const MAX_ENTRIES = 100;

function classify(v: unknown): RemoteValueType {
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "undefined":
      return "undefined";
    case "function":
      return "function";
  }
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (v instanceof RegExp) return "regexp";
  if (v instanceof Map) return "map";
  if (v instanceof Set) return "set";
  if (v instanceof Promise) return "promise";
  if (v instanceof Error) return "error";
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return "typedarray";
  return "object";
}

/**
 * Types with children worth a tree node. date/regexp stringify fully in the
 * preview; promise stays preview-only because the only ways to read its state
 * (attaching .then, inspector) would mark user rejections handled and break
 * the unhandledrejection trap — Deno.inspect already previews settled values.
 */
const EXPANDABLE: ReadonlySet<RemoteValueType> = new Set([
  "object",
  "array",
  "typedarray",
  "map",
  "set",
  "error",
  "function",
]);

// ── object registry (LRU: Map insertion order, re-insert on touch) ────

const objects = new Map<string, unknown>();
const idsByObject = new WeakMap<object, string>();
let nextObjectId = 1;

function register(v: object): string {
  let id = idsByObject.get(v);
  if (id === undefined) {
    id = `o${nextObjectId++}`;
    idsByObject.set(v, id);
  } else {
    objects.delete(id); // LRU touch (also revives an evicted id)
  }
  objects.set(id, v);
  if (objects.size > MAX_OBJECTS) {
    const oldest = objects.keys().next().value as string;
    objects.delete(oldest);
  }
  return id;
}

export type ExpandOutcome =
  | { entries: { key: string; value: RemoteValue }[] }
  | { error: "evicted" | "unknown" };

export function expandObject(objectId: string): ExpandOutcome {
  if (!objects.has(objectId)) {
    // Ids are sequential, so "ever issued but missing" means LRU-evicted.
    const n = Number(objectId.slice(1));
    const issued = objectId.startsWith("o") && Number.isInteger(n) && n >= 1 && n < nextObjectId;
    return { error: issued ? "evicted" : "unknown" };
  }
  const v = objects.get(objectId);
  objects.delete(objectId); // LRU touch
  objects.set(objectId, v);
  return { entries: entriesOf(v) };
}

// ── previews ───────────────────────────────────────────────────────────

function previewOf(v: unknown): string {
  // Deno.inspect handles circular refs, depth limits, and getters safely.
  let preview = Deno.inspect(v, {
    depth: 2,
    iterableLimit: 20,
    strAbbreviateSize: MAX_PREVIEW,
    breakLength: Infinity,
    compact: true,
  });
  if (preview.length > MAX_PREVIEW) {
    let cut = preview.slice(0, MAX_PREVIEW - 1);
    // don't split a surrogate pair at the cut point
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    preview = cut + "…";
  }
  return preview;
}

export function toRemoteValue(v: unknown): RemoteValue {
  const type = classify(v);
  const value: RemoteValue = { type, preview: previewOf(v) };
  if (EXPANDABLE.has(type)) value.objectId = register(v as object);
  return value;
}

// ── expansion entries ──────────────────────────────────────────────────

type Entry = { key: string; value: RemoteValue };

function overflowEntry(elided: number): Entry {
  return { key: "…", value: { type: "string", preview: `(+${elided} more)` } };
}

/** Own properties via descriptors — user getters are NEVER invoked here
 * (expansion must not run user code); they render as a [Getter] stub. */
function ownPropEntries(obj: object, skip?: ReadonlySet<string>): Entry[] {
  const entries: Entry[] = [];
  const names = Object.getOwnPropertyNames(obj);
  let added = 0;
  for (const name of names) {
    if (skip?.has(name)) continue;
    if (added >= MAX_ENTRIES) {
      entries.push(overflowEntry(names.length - added));
      break;
    }
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (!desc) continue;
    if ("value" in desc) {
      entries.push({ key: name, value: toRemoteValue(desc.value) });
    } else {
      entries.push({
        key: name,
        value: { type: "function", preview: desc.get ? "[Getter]" : "[Setter]" },
      });
    }
    added++;
  }
  return entries;
}

function entriesOf(v: unknown): Entry[] {
  if (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
    const arr = v as ArrayLike<unknown>;
    const entries: Entry[] = [];
    const n = Math.min(arr.length, MAX_ENTRIES);
    for (let i = 0; i < n; i++) entries.push({ key: String(i), value: toRemoteValue(arr[i]) });
    if (arr.length > MAX_ENTRIES) entries.push(overflowEntry(arr.length - MAX_ENTRIES));
    entries.push({ key: "length", value: toRemoteValue(arr.length) });
    return entries;
  }
  if (v instanceof Map) {
    const entries: Entry[] = [];
    let i = 0;
    for (const [key, val] of v) {
      if (i >= MAX_ENTRIES) {
        entries.push(overflowEntry(v.size - MAX_ENTRIES));
        break;
      }
      // key by preview only — registering Map keys would bloat the registry
      entries.push({ key: previewOf(key), value: toRemoteValue(val) });
      i++;
    }
    entries.push({ key: "size", value: toRemoteValue(v.size) });
    return entries;
  }
  if (v instanceof Set) {
    const entries: Entry[] = [];
    let i = 0;
    for (const val of v) {
      if (i >= MAX_ENTRIES) {
        entries.push(overflowEntry(v.size - MAX_ENTRIES));
        break;
      }
      entries.push({ key: String(i), value: toRemoteValue(val) });
      i++;
    }
    entries.push({ key: "size", value: toRemoteValue(v.size) });
    return entries;
  }
  if (v instanceof Error) {
    const entries: Entry[] = [
      { key: "name", value: toRemoteValue(v.name) },
      { key: "message", value: toRemoteValue(v.message) },
    ];
    if (v.stack !== undefined) entries.push({ key: "stack", value: toRemoteValue(v.stack) });
    if (v.cause !== undefined) entries.push({ key: "cause", value: toRemoteValue(v.cause) });
    entries.push(...ownPropEntries(v, new Set(["name", "message", "stack", "cause"])));
    return entries;
  }
  if (typeof v === "object" && v !== null) return ownPropEntries(v);
  if (typeof v === "function") {
    return ownPropEntries(v as object, new Set(["prototype"]));
  }
  return [];
}
