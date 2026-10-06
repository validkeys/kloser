import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ClaudeRunError, runClaude } from "./claudeRunner";
import type { ClaudeRunHandle } from "./claudeRunner";
import { buildChildEnv, getKloserConfig, ConfigError } from "./config";
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

/**
 * Manages streaming code completion requests from Claude Code agent.
 * 
 * RequestManager handles the lifecycle of code completion requests:
 * - Starting new completions with user instructions
 * - Streaming incremental updates to the editor
 * - Accepting or rejecting completions
 * - Redirecting active completions with new instructions
 * - Managing multiple concurrent requests
 * 
 * @example
 * ```typescript
 * const manager = new RequestManager({
 *   decorations: decorationManager,
 *   log: outputChannel,
 *   onActiveCountChanged: (count) => updateStatusBar(count)
 * });
 * 
 * // Start a completion
 * manager.start(editor, range, "Add error handling");
 * 
 * // User accepts with Tab
 * manager.accept();
 * 
 * // Or rejects with Esc
 * manager.reject();
 * ```
 */
export class RequestManager implements vscode.Disposable {
  private active?: ActiveStream;
  private readonly docListener: vscode.Disposable;
  private readonly handles = new Map<string, ClaudeRunHandle>();
  private disposed = false;

  constructor(private readonly deps: RequestManagerDeps) {
    this.docListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.onDocumentChanged(event),
    );
  }

  /**
   * Returns true if there is currently an active streaming request.
   */
  public get hasActiveStream(): boolean {
    return this.active !== undefined;
  }

  /**
   * Returns the instruction text of the currently active stream, if any.
   */
  public get activeInstruction(): string | undefined {
    return this.active?.instruction;
  }

  /**
   * Starts a new code completion stream for the given editor selection.
   * 
   * @param editor - The text editor containing the code to modify
   * @param range - The range of code to replace
   * @param instruction - User's instruction describing what to do
   * 
   * @remarks
   * If a stream is already active, shows a warning message.
   * Configuration errors are caught and displayed to the user.
   */
  public start(editor: vscode.TextEditor, range: vscode.Range, instruction: string): void {
    if (this.disposed) {
      this.deps.log.appendLine("[RequestManager] Cannot start: manager disposed");
      return;
    }
    if (this.active) {
      void vscode.window.showWarningMessage(
        "Kloser: a stream is already active — Tab to accept, Esc to reject, or run the command again to redirect it.",
      );
      return;
    }
    
    let config;
    try {
      config = getKloserConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        this.deps.log.appendLine(`[Config] ${error.message}`);
        void vscode.window.showErrorMessage(`Kloser configuration error: ${error.message}`);
        return;
      }
      throw error;
    }
    
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

  /**
   * Accepts the currently streaming or pending completion.
   * 
   * @remarks
   * - If streaming: stops the stream and applies the current buffer
   * - If pending: accepts the completed suggestion
   * - If finalizing or redirecting: no-op
   * 
   * Typically triggered by the Tab key.
   */
  public accept(): void {
    if (this.disposed) return;
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

  /**
   * Rejects the currently streaming or pending completion.
   * 
   * @remarks
   * Cancels the stream, restores the original text, and cleans up.
   * If finalizing or redirecting: no-op
   * 
   * Typically triggered by the Escape key.
   */
  public reject(): void {
    if (this.disposed) return;
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

  /**
   * Redirects the active stream with a correction or clarification.
   * 
   * @param correction - Additional instruction to modify the agent's behavior
   * 
   * @remarks
   * Requires a session ID to be available (after first tokens stream).
   * Cancels the current stream and starts a new one with the correction.
   * If no session or already finalizing: shows a warning.
   */
  public redirect(correction: string): void {
    if (this.disposed) return;
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

  /**
   * Stops all active requests immediately.
   * 
   * @remarks
   * Cancels all Claude processes but does not trigger cleanup.
   * Used by the "Stop All Requests" command.
   */
  public stopAll(): void {
    for (const handle of this.handles.values()) {
      handle.cancel();
    }
  }

  /**
   * Returns the number of currently active handles (including background requests).
   */
  public get activeCount(): number {
    return this.handles.size;
  }

  /**
   * Disposes the request manager and cleans up all resources.
   * 
   * @remarks
   * - Stops all active requests
   * - Disposes document listener
   * - Clears context flag
   * - Cleans up active streams
   * - Idempotent: safe to call multiple times
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    
    this.stopAll();
    this.docListener.dispose();
    void vscode.commands.executeCommand("setContext", "kloser.streamActive", false);
    
    // Clean up active stream
    if (this.active) {
      this.active.applier.dispose();
      this.active = undefined;
    }
    
    // Clear all handles
    this.handles.clear();
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

    // Track session ID for redirects
    void handle.sessionId.then(
      (sessionId) => {
        if (this.active === stream && sessionId) {
          stream.sessionId = sessionId;
        }
      },
      (error) => {
        // Session ID resolution failed - log but don't fail the stream
        this.deps.log.appendLine(`[${new Date().toISOString()}] stream ${stream.id} session ID error: ${error}`);
      }
    );

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
      this.failStream(stream, new Error("The agent returned an empty response"));
      return;
    }
    // Additional validation: check for meaningful content
    if (text.trim().length === 0) {
      this.failStream(stream, new Error("The agent returned only whitespace"));
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
