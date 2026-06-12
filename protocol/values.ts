/**
 * Serialization protocol — CDP-`RemoteObject`-style.
 * FROZEN INTERFACE (quoll-spec.md): changes here are breaking protocol changes.
 */

export type RemoteValueType =
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "undefined"
  | "null"
  | "function"
  | "object"
  | "array"
  | "typedarray"
  | "date"
  | "regexp"
  | "map"
  | "set"
  | "promise"
  | "error";

export type RemoteValue = {
  type: RemoteValueType;
  /** Truncated, display-ready. */
  preview: string;
  /**
   * Present if lazily expandable via the `expand` host message.
   *
   * Lifetime: scoped to its runId; valid until that run's `exit`. The runner
   * retains referenced objects under a memory budget with LRU eviction;
   * expand() on an evicted id returns an "evicted" error while the recorded
   * preview remains displayable (Time Machine degrades gracefully).
   */
  objectId?: string;
};
