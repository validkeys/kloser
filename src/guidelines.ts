import * as fs from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import * as vscode from "vscode";
import type { TextDocument } from "vscode";

export interface ReviewGuidelines {
  combined?: string;
  languageFile?: string;
  repoRoot?: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfPossible(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

export async function findRepoRoot(document: TextDocument): Promise<string | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (document.uri.scheme !== "file") {
    return workspaceFolder?.uri.fsPath;
  }
  let directory = dirname(document.uri.fsPath);
  for (;;) {
    if (await pathExists(join(directory, ".git"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return workspaceFolder?.uri.fsPath;
    }
    directory = parent;
  }
}

export async function loadReviewGuidelines(document: TextDocument): Promise<ReviewGuidelines> {
  const repoRoot = await findRepoRoot(document);
  if (!repoRoot) {
    return {};
  }
  const folder = join(repoRoot, ".kloser");

  const base = await readTextIfPossible(join(folder, "code-review.md"));

  const candidates = [`code-review.${document.languageId}.md`];
  const fileExtension = extname(document.fileName).slice(1).toLowerCase();
  if (fileExtension && fileExtension !== document.languageId) {
    candidates.push(`code-review.${fileExtension}.md`);
  }
  let language: string | undefined;
  let languageFile: string | undefined;
  for (const candidate of candidates) {
    const content = await readTextIfPossible(join(folder, candidate));
    if (content !== undefined) {
      language = content;
      languageFile = candidate;
      break;
    }
  }

  const parts: string[] = [];
  if (base) {
    parts.push(base.trim());
  }
  if (language) {
    parts.push(language.trim());
  }
  return {
    combined: parts.length ? parts.join("\n\n") : undefined,
    languageFile,
    repoRoot,
  };
}
