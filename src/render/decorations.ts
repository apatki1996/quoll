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

/** Inline end-of-line decorations for one document: values and errors. */
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

  /** 1-based line -> previews observed this run (loops produce several). */
  private values = new Map<number, string[]>();
  private errors = new Map<number, string>();

  constructor(private readonly doc: vscode.TextDocument) {}

  addValue(line: number, preview: string): void {
    let list = this.values.get(line);
    if (!list) this.values.set(line, (list = []));
    if (list.length < MAX_VALUES_PER_LINE) list.push(preview);
    this.apply();
  }

  setError(line: number, message: string): void {
    this.errors.set(line, message);
    this.apply();
  }

  clear(): void {
    this.values.clear();
    this.errors.clear();
    this.apply();
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

    for (const editor of editors) {
      editor.setDecorations(this.valueType, valueDecos);
      editor.setDecorations(this.errorType, errorDecos);
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
  }
}
