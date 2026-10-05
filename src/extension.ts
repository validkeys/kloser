import * as vscode from "vscode";
import { DecorationManager } from "./decorationManager";
import { RequestManager } from "./requestManager";
import { ReviewManager } from "./reviewManager";

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

  function refreshStatus(): void {
    updateStatusItem(statusItem, requests.activeCount + reviews.activeCount);
  }

  const completeSelection = vscode.commands.registerTextEditorCommand(
    "kloser.completeSelection",
    (editor) => promptForInstruction(editor, requests),
  );
  const codeReview = vscode.commands.registerTextEditorCommand("kloser.codeReview", (editor) => {
    void reviews.start(editor, normalizeLineRange(editor));
  });
  const stopAllRequests = vscode.commands.registerCommand("kloser.stopAllRequests", () => {
    requests.stopAll();
    reviews.stopAll();
  });
  const showLogs = vscode.commands.registerCommand("kloser.showLogs", () => {
    log.show();
  });

  context.subscriptions.push(
    completeSelection,
    codeReview,
    stopAllRequests,
    showLogs,
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
