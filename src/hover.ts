import * as vscode from "vscode";
import { Commands } from "./constants.ts";
import type { SiteValues } from "./render/aggregate.ts";

/**
 * Value Peek (phase A): hovering an expression shows what it evaluated to.
 * Free of any re-run or re-eval — every expression is already a capture site
 * with a source span, so this just reads the current run's aggregated values
 * (`Aggregator.siteAt`) and formats them.
 */

/** Captures listed in the hover before it collapses into a "+N more" line. */
const MAX_CAPTURES = 20;

export function registerValueHover(
  doc: vscode.TextDocument,
  siteAt: (line: number, column: number) => SiteValues | undefined,
): vscode.Disposable {
  return vscode.languages.registerHoverProvider(
    // Language-agnostic: the session, not the selector, decides what's live —
    // a Quoll document can be any JS/TS dialect, or an untitled scratch buffer.
    { scheme: "*" },
    {
      provideHover(hovered, position) {
        if (hovered !== doc) return undefined;
        const hit = siteAt(position.line + 1, position.character);
        return hit ? new vscode.Hover(markdown(hit), spanRange(hit)) : undefined;
      },
    },
  );
}

function markdown({ siteId, values }: SiteValues): vscode.MarkdownString {
  const shown = values.slice(-MAX_CAPTURES); // a loop's latest captures
  const dropped = values.length - shown.length;
  const lines = shown.map((v) => v.preview);
  if (dropped > 0) lines.unshift(`… ${dropped} earlier ${dropped === 1 ? "capture" : "captures"}`);

  const md = new vscode.MarkdownString();
  md.appendCodeblock(lines.join("\n"), "text");
  const args = encodeURIComponent(JSON.stringify([siteId]));
  md.appendMarkdown(`[Explore value](command:${Commands.exploreValue}?${args})`);
  md.isTrusted = { enabledCommands: [Commands.exploreValue] }; // command link only
  return md;
}

/** The hover underlines the captured expression, not just the hovered word. */
function spanRange({ site }: SiteValues): vscode.Range {
  return new vscode.Range(site.line - 1, site.column, site.endLine - 1, site.endColumn);
}
