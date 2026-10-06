import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { isRecord } from "../util";
import { validatePRNumber, validateFilePath, sanitizeGitReference, PRValidationError } from "./validation";

export interface PrListItem {
  author: string;
  headRefName: string;
  number: number;
  title: string;
}

export interface PrInfo {
  baseRefName: string;
  body: string;
  headOid: string;
  headRefName: string;
  number: number;
  title: string;
  url: string;
}

const COMMAND_TIMEOUT_MS = 60_000;

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    let stderrHandler: ((chunk: Buffer) => void) | undefined;
    let errorHandler: ((error: Error) => void) | undefined;
    let closeHandler: ((code: number | null) => void) | undefined;

    const cleanup = () => {
      if (stdoutHandler) {
        child.stdout?.removeListener("data", stdoutHandler);
        stdoutHandler = undefined;
      }
      if (stderrHandler) {
        child.stderr?.removeListener("data", stderrHandler);
        stderrHandler = undefined;
      }
      if (errorHandler) {
        child.removeListener("error", errorHandler);
        errorHandler = undefined;
      }
      if (closeHandler) {
        child.removeListener("close", closeHandler);
        closeHandler = undefined;
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        child.kill("SIGKILL");
        reject(
          new Error(
            `"${command} ${args.join(" ")}" timed out after ${COMMAND_TIMEOUT_MS / 1000}s — ` +
              "it may be waiting for credentials. Try running it manually in a terminal.",
          ),
        );
      }
    }, COMMAND_TIMEOUT_MS);

    stdoutHandler = (chunk: Buffer) => {
      stdout += chunk.toString();
    };
    stderrHandler = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    errorHandler = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`"${command}" failed to start: ${error.message}`));
      }
    };
    closeHandler = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = (stderr || stdout).trim().slice(0, 500);
      reject(new Error(`"${command} ${args.join(" ")}" failed (exit ${code ?? "?"}): ${detail}`));
    };

    child.stdout?.on("data", stdoutHandler);
    child.stderr?.on("data", stderrHandler);
    child.on("error", errorHandler);
    child.on("close", closeHandler);
  });
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return [];
  }
  return [];
}

export async function listPullRequests(root: string): Promise<PrListItem[]> {
  const raw = await runCommand("gh", [
    "pr",
    "list",
    "--json",
    "number,title,author,headRefName",
    "--limit",
    "30",
  ], root);
  const items: PrListItem[] = [];
  for (const entry of parseJsonArray(raw)) {
    if (!isRecord(entry)) {
      continue;
    }
    const author = isRecord(entry.author) && typeof entry.author.login === "string"
      ? entry.author.login
      : "";
    if (
      typeof entry.number === "number" &&
      typeof entry.title === "string" &&
      typeof entry.headRefName === "string"
    ) {
      items.push({ author, headRefName: entry.headRefName, number: entry.number, title: entry.title });
    }
  }
  return items;
}

export async function viewPullRequest(root: string, number?: number): Promise<PrInfo> {
  const args = ["pr", "view"];
  if (number !== undefined) {
    const validNumber = validatePRNumber(number);
    args.push(String(validNumber));
  }
  args.push("--json", "number,title,body,baseRefName,headRefName,headRefOid,url");
  const raw = await runCommand("gh", args, root);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.number === "number" &&
      typeof parsed.title === "string" &&
      typeof parsed.baseRefName === "string" &&
      typeof parsed.headRefName === "string" &&
      typeof parsed.headRefOid === "string"
    ) {
      return {
        baseRefName: parsed.baseRefName,
        body: typeof parsed.body === "string" ? parsed.body : "",
        headOid: parsed.headRefOid,
        headRefName: parsed.headRefName,
        number: parsed.number,
        title: parsed.title,
        url: typeof parsed.url === "string" ? parsed.url : "",
      };
    }
  } catch {
    // fall through to the error below
  }
  throw new Error("Could not read pull request metadata from gh.");
}

export function getPullRequestDiff(root: string, number: number): Promise<string> {
  const validNumber = validatePRNumber(number);
  return runCommand("gh", ["pr", "diff", String(validNumber)], root);
}

export function currentBranch(root: string): Promise<string> {
  return runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).then((out) =>
    out.trim(),
  );
}

export function checkoutPullRequest(root: string, number: number): Promise<void> {
  const validNumber = validatePRNumber(number);
  return runCommand("gh", ["pr", "checkout", String(validNumber)], root).then(() => undefined);
}

export function fetchPullRequestRefs(root: string, number: number, baseRefName: string): Promise<void> {
  const validNumber = validatePRNumber(number);
  const sanitizedBase = sanitizeGitReference(baseRefName);
  return runCommand(
    "git",
    ["fetch", "--quiet", "origin", sanitizedBase, `pull/${validNumber}/head`],
    root,
  ).then(() => undefined);
}

export function mergeBase(root: string, baseRefName: string, headOid: string): Promise<string> {
  const sanitizedBase = sanitizeGitReference(baseRefName);
  const sanitizedHead = sanitizeGitReference(headOid);
  return runCommand("git", ["merge-base", `origin/${sanitizedBase}`, sanitizedHead], root).then((out) =>
    out.trim(),
  );
}

export function showFileAtRef(root: string, sha: string, filePath: string): Promise<string> {
  const sanitizedSha = sanitizeGitReference(sha);
  validateFilePath(filePath);
  const sanitizedPath = sanitizeGitReference(filePath);
  return runCommand("git", ["show", `${sanitizedSha}:${sanitizedPath}`], root);
}

export async function listTrackedFiles(root: string): Promise<string[]> {
  const raw = await runCommand("git", ["ls-files"], root);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function readBaseGuidelines(root: string): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(`${root}/.kloser/code-review.md`);
    const document = await vscode.workspace.openTextDocument(uri);
    return document.getText().trim();
  } catch {
    return undefined;
  }
}
