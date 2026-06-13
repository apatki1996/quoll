import * as vscode from "vscode";
import type { CoverageState } from "./aggregate.ts";

export type { CoverageState };

const MAX_LINE_RENDER = 120;

function truncate(text: string): string {
  if (text.length <= MAX_LINE_RENDER) return text;
  let cut = text.slice(0, MAX_LINE_RENDER - 1);
  // don't split a surrogate pair at the cut point
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + "…";
}

function gutterIcon(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="10" y="6" width="7" height="20" rx="2" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

/** Inline end-of-line decorations + coverage gutter for one document. */
export class Renderer implements vscode.Disposable {
  private readonly valueType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic",
      margin: "0 0 0 2em",
    },
  });
  private readonly errorType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("errorForeground"),
      margin: "0 0 0 2em",
    },
  });
  private readonly coverageTypes: Record<CoverageState, vscode.TextEditorDecorationType> = {
    covered: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon("#2ea043"),
      gutterIconSize: "contain",
    }),
    uncovered: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon("#f85149"),
      gutterIconSize: "contain",
    }),
    partial: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon("#d29922"),
      gutterIconSize: "contain",
    }),
  };

  /**
   * Latest per-source-line render state, computed by the Aggregator (session).
   * The Renderer is now pure vscode plumbing: it stores a snapshot and paints
   * it — no attribution or aggregation lives here anymore.
   */
  private values = new Map<number, string[]>();
  private errors = new Map<number, string>();
  private coverage = new Map<number, CoverageState>();

  constructor(private readonly doc: vscode.TextDocument) {}

  /**
   * Replace the whole snapshot and paint ONCE. A single entry point (rather
   * than per-kind setters) so one render pass can't repaint three times —
   * `apply()` recomputes every decoration kind regardless of what changed.
   */
  setSnapshot(
    values: Map<number, string[]>,
    coverage: Map<number, CoverageState>,
    errors: Map<number, string>,
  ): void {
    this.values = values;
    this.coverage = coverage;
    this.errors = errors;
    this.apply();
  }

  clear(): void {
    this.setSnapshot(new Map(), new Map(), new Map());
  }

  /** Re-apply to current editors (tab switches recreate TextEditor objects). */
  reapply(): void {
    this.apply();
  }

  private apply(): void {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === this.doc);
    if (editors.length === 0) return;

    const valueDecos: vscode.DecorationOptions[] = [];
    for (const [line, previews] of this.values) {
      const range = this.lineEnd(line);
      if (!range) continue; // line vanished since the run started; rerun is imminent
      valueDecos.push({
        range,
        renderOptions: { after: { contentText: truncate(previews.join(", ")) } },
      });
    }

    const errorDecos: vscode.DecorationOptions[] = [];
    for (const [line, message] of this.errors) {
      const range = this.lineEnd(line);
      if (!range) continue;
      errorDecos.push({
        range,
        renderOptions: { after: { contentText: truncate(`✗ ${message}`) } },
      });
    }

    const coverageDecos: Record<CoverageState, vscode.Range[]> = {
      covered: [],
      uncovered: [],
      partial: [],
    };
    for (const [line, state] of this.coverage) {
      if (line < 1 || line > this.doc.lineCount) continue;
      const start = this.doc.lineAt(line - 1).range.start;
      coverageDecos[state].push(new vscode.Range(start, start));
    }

    for (const editor of editors) {
      editor.setDecorations(this.valueType, valueDecos);
      editor.setDecorations(this.errorType, errorDecos);
      for (const state of ["covered", "uncovered", "partial"] as const) {
        editor.setDecorations(this.coverageTypes[state], coverageDecos[state]);
      }
    }
  }

  private lineEnd(line: number): vscode.Range | undefined {
    if (line < 1 || line > this.doc.lineCount) return undefined;
    const end = this.doc.lineAt(line - 1).range.end;
    return new vscode.Range(end, end);
  }

  dispose(): void {
    this.valueType.dispose();
    this.errorType.dispose();
    for (const type of Object.values(this.coverageTypes)) type.dispose();
  }
}
