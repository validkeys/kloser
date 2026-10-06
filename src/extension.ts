import * as vscode from "vscode";
import { CommentReviewManager } from "./commentReviewManager";
import { DecorationManager } from "./decorationManager";
import { RequestManager } from "./requestManager";
import { ReviewManager } from "./reviewManager";
import { PrBaseContentProvider, PR_BASE_SCHEME } from "./pr/baseContentProvider";
import { PrTourManager } from "./pr/prTourManager";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Kloser");
  const decorations = new DecorationManager(context.extensionPath);
  const statusItem = createStatusItem();
  const requests = new RequestManager({
    decorations,
    log,
    onActiveCountChanged: () => refreshStatus(),
  });
  const reviews = new ReviewManager({
    decorations,
    log,
    onActiveCountChanged: () => refreshStatus(),
  });
  const prTours = new PrTourManager({
    log,
    onActiveCountChanged: () => refreshStatus(),
  });
  const commentReviews = new CommentReviewManager({
    log,
    onActiveCountChanged: () => refreshStatus(),
  });

  function refreshStatus(): void {
    updateStatusItem(
      statusItem,
      requests.activeCount + reviews.activeCount + prTours.activeCount + commentReviews.activeCount,
    );
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const prBaseProvider = vscode.workspace.registerTextDocumentContentProvider(
    PR_BASE_SCHEME,
    new PrBaseContentProvider(workspaceRoot ?? ""),
  );

  const completeSelection = vscode.commands.registerTextEditorCommand(
    "kloser.completeSelection",
    (editor) => {
      if (requests.hasActiveStream) {
        promptForRedirect(requests);
        return;
      }
      promptForInstruction(editor, requests);
    },
  );
  const acceptStream = vscode.commands.registerCommand("kloser.acceptStream", () => {
    requests.accept();
  });
  const rejectStream = vscode.commands.registerCommand("kloser.rejectStream", () => {
    requests.reject();
  });
  const codeReview = vscode.commands.registerTextEditorCommand("kloser.codeReview", (editor) => {
    void reviews.start(editor, normalizeLineRange(editor));
  });
  const stopAllRequests = vscode.commands.registerCommand("kloser.stopAllRequests", () => {
    requests.stopAll();
    reviews.stopAll();
    prTours.stopAll();
    commentReviews.stopAll();
  });
  const reviewComments = vscode.commands.registerCommand("kloser.reviewComments", () => {
    void commentReviews.review();
  });
  const prReview = vscode.commands.registerCommand("kloser.pr.review", () => {
    void prTours.start();
  });
  const prNextSlice = vscode.commands.registerCommand("kloser.pr.nextSlice", () => {
    prTours.nextSlice();
  });
  const prToggleDiff = vscode.commands.registerCommand("kloser.pr.toggleDiff", () => {
    void prTours.toggleDiff();
  });
  const showLogs = vscode.commands.registerCommand("kloser.showLogs", () => {
    log.show();
  });

  context.subscriptions.push(
    completeSelection,
    acceptStream,
    rejectStream,
    codeReview,
    stopAllRequests,
    showLogs,
    reviewComments,
    prReview,
    prNextSlice,
    prToggleDiff,
    prBaseProvider,
    prTours,
    commentReviews,
    statusItem,
    decorations,
    requests,
    reviews,
    log,
  );
}

export function deactivate(): void {}

function createStatusItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = "Kloser";
  item.command = "kloser.stopAllRequests";
  item.tooltip = "Kloser: active agent requests (click to stop all)";
  return item;
}

function updateStatusItem(item: vscode.StatusBarItem, activeCount: number): void {
  if (activeCount) {
    item.text = `$(sync~spin) Kloser: ${activeCount}`;
    item.show();
    return;
  }
  item.hide();
}

function promptForInstruction(editor: vscode.TextEditor, requests: RequestManager): void {
  const range = normalizeLineRange(editor);
  const lineCount = range.end.line - range.start.line + 1;
  const lineLabel =
    range.start.line === range.end.line
      ? `line ${range.start.line + 1}`
      : `lines ${range.start.line + 1}-${range.end.line + 1}`;

  const input = vscode.window.createInputBox();
  input.title = `Kloser: agent on ${lineLabel} (${lineCount} line${lineCount === 1 ? "" : "s"})`;
  input.prompt = "Enter to dispatch · Escape or click away to cancel";
  input.placeholder = "Describe what the agent should do with the selected block…";
  input.onDidAccept(() => {
    input.hide();
    const instruction = input.value.trim();
    if (!instruction) {
      void vscode.window.showWarningMessage("Kloser: no instruction given — request cancelled.");
      return;
    }
    requests.start(editor, range, instruction);
  });
  input.onDidHide(() => {
    input.dispose();
  });
  input.show();
}

function promptForRedirect(requests: RequestManager): void {
  const original = requests.activeInstruction ?? "";
  const input = vscode.window.createInputBox();
  input.title = `Kloser: redirect the agent${original ? ` — was: "${original.slice(0, 80)}"` : ""}`;
  input.prompt = "Enter to redirect · Escape or click away to keep the current stream";
  input.placeholder = "e.g. no — reuse the existing config helper…";
  input.onDidAccept(() => {
    input.hide();
    const correction = input.value.trim();
    if (correction) {
      requests.redirect(correction);
    }
  });
  input.onDidHide(() => {
    input.dispose();
  });
  input.show();
}

function normalizeLineRange(editor: vscode.TextEditor): vscode.Range {
  const document = editor.document;
  const selection = editor.selection;
  if (selection.isEmpty) {
    const line = document.lineAt(selection.active.line);
    return new vscode.Range(line.lineNumber, 0, line.lineNumber, line.text.length);
  }
  let endLine = selection.end.line;
  if (selection.end.character === 0 && endLine > selection.start.line) {
    endLine -= 1;
  }
  return new vscode.Range(
    selection.start.line,
    0,
    endLine,
    document.lineAt(endLine).text.length,
  );
}
