import * as vscode from "vscode";
import { remapRange } from "./util";

const APPLY_THROTTLE_MS = 80;

export class StreamApplier implements vscode.Disposable {
  private firstApply = true;
  private readonly originalText: string;
  private pendingText: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private range: vscode.Range;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly uri: vscode.Uri,
    document: vscode.TextDocument,
    range: vscode.Range,
  ) {
    this.originalText = document.getText(range);
    this.range = range;
  }

  public update(text: string): void {
    this.pendingText = text;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, APPLY_THROTTLE_MS);
  }

  public finalize(text: string): void {
    this.cancelTimer();
    this.pendingText = undefined;
    this.enqueue(text, true);
  }

  public restore(): void {
    this.cancelTimer();
    this.pendingText = undefined;
    this.enqueue(this.originalText, true);
  }

  public dispose(): void {
    this.cancelTimer();
    this.pendingText = undefined;
  }

  public adjustForChanges(event: vscode.TextDocumentChangeEvent): void {
    for (const change of event.contentChanges) {
      if (this.isOwnChange(change)) {
        continue;
      }
      this.range = remapRange(this.range, change);
    }
  }

  private isOwnChange(change: vscode.TextDocumentContentChangeEvent): boolean {
    return (
      change.range.start.isAfterOrEqual(this.range.start) &&
      change.range.end.isBeforeOrEqual(this.range.end)
    );
  }

  private flushPending(): void {
    if (this.pendingText === undefined) {
      return;
    }
    const text = this.pendingText;
    this.pendingText = undefined;
    this.enqueue(text, false);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private enqueue(text: string, last: boolean): void {
    const first = this.firstApply;
    this.queue = this.queue
      .then(() => this.apply(text, first, last))
      .catch(() => {
        // the editor may be gone mid-stream; drop further updates
      });
  }

  private async apply(text: string, first: boolean, last: boolean): Promise<void> {
    const editor = this.resolveEditor();
    if (!editor) {
      return;
    }
    const end = endPositionFrom(this.range.start, text);
    const target = end.isBefore(this.range.start)
      ? new vscode.Range(this.range.start, this.range.start)
      : new vscode.Range(this.range.start, end);
    const replaced = this.range;
    const success = await editor.edit(
      (editBuilder) => {
        editBuilder.replace(replaced, text);
      },
      { undoStopAfter: last, undoStopBefore: first },
    );
    if (success) {
      this.firstApply = false;
      this.range = target;
    }
  }

  private resolveEditor(): vscode.TextEditor | undefined {
    const uriKey = this.uri.toString();
    return (
      vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.toString() === uriKey,
      ) ??
      (vscode.window.activeTextEditor?.document.uri.toString() === uriKey
        ? vscode.window.activeTextEditor
        : undefined)
    );
  }
}

function endPositionFrom(start: vscode.Position, text: string): vscode.Position {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return new vscode.Position(start.line, start.character + lines[0].length);
  }
  return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}
