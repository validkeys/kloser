import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TextDocument } from "vscode";
import type { TextDocumentContentChangeEvent } from "vscode";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stripCodeFences(raw: string): string {
  const text = raw.trim();
  const fullFence = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fullFence) {
    return fullFence[1].trimEnd();
  }
  const embeddedFence = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  if (embeddedFence) {
    return embeddedFence[1].trimEnd();
  }
  // accept-mid-stream: a fence may have opened but not yet closed
  return text.replace(/^```[^\n]*\n/, "").trimEnd();
}

export function resolveRunCwd(document: TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    return workspaceFolder.uri.fsPath;
  }
  if (document.uri.scheme === "file") {
    return path.dirname(document.uri.fsPath);
  }
  return os.tmpdir();
}

export function extractContext(
  document: TextDocument,
  range: vscode.Range,
  contextLines: number,
): { afterContext: string; beforeContext: string } {
  const firstLine = Math.max(0, range.start.line - contextLines);
  const lastLine = Math.min(document.lineCount - 1, range.end.line + contextLines);

  const before: string[] = [];
  for (let line = firstLine; line < range.start.line; line += 1) {
    before.push(document.lineAt(line).text);
  }
  const after: string[] = [];
  for (let line = range.end.line + 1; line <= lastLine; line += 1) {
    after.push(document.lineAt(line).text);
  }
  return { afterContext: after.join("\n"), beforeContext: before.join("\n") };
}

function insertedTextEnd(change: TextDocumentContentChangeEvent): vscode.Position {
  const lines = change.text.split("\n");
  const start = change.range.start;
  if (lines.length === 1) {
    return new vscode.Position(start.line, start.character + lines[0].length);
  }
  return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}

function remapPosition(
  position: vscode.Position,
  change: TextDocumentContentChangeEvent,
): vscode.Position {
  const changeRange = change.range;
  if (position.isBeforeOrEqual(changeRange.start)) {
    return position;
  }
  const insertedEnd = insertedTextEnd(change);
  if (position.isAfterOrEqual(changeRange.end)) {
    const lineDelta = insertedEnd.line - changeRange.end.line;
    if (lineDelta === 0 && position.line === changeRange.end.line) {
      return new vscode.Position(
        position.line,
        insertedEnd.character + (position.character - changeRange.end.character),
      );
    }
    return new vscode.Position(position.line + lineDelta, position.character);
  }
  return position.isBefore(insertedEnd) ? position : insertedEnd;
}

export function remapRange(
  range: vscode.Range,
  change: TextDocumentContentChangeEvent,
): vscode.Range {
  const start = remapPosition(range.start, change);
  const end = remapPosition(range.end, change);
  if (end.isBefore(start)) {
    return new vscode.Range(start, start);
  }
  return new vscode.Range(start, end);
}
