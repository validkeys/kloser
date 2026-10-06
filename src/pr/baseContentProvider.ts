import * as vscode from "vscode";
import { showFileAtRef } from "./prData";

export const PR_BASE_SCHEME = "kloser-pr-base";

export class PrBaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly root: string) {}

  public provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
    const raw = uri.path.replace(/^\//, "");
    const slash = raw.indexOf("/");
    if (slash === -1) {
      return Promise.resolve("");
    }
    const sha = raw.slice(0, slash);
    const filePath = raw.slice(slash + 1);
    return showFileAtRef(this.root, sha, filePath).catch(() => "");
  }
}

export function baseUriFor(sha: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({ path: `/${sha}/${filePath}`, scheme: PR_BASE_SCHEME });
}
