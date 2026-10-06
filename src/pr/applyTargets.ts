import * as path from "node:path";
import * as vscode from "vscode";

export interface PendingApply {
  code: string;
  endLine: number;
  file: string;
  startLine: number;
}

export function parseApplies(response: string): PendingApply[] {
  const applies: PendingApply[] = [];
  const pattern = /kloser-apply:\s*(.+?):(\d+)-(\d+)\s*\n```[^\n]*\n([\s\S]*?)\n?```/g;
  for (const match of response.matchAll(pattern)) {
    applies.push({
      code: match[4] ?? "",
      endLine: Number(match[3]),
      file: (match[1] ?? "").trim(),
      startLine: Number(match[2]),
    });
  }
  return applies;
}

export async function applyCodeAtTarget(
  root: string,
  target: PendingApply,
  code: string,
): Promise<{ detail: string; ok: boolean }> {
  const uri = vscode.Uri.file(path.join(root, target.file));
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const startLine = Math.max(1, target.startLine);
    const endLine = Math.min(document.lineCount, Math.max(startLine, target.endLine));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        startLine - 1,
        0,
        endLine - 1,
        document.lineAt(endLine - 1).text.length,
      ),
      code.trimEnd(),
    );
    const applied = await vscode.workspace.applyEdit(edit);
    return applied
      ? { detail: `applied fix to ${target.file}:${startLine}-${endLine}`, ok: true }
      : { detail: `could not apply the fix to ${target.file}`, ok: false };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), ok: false };
  }
}
