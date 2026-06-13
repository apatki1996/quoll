/**
 * Single source of truth for the extension-host contribution identifiers.
 * Mirror of `package.json` `contributes` — keep the two in sync.
 */

/** Config section + extension id. */
export const EXTENSION_ID = "quoll";

/** Command IDs registered in `package.json` `contributes.commands`. */
export const Commands = {
  start: "quoll.start",
  stop: "quoll.stop",
  copyValue: "quoll.copyValue",
} as const;

/** View IDs from `contributes.views`. */
export const Views = {
  values: "quollValues",
} as const;

/** `TreeItem.contextValue` values matched by `contributes.menus` `when` clauses. */
export const ContextValues = {
  value: "quollValue",
} as const;

/** OutputChannel display name. */
export const OUTPUT_CHANNEL = "Quoll";
