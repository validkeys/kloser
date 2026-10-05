import * as path from "node:path";
import * as vscode from "vscode";
import { remapRange } from "./util";

export type BlockStatus = "done" | "error" | "running";

interface TrackedBlock {
  id: string;
  range: vscode.Range;
  status: BlockStatus;
  uri: vscode.Uri;
}

const DONE_LINGER_MS = 3000;
const ERROR_LINGER_MS = 10000;
const SPINNER_FRAME_COUNT = 6;
const SPINNER_INTERVAL_MS = 110;

export class DecorationManager implements vscode.Disposable {
  private readonly blocks = new Map<string, TrackedBlock>();
  private readonly changeListener: vscode.Disposable;
  private currentFrame = 0;
  private readonly doneType: vscode.TextEditorDecorationType;
  private readonly errorType: vscode.TextEditorDecorationType;
  private readonly frameTypes: vscode.TextEditorDecorationType[];
  private spinnerTimer: NodeJS.Timeout | undefined;

  constructor(extensionPath: string) {
    const mediaUri = (name: string): vscode.Uri =>
      vscode.Uri.file(path.join(extensionPath, "media", name));

    this.frameTypes = Array.from({ length: SPINNER_FRAME_COUNT }, (_, frame) =>
      vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(129, 140, 248, 0.08)",
        gutterIconPath: mediaUri(`spinner-${frame}.svg`),
        gutterIconSize: "contain",
        isWholeLine: true,
        overviewRulerColor: "rgba(129, 140, 248, 0.7)",
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      }),
    );
    this.doneType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(34, 197, 94, 0.10)",
      gutterIconPath: mediaUri("done.svg"),
      gutterIconSize: "contain",
      isWholeLine: true,
    });
    this.errorType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(239, 68, 68, 0.10)",
      gutterIconPath: mediaUri("error.svg"),
      gutterIconSize: "contain",
      isWholeLine: true,
    });
    this.changeListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.onDocumentChanged(event),
    );
  }

  public track(id: string, uri: vscode.Uri, range: vscode.Range): void {
    this.blocks.set(id, { id, range, status: "running", uri });
    this.syncSpinnerTimer();
    this.render();
  }

  public settle(id: string, status: "done" | "error"): vscode.Range | undefined {
    const block = this.blocks.get(id);
    if (!block) {
      return undefined;
    }
    block.status = status;
    const range = block.range;
    const lingerMs = status === "done" ? DONE_LINGER_MS : ERROR_LINGER_MS;
    setTimeout(() => {
      if (this.blocks.get(id)?.status === status) {
        this.blocks.delete(id);
        this.render();
      }
    }, lingerMs);
    this.syncSpinnerTimer();
    this.render();
    return range;
  }

  public remove(id: string): void {
    if (this.blocks.delete(id)) {
      this.syncSpinnerTimer();
      this.render();
    }
  }

  public dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.changeListener.dispose();
    for (const type of this.frameTypes) {
      type.dispose();
    }
    this.doneType.dispose();
    this.errorType.dispose();
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const uriKey = event.document.uri.toString();
    let affected = false;
    for (const block of this.blocks.values()) {
      if (block.uri.toString() !== uriKey) {
        continue;
      }
      affected = true;
      for (const change of event.contentChanges) {
        block.range = remapRange(block.range, change);
      }
    }
    if (affected) {
      this.render();
    }
  }

  private syncSpinnerTimer(): void {
    const hasRunning = [...this.blocks.values()].some((block) => block.status === "running");
    if (hasRunning && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.currentFrame = (this.currentFrame + 1) % SPINNER_FRAME_COUNT;
        this.render();
      }, SPINNER_INTERVAL_MS);
      return;
    }
    if (!hasRunning && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      this.currentFrame = 0;
    }
  }

  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const uriKey = editor.document.uri.toString();
      const doneRanges: vscode.Range[] = [];
      const errorRanges: vscode.Range[] = [];
      const runningRanges: vscode.Range[] = [];
      for (const block of this.blocks.values()) {
        if (block.uri.toString() !== uriKey) {
          continue;
        }
        if (block.status === "running") {
          runningRanges.push(block.range);
        } else if (block.status === "done") {
          doneRanges.push(block.range);
        } else {
          errorRanges.push(block.range);
        }
      }
      this.frameTypes.forEach((type, frame) => {
        editor.setDecorations(type, frame === this.currentFrame ? runningRanges : []);
      });
      editor.setDecorations(this.doneType, doneRanges);
      editor.setDecorations(this.errorType, errorRanges);
    }
  }
}
