import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ClaudeRunError, runClaude } from "./claudeRunner";
import type { ClaudeRunHandle } from "./claudeRunner";
import { buildChildEnv, getKloserConfig } from "./config";
import { DecorationManager } from "./decorationManager";
import { loadReviewGuidelines } from "./guidelines";
import { buildReviewPrompt } from "./prompt";
import { ReviewPane } from "./reviewWebview";
import { extractContext, remapRange, resolveRunCwd } from "./util";

interface ReviewSession {
  cwd: string;
  followupHandle?: ClaudeRunHandle;
  pane: ReviewPane;
  range: vscode.Range;
  sessionId?: string;
  uri: vscode.Uri;
}

export interface ReviewManagerDeps {
  decorations: DecorationManager;
  log: vscode.OutputChannel;
  onActiveCountChanged: (count: number) => void;
}

export class ReviewManager implements vscode.Disposable {
  private readonly docListener: vscode.Disposable;
  private readonly handles = new Map<string, ClaudeRunHandle>();
  private readonly sessions = new Set<ReviewSession>();

  constructor(private readonly deps: ReviewManagerDeps) {
    this.docListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.remapSessions(event),
    );
  }

  public async start(editor: vscode.TextEditor, range: vscode.Range): Promise<void> {
    const config = getKloserConfig();
    const document = editor.document;
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const lineLabel = `${range.start.line + 1}-${range.end.line + 1}`;

    const guidelines = await loadReviewGuidelines(document);
    if (guidelines.repoRoot && !guidelines.combined) {
      void vscode.window.showInformationMessage(
        `Kloser: no code-review guidelines found in ${path.join(guidelines.repoRoot, ".kloser")} — using the built-in review prompt.`,
      );
    }

    const context = extractContext(document, range, config.contextLines);
    const prompt = buildReviewPrompt({
      afterContext: context.afterContext,
      beforeContext: context.beforeContext,
      guidelines: guidelines.combined,
      languageId: document.languageId,
      relativePath,
      selectedCode: document.getText(range),
      startLine: range.start.line,
    });

    const id = randomUUID();
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] review ${id} started: ${relativePath} lines ${lineLabel}` +
        (guidelines.languageFile ? ` (guidelines: ${guidelines.languageFile})` : ""),
    );

    let session: ReviewSession;
    const pane = new ReviewPane(`Kloser Review — ${relativePath} L${range.start.line + 1}`, {
      onApply: (code) => {
        if (session) {
          this.applyCode(session, code);
        }
      },
      onDisposed: () => {
        if (session) {
          this.endSession(session);
        }
      },
      onFollowup: (text) => {
        if (session) {
          this.runFollowup(session, text);
        }
      },
    });
    session = {
      cwd: resolveRunCwd(document),
      pane,
      range,
      uri: document.uri,
    };
    this.sessions.add(session);

    this.deps.decorations.track(id, document.uri, range);
    pane.beginAssistantTurn();
    const handle = runClaude({
      cwd: session.cwd,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (text) => {
        pane.appendAssistantDelta(text);
      },
      prompt,
    });
    this.handles.set(id, handle);
    this.notifyActiveCountChanged();

    void handle.sessionId.then((sessionId) => {
      session.sessionId = sessionId;
    });

    handle.result
      .then((final) => {
        this.deps.decorations.settle(id, "done");
        pane.finishAssistantTurn(final.trim() || undefined);
        this.deps.log.appendLine(`[${new Date().toISOString()}] review ${id} completed`);
      })
      .catch((error: unknown) => {
        if (error instanceof ClaudeRunError && error.cancelled) {
          this.deps.decorations.remove(id);
          pane.failTurn("_Review cancelled._");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.deps.decorations.settle(id, "error");
        pane.failTurn(`**Review failed.** ${message}`);
        this.deps.log.appendLine(`[${new Date().toISOString()}] review ${id} failed: ${message}`);
      })
      .finally(() => {
        this.handles.delete(id);
        this.notifyActiveCountChanged();
      });
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
    for (const session of [...this.sessions]) {
      session.pane.dispose();
    }
    this.docListener.dispose();
  }

  private runFollowup(session: ReviewSession, text: string): void {
    if (session.followupHandle) {
      void vscode.window.showWarningMessage("Kloser: the reviewer is still responding.");
      return;
    }
    if (!session.sessionId) {
      void vscode.window.showInformationMessage(
        "Kloser: wait for the initial review to finish before sending follow-ups.",
      );
      return;
    }
    const config = getKloserConfig();
    session.pane.appendUserTurn(text);

    const id = randomUUID();
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] follow-up ${id} sent: ${text.slice(0, 200)}`,
    );
    this.deps.decorations.track(id, session.uri, session.range);
    session.pane.beginAssistantTurn();
    const handle = runClaude({
      cwd: session.cwd,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (delta) => {
        session.pane.appendAssistantDelta(delta);
      },
      prompt: text,
      resumeSessionId: session.sessionId,
    });
    session.followupHandle = handle;
    this.handles.set(id, handle);
    this.notifyActiveCountChanged();

    handle.result
      .then((final) => {
        this.deps.decorations.settle(id, "done");
        session.pane.finishAssistantTurn(final.trim() || undefined);
        this.deps.log.appendLine(`[${new Date().toISOString()}] follow-up ${id} completed`);
      })
      .catch((error: unknown) => {
        if (error instanceof ClaudeRunError && error.cancelled) {
          this.deps.decorations.remove(id);
          session.pane.failTurn("_Follow-up cancelled._");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.deps.decorations.settle(id, "error");
        session.pane.failTurn(`**Follow-up failed.** ${message}`);
        this.deps.log.appendLine(`[${new Date().toISOString()}] follow-up ${id} failed: ${message}`);
      })
      .finally(() => {
        session.followupHandle = undefined;
        this.handles.delete(id);
        this.notifyActiveCountChanged();
      });
  }

  private applyCode(session: ReviewSession, code: string): void {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(session.uri, session.range, code);
    void vscode.workspace.applyEdit(edit).then((applied) => {
      if (!applied) {
        void vscode.window.showWarningMessage(
          "Kloser: could not apply the proposed code to the document.",
        );
        return;
      }
      this.deps.log.appendLine(`[${new Date().toISOString()}] applied proposed code to block`);
    });
  }

  private endSession(session: ReviewSession): void {
    if (session.followupHandle) {
      session.followupHandle.cancel();
    }
    this.sessions.delete(session);
  }

  private remapSessions(event: vscode.TextDocumentChangeEvent): void {
    const uriKey = event.document.uri.toString();
    let affected = false;
    for (const session of this.sessions) {
      if (session.uri.toString() !== uriKey) {
        continue;
      }
      affected = true;
      for (const change of event.contentChanges) {
        session.range = remapRange(session.range, change);
      }
    }
    if (affected) {
      this.deps.log.appendLine(`[${new Date().toISOString()}] review anchors remapped after edit`);
    }
  }

  private notifyActiveCountChanged(): void {
    this.deps.onActiveCountChanged(this.handles.size);
  }
}
