/**
 * Phase-1 serialization: type classification + display preview only.
 * objectId / lazy expansion lands in phase 5.
 */

import type { RemoteValue, RemoteValueType } from "../protocol/index.ts";

const MAX_PREVIEW = 200;

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

export function toRemoteValue(v: unknown): RemoteValue {
  // Deno.inspect already handles circular refs, depth limits, and getters
  // safely — good enough for previews until the real protocol (phase 5).
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
  return { type: classify(v), preview };
}
