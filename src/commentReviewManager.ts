import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { runClaude } from "./claudeRunner";
import type { ClaudeRunHandle } from "./claudeRunner";
import { buildChildEnv, getKloserConfig } from "./config";
import { buildPrCommentsPrompt } from "./prompt";
import { ReviewPane } from "./reviewWebview";
import { applyCodeAtTarget, parseApplies } from "./pr/applyTargets";
import type { PendingApply } from "./pr/applyTargets";
import { scanMarkerComments } from "./pr/commentScan";
import { listTrackedFiles, workspaceRoot } from "./pr/prData";

interface CommentSession {
  handle?: ClaudeRunHandle;
  pane: ReviewPane;
  pendingApplies: PendingApply[];
  root: string;
  sessionId?: string;
}

export interface CommentReviewManagerDeps {
  log: vscode.OutputChannel;
  onActiveCountChanged: (count: number) => void;
}

export class CommentReviewManager implements vscode.Disposable {
  private session?: CommentSession;
  private readonly handles = new Map<string, ClaudeRunHandle>();

  constructor(private readonly deps: CommentReviewManagerDeps) {}

  public get activeCount(): number {
    return this.handles.size;
  }

  public async review(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("Kloser: open a workspace folder first.");
      return;
    }
    if (this.session) {
      void vscode.window.showWarningMessage(
        "Kloser: a ? comment review is already open in the pane.",
      );
      return;
    }
    const files = await listTrackedFiles(root).catch(() => []);
    if (!files.length) {
      void vscode.window.showWarningMessage(
        "Kloser: no git-tracked files found — is this a git repository?",
      );
      return;
    }
    const comments = await scanMarkerComments(root, files);
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] comment review: scanned ${files.length} tracked files, found ${comments.length} marker comment(s)`,
    );
    for (const comment of comments) {
      this.deps.log.appendLine(`  ${comment.file}:${comment.line} — ? ${comment.text}`);
    }
    if (!comments.length) {
      vscode.window.setStatusBarMessage(
        "Kloser: no ? comments found — add `// ? like this` and rerun",
        8000,
      );
      void vscode.window.showInformationMessage(
        "Kloser: no ? comments found in tracked files. Add comments like `// ? why this?` and run again.",
      );
      return;
    }

    let session: CommentSession;
    const pane = new ReviewPane(
      "Kloser — ? Comments",
      {
        onApply: (code) => {
          if (session) {
            void this.applyFix(session, code);
          }
        },
        onDisposed: () => {
          if (session) {
            this.endSession(session);
          }
        },
        onFollowup: (text) => {
          if (session) {
            this.run(session, { userText: text });
          }
        },
      },
      { enableApply: true },
    );
    session = { pane, pendingApplies: [], root };
    this.session = session;

    this.run(session, {
      note:
        `Found ${comments.length} ? comment(s):\n\n` +
        comments
          .slice(0, 30)
          .map((comment) => `- \`${comment.file}:${comment.line}\` ? ${comment.text}`)
          .join("\n") +
        (comments.length > 30 ? `\n- …and ${comments.length - 30} more (see Show Logs)` : ""),
      prompt: buildPrCommentsPrompt({ comments }),
    });
  }

  public stopAll(): void {
    for (const handle of this.handles.values()) {
      handle.cancel();
    }
  }

  public dispose(): void {
    this.stopAll();
  }

  private run(
    session: CommentSession,
    args: { note?: string; prompt?: string; userText?: string },
  ): void {
    if (session.handle) {
      session.pane.note("_The agent is still responding — try again once it finishes._");
      return;
    }
    let prompt = args.prompt;
    if (!prompt && args.userText) {
      if (!session.sessionId) {
        session.pane.note("_No session yet — wait for the first response._");
        return;
      }
      prompt = args.userText;
      session.pane.appendUserTurn(args.userText);
    } else if (args.note) {
      session.pane.note(`_${args.note}_`);
    }
    if (!prompt) {
      return;
    }
    const config = getKloserConfig();
    session.pane.beginAssistantTurn();
    const id = randomUUID();
    const handle = runClaude({
      cwd: session.root,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (text) => {
        session.pane.appendAssistantDelta(text);
      },
      prompt,
      resumeSessionId: args.userText ? session.sessionId : undefined,
    });
    session.handle = handle;
    this.handles.set(id, handle);
    this.notify();
    void handle.sessionId.then((sessionId) => {
      if (this.session === session && sessionId) {
        session.sessionId = sessionId;
      }
    });
    handle.result
      .then((final) => {
        session.pendingApplies.push(...parseApplies(final));
        session.pane.finishAssistantTurn(final.trim() || undefined);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ClaudeRunError") {
          session.pane.failTurn("_Request cancelled._");
        } else {
          const message = error instanceof Error ? error.message : String(error);
          session.pane.failTurn(`**Request failed.** ${message}`);
        }
      })
      .finally(() => {
        session.handle = undefined;
        this.handles.delete(id);
        this.notify();
      });
  }

  private async applyFix(session: CommentSession, code: string): Promise<void> {
    const match = session.pendingApplies.find(
      (pending) => pending.code.trim() === code.trim(),
    );
    if (!match) {
      void vscode.window.showWarningMessage(
        "Kloser: this code block has no apply target — ask the agent to include a kloser-apply line.",
      );
      return;
    }
    const result = await applyCodeAtTarget(session.root, match, code);
    if (result.ok) {
      session.pendingApplies = session.pendingApplies.filter((pending) => pending !== match);
      this.deps.log.appendLine(`[${new Date().toISOString()}] ${result.detail}`);
      return;
    }
    void vscode.window.showWarningMessage(`Kloser: ${result.detail}`);
  }

  private endSession(session: CommentSession): void {
    if (this.session !== session) {
      return;
    }
    this.session = undefined;
    session.handle?.cancel();
    this.notify();
  }

  private notify(): void {
    this.deps.onActiveCountChanged(this.handles.size);
  }
}
