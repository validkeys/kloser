import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ClaudeRunError, runClaude } from "./claudeRunner";
import type { ClaudeRunHandle } from "./claudeRunner";
import { buildChildEnv, getKloserConfig } from "./config";
import { DecorationManager } from "./decorationManager";
import { buildReplacementPrompt } from "./prompt";
import { extractContext, resolveRunCwd, stripCodeFences } from "./util";

export interface RequestManagerDeps {
  decorations: DecorationManager;
  log: vscode.OutputChannel;
  onActiveCountChanged: (count: number) => void;
}

export class RequestManager implements vscode.Disposable {
  private readonly handles = new Map<string, ClaudeRunHandle>();

  constructor(private readonly deps: RequestManagerDeps) {}

  public start(editor: vscode.TextEditor, range: vscode.Range, instruction: string): void {
    const config = getKloserConfig();
    const document = editor.document;
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const context = extractContext(document, range, config.contextLines);
    const prompt = buildReplacementPrompt({
      afterContext: context.afterContext,
      beforeContext: context.beforeContext,
      instruction,
      languageId: document.languageId,
      relativePath,
      selectedCode: document.getText(range),
    });

    const id = randomUUID();

    const lineLabel = `${range.start.line + 1}-${range.end.line + 1}`;
    this.deps.log.appendLine(`[${new Date().toISOString()}] request ${id} started: ${relativePath} lines ${lineLabel}`);
    this.deps.log.appendLine(`[${new Date().toISOString()}] instruction: ${instruction}`);

    this.deps.decorations.track(id, document.uri, range);
    const handle = runClaude({
      cwd: resolveRunCwd(document),
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      prompt,
    });
    this.handles.set(id, handle);
    this.notifyActiveCountChanged();

    handle.result
      .then((output) => this.completeRequest(id, document.uri, output))
      .catch((error: unknown) => this.failRequest(id, error));
  }

  public stopAll(): void {
    for (const handle of this.handles.values()) {
      handle.cancel();
    }
  }

  public get activeCount(): number {
    return this.handles.size;
  }

  public dispose(): void {
    this.stopAll();
  }

  private completeRequest(id: string, uri: vscode.Uri, output: string): void {
    this.handles.delete(id);
    this.notifyActiveCountChanged();

    const replacement = stripCodeFences(output);
    if (!replacement) {
      this.deps.decorations.settle(id, "error");
      void vscode.window
        .showErrorMessage("Kloser: the agent returned an empty response.", "Show Logs")
        .then(showLogsIfRequested(this.deps.log));
      return;
    }

    const range = this.deps.decorations.settle(id, "done");
    if (!range) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, replacement);
    void vscode.workspace.applyEdit(edit).then((applied) => {
      if (!applied) {
        void vscode.window.showWarningMessage(
          "Kloser: could not apply the agent's edit to the document.",
        );
      }
    });
    this.deps.log.appendLine(`[${new Date().toISOString()}] request ${id} completed`);
  }

  private failRequest(id: string, error: unknown): void {
    this.handles.delete(id);
    this.notifyActiveCountChanged();

    if (error instanceof ClaudeRunError && error.cancelled) {
      this.deps.decorations.remove(id);
      this.deps.log.appendLine(`[${new Date().toISOString()}] request ${id} cancelled`);
      return;
    }
    this.deps.decorations.settle(id, "error");
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log.appendLine(`[${new Date().toISOString()}] request ${id} failed: ${message}`);
    void vscode.window
      .showErrorMessage(`Kloser: ${message}`, "Show Logs")
      .then(showLogsIfRequested(this.deps.log));
  }

  private notifyActiveCountChanged(): void {
    this.deps.onActiveCountChanged(this.handles.size);
  }
}

function showLogsIfRequested(log: vscode.OutputChannel): (choice: string | undefined) => void {
  return (choice) => {
    if (choice === "Show Logs") {
      log.show();
    }
  };
}
