import * as vscode from "vscode";

const MAX_LINE_RENDER = 120;
const MAX_VALUES_PER_LINE = 100;

function truncate(text: string): string {
  if (text.length <= MAX_LINE_RENDER) return text;
  let cut = text.slice(0, MAX_LINE_RENDER - 1);
  // don't split a surrogate pair at the cut point
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + "…";
}

export type CoverageState = "covered" | "uncovered" | "partial";

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
   * Value previews keyed by capture siteId, so a single evolving value (a
   * settling promise) can REPLACE its own slot rather than appending. Console
   * output isn't site-attributed, so it gets a separate line-keyed bucket.
   */
  private siteValues = new Map<number, { line: number; previews: string[] }>();
  private consoleValues = new Map<number, string[]>();
  private errors = new Map<number, string>();
  private coverage = new Map<number, CoverageState>();

  constructor(private readonly doc: vscode.TextDocument) {}

  /** Append a fresh capture for a site (loops produce several). */
  addSiteValue(siteId: number, line: number, preview: string): void {
    let entry = this.siteValues.get(siteId);
    if (!entry) this.siteValues.set(siteId, (entry = { line, previews: [] }));
    if (entry.previews.length < MAX_VALUES_PER_LINE) entry.previews.push(preview);
    this.apply();
  }

  /** Replace a site's latest preview in place — a value that EVOLVED (a promise
   * settling pending → then/catch). Falls back to append if the site is unseen. */
  updateSiteValue(siteId: number, line: number, preview: string): void {
    const entry = this.siteValues.get(siteId);
    if (entry && entry.previews.length > 0) entry.previews[entry.previews.length - 1] = preview;
    else this.addSiteValue(siteId, line, preview);
    this.apply();
  }

  /** Console output (not site-attributed) for a line. */
  addValue(line: number, preview: string): void {
    let list = this.consoleValues.get(line);
    if (!list) this.consoleValues.set(line, (list = []));
    if (list.length < MAX_VALUES_PER_LINE) list.push(preview);
    this.apply();
  }

  setError(line: number, message: string): void {
    this.errors.set(line, message);
    this.apply();
  }

  setCoverage(coverage: Map<number, CoverageState>): void {
    this.coverage = coverage;
    this.apply();
  }

  clear(): void {
    this.siteValues.clear();
    this.consoleValues.clear();
    this.errors.clear();
    this.coverage.clear();
    this.apply();
  }

  /** Re-apply to current editors (tab switches recreate TextEditor objects). */
  reapply(): void {
    this.apply();
  }

  private apply(): void {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === this.doc);
    if (editors.length === 0) return;

    // Aggregate site previews (in capture order) + console output by line,
    // joined into one end-of-line decoration per line.
    const byLine = new Map<number, string[]>();
    const pushLine = (line: number, preview: string) => {
      const list = byLine.get(line) ?? [];
      list.push(preview);
      byLine.set(line, list);
    };
    for (const { line, previews } of this.siteValues.values()) {
      for (const p of previews) pushLine(line, p);
    }
    for (const [line, previews] of this.consoleValues) {
      for (const p of previews) pushLine(line, p);
    }

    const valueDecos: vscode.DecorationOptions[] = [];
    for (const [line, previews] of byLine) {
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
