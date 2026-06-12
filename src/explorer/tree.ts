import * as vscode from "vscode";
import type { RemoteValue } from "../../protocol/index.ts";
import type { ExpandOutcome, QuollSession } from "../session.ts";

/**
 * Value explorer (phase 5): tree of the current run's captured values.
 * Roots = capture sites (latest preview, by source line); a site captured
 * multiple times (loop) lists each capture; objects expand lazily via the
 * protocol `expand` round-trip against the lingering runner process.
 */

type Node =
  /** One capture site; `values` is its capture history (latest last). */
  | { kind: "site"; line: number; values: RemoteValue[] }
  /** One value: an individual capture (`#n`) or an expansion entry (key). */
  | { kind: "value"; label: string; value: RemoteValue }
  /** Non-interactive placeholder (expansion errors). */
  | { kind: "info"; label: string };

export class ValueExplorer implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private session: QuollSession | undefined;
  private sessionSub: vscode.Disposable | undefined;

  setSession(session: QuollSession | undefined): void {
    this.sessionSub?.dispose();
    this.session = session;
    this.sessionSub = session?.onDidUpdate(() => this.changeEmitter.fire(undefined));
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "site": {
        const latest = node.values[node.values.length - 1]!;
        const expandable = node.values.length > 1 || latest.objectId !== undefined;
        const item = new vscode.TreeItem(latest.preview, collapsible(expandable));
        item.description =
          `line ${node.line}` + (node.values.length > 1 ? ` · ×${node.values.length}` : "");
        item.tooltip = latest.preview;
        item.contextValue = "quollValue";
        return item;
      }
      case "value": {
        const item = new vscode.TreeItem(
          node.label,
          collapsible(node.value.objectId !== undefined),
        );
        item.description = node.value.preview;
        item.tooltip = node.value.preview;
        item.contextValue = "quollValue";
        return item;
      }
      case "info":
        return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.session) return [];
    if (!node) {
      return this.session
        .valueRoots()
        .map((r) => ({ kind: "site" as const, line: r.line, values: r.values }));
    }
    if (node.kind === "site") {
      if (node.values.length > 1) {
        return node.values.map((value, i) => ({
          kind: "value" as const,
          label: `#${i + 1}`,
          value,
        }));
      }
      return this.expandValue(node.values[0]!);
    }
    if (node.kind === "value") return this.expandValue(node.value);
    return [];
  }

  /** What `quoll.copyValue` puts on the clipboard for this node. */
  copyText(node: Node): string | undefined {
    switch (node.kind) {
      case "site":
        return node.values[node.values.length - 1]?.preview;
      case "value":
        return node.value.preview;
      case "info":
        return undefined;
    }
  }

  private async expandValue(value: RemoteValue): Promise<Node[]> {
    if (value.objectId === undefined || !this.session) return [];
    const outcome: ExpandOutcome = await this.session.expand(value.objectId);
    if ("error" in outcome) {
      return [{ kind: "info", label: expandErrorLabel(outcome.error) }];
    }
    return outcome.entries.map((e) => ({ kind: "value" as const, label: e.key, value: e.value }));
  }

  dispose(): void {
    this.sessionSub?.dispose();
    this.changeEmitter.dispose();
  }
}

function collapsible(expandable: boolean): vscode.TreeItemCollapsibleState {
  return expandable
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
}

function expandErrorLabel(error: "evicted" | "unknown" | "gone"): string {
  switch (error) {
    case "evicted":
      return "(value evicted under the runner's memory budget — re-run to inspect)";
    case "unknown":
    case "gone":
      return "(value no longer available — re-run to inspect)";
  }
}
