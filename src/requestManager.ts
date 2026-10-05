import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ClaudeRunError, runClaude } from "./claudeRunner";
import type { ClaudeRunHandle } from "./claudeRunner";
import { buildChildEnv, getKloserConfig } from "./config";
import { DecorationManager } from "./decorationManager";
import { buildRedirectPrompt, buildReplacementPrompt } from "./prompt";
import { StreamApplier } from "./streamApplier";
import { extractContext, resolveRunCwd, stripCodeFences } from "./util";

type StreamState = "finalizing" | "pending" | "redirecting" | "streaming";

interface ActiveStream {
  applier: StreamApplier;
  buffered: string;
  cwd: string;
  handle?: ClaudeRunHandle;
  id: string;
  instruction: string;
  sessionId?: string;
  state: StreamState;
  uri: vscode.Uri;
}

export interface RequestManagerDeps {
  decorations: DecorationManager;
  log: vscode.OutputChannel;
  onActiveCountChanged: (count: number) => void;
}

export class RequestManager implements vscode.Disposable {
  private active?: ActiveStream;
  private readonly docListener: vscode.Disposable;
  private readonly handles = new Map<string, ClaudeRunHandle>();

  constructor(private readonly deps: RequestManagerDeps) {
    this.docListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.onDocumentChanged(event),
    );
  }

  public get hasActiveStream(): boolean {
    return this.active !== undefined;
  }

  public get activeInstruction(): string | undefined {
    return this.active?.instruction;
  }

  public start(editor: vscode.TextEditor, range: vscode.Range, instruction: string): void {
    if (this.active) {
      void vscode.window.showWarningMessage(
        "Kloser: a stream is already active — Tab to accept, Esc to reject, or run the command again to redirect it.",
      );
      return;
    }
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

    const stream: ActiveStream = {
      applier: new StreamApplier(document.uri, document, range),
      buffered: "",
      cwd: resolveRunCwd(document),
      id: randomUUID(),
      instruction,
      state: "streaming",
      uri: document.uri,
    };
    this.active = stream;
    void vscode.commands.executeCommand("setContext", "kloser.streamActive", true);
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] stream ${stream.id} started: ${relativePath} lines ${range.start.line + 1}-${range.end.line + 1}`,
    );
    vscode.window.setStatusBarMessage(
      "Kloser streaming — Tab: accept · Esc: reject · Ctrl+Shift+9: redirect",
      8000,
    );
    this.deps.decorations.track(stream.id, document.uri, range);
    this.dispatch(stream, prompt);
  }

  public accept(): void {
    const stream = this.active;
    if (!stream || stream.state === "finalizing" || stream.state === "redirecting") {
      return;
    }
    if (stream.state === "streaming") {
      const text = stripCodeFences(stream.buffered);
      if (!text) {
        void vscode.window.showWarningMessage(
          "Kloser: nothing has streamed yet — Esc to reject.",
        );
        return;
      }
      stream.state = "finalizing";
      stream.handle?.cancel();
      stream.applier.finalize(text);
    } else {
      stream.state = "finalizing";
    }
    this.deps.decorations.settle(stream.id, "done");
    this.deps.log.appendLine(`[${new Date().toISOString()}] stream ${stream.id} accepted`);
    this.cleanup(stream);
  }

  public reject(): void {
    const stream = this.active;
    if (!stream || stream.state === "finalizing" || stream.state === "redirecting") {
      return;
    }
    stream.state = "finalizing";
    stream.handle?.cancel();
    stream.applier.restore();
    this.deps.decorations.remove(stream.id);
    this.deps.log.appendLine(`[${new Date().toISOString()}] stream ${stream.id} rejected`);
    this.cleanup(stream);
  }

  public redirect(correction: string): void {
    const stream = this.active;
    if (!stream || stream.state === "finalizing" || stream.state === "redirecting") {
      return;
    }
    if (!stream.sessionId) {
      void vscode.window.showWarningMessage(
        "Kloser: no session yet — wait for the first tokens to stream, then redirect.",
      );
      return;
    }
    if (stream.state === "streaming") {
      stream.state = "redirecting";
      stream.handle?.cancel();
    }
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] stream ${stream.id} redirected: ${correction.slice(0, 200)}`,
    );
    const prompt = buildRedirectPrompt(stream.instruction, correction);
    this.dispatch(stream, prompt, stream.sessionId);
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
    this.docListener.dispose();
    void vscode.commands.executeCommand("setContext", "kloser.streamActive", false);
  }

  private dispatch(stream: ActiveStream, prompt: string, resumeSessionId?: string): void {
    const config = getKloserConfig();
    stream.state = "streaming";
    stream.buffered = "";
    this.deps.decorations.setStatus(stream.id, "running");
    const handle = runClaude({
      cwd: stream.cwd,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (text) => {
        stream.buffered += text;
        stream.applier.update(stream.buffered);
      },
      prompt,
      resumeSessionId,
    });
    stream.handle = handle;
    this.handles.set(stream.id, handle);
    this.notifyActiveCountChanged();

    void handle.sessionId.then((sessionId) => {
      if (this.active === stream && sessionId) {
        stream.sessionId = sessionId;
      }
    });

    handle.result
      .then((final) => {
        if (this.active === stream && stream.handle === handle) {
          this.completeStream(stream, final);
        }
      })
      .catch((error: unknown) => {
        if (this.active === stream && stream.handle === handle) {
          this.failStream(stream, error);
        }
      })
      .finally(() => {
        if (stream.handle === handle) {
          this.handles.delete(stream.id);
        }
        this.notifyActiveCountChanged();
      });
  }

  private completeStream(stream: ActiveStream, final: string): void {
    const text = stripCodeFences(final);
    if (!text) {
      this.failStream(stream, new Error("the agent returned an empty response"));
      return;
    }
    stream.state = "pending";
    stream.applier.finalize(text);
    this.deps.decorations.setStatus(stream.id, "pending");
    this.deps.log.appendLine(`[${new Date().toISOString()}] stream ${stream.id} completed — pending review (Tab/Esc)`);
  }

  private failStream(stream: ActiveStream, error: unknown): void {
    if (stream.state === "finalizing" || stream.state === "redirecting") {
      return;
    }
    if (error instanceof ClaudeRunError && error.cancelled) {
      // stopped externally (e.g. stop-all) while live: revert like a reject
      this.reject();
      return;
    }
    stream.state = "finalizing";
    stream.applier.restore();
    this.deps.decorations.settle(stream.id, "error");
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log.appendLine(`[${new Date().toISOString()}] stream ${stream.id} failed: ${message}`);
    void vscode.window
      .showErrorMessage(`Kloser: ${message}`, "Show Logs")
      .then(showLogsIfRequested(this.deps.log));
    this.cleanup(stream);
  }

  private cleanup(stream: ActiveStream): void {
    if (this.active !== stream) {
      return;
    }
    this.active = undefined;
    stream.applier.dispose();
    this.handles.delete(stream.id);
    this.notifyActiveCountChanged();
    void vscode.commands.executeCommand("setContext", "kloser.streamActive", false);
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const stream = this.active;
    if (!stream || stream.uri.toString() !== event.document.uri.toString()) {
      return;
    }
    stream.applier.adjustForChanges(event);
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
