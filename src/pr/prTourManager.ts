import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runClaude } from "../claudeRunner";
import type { ClaudeRunHandle } from "../claudeRunner";
import { buildChildEnv, getKloserConfig } from "../config";
import { buildPrCommentsPrompt, buildPrTourPrompt } from "../prompt";
import { ReviewPane } from "../reviewWebview";
import type { PrComment } from "../prompt";
import { isRecord, remapRange } from "../util";
import { applyCodeAtTarget, parseApplies } from "./applyTargets";
import type { PendingApply } from "./applyTargets";
import { baseUriFor } from "./baseContentProvider";
import { scanMarkerComments } from "./commentScan";
import { parseUnifiedDiff } from "./diffParser";
import type { FileDiff } from "./diffParser";
import {
  checkoutPullRequest,
  currentBranch,
  fetchPullRequestRefs,
  getPullRequestDiff,
  listPullRequests,
  mergeBase,
  readBaseGuidelines,
  viewPullRequest,
  workspaceRoot,
} from "./prData";
import type { PrInfo, PrListItem } from "./prData";

interface TourTarget {
  file?: string;
  line?: number;
}

interface TourSlice {
  summary: string;
  targets: TourTarget[];
  title: string;
}

interface ActiveTour {
  addedLines: Map<string, vscode.Range[]>;
  baseSha: string;
  files: FileDiff[];
  followupHandle?: ClaudeRunHandle;
  overviewHandle?: ClaudeRunHandle;
  pane: ReviewPane;
  pendingApplies: PendingApply[];
  pr: PrInfo;
  root: string;
  sessionId?: string;
  sliceIndex: number;
  slices: TourSlice[];
}

export interface PrTourManagerDeps {
  log: vscode.OutputChannel;
  onActiveCountChanged: (count: number) => void;
}

export class PrTourManager implements vscode.Disposable {
  private active?: ActiveTour;
  private readonly addedType: vscode.TextEditorDecorationType;
  private readonly docListener: vscode.Disposable;
  private readonly handles = new Map<string, ClaudeRunHandle>();

  constructor(private readonly deps: PrTourManagerDeps) {
    this.addedType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(34, 197, 94, 0.10)",
      isWholeLine: true,
    });
    this.docListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.onDocumentChanged(event),
    );
  }

  public get activeCount(): number {
    return this.handles.size;
  }

  public async start(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("Kloser: PR tours need an open workspace folder.");
      return;
    }
    if (this.active) {
      void vscode.window.showWarningMessage(
        "Kloser: a PR tour is already active — finish it first.",
      );
      return;
    }
    try {
      const pr = await this.pickPullRequest(root);
      if (!pr) {
        return;
      }
      await this.beginTour(root, pr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour failed: ${message}`);
      void vscode.window.showErrorMessage(`Kloser: ${message}`, "Show Logs").then((choice) => {
        if (choice === "Show Logs") {
          this.deps.log.show();
        }
      });
    }
  }

  public nextSlice(): void {
    const tour = this.active;
    if (!tour || !tour.slices.length) {
      return;
    }
    const next = tour.sliceIndex + 1;
    if (next >= tour.slices.length) {
      this.finishTour(tour);
      return;
    }
    this.gotoSlice(tour, next);
  }

  public async toggleDiff(): Promise<void> {
    const tour = this.active;
    const editor = vscode.window.activeTextEditor;
    if (!tour || !editor) {
      return;
    }
    if (editor.document.uri.scheme === "kloser-pr-base") {
      await this.closeDiffTabs();
      return;
    }
    const file = this.relativeToRoot(tour, editor.document.uri);
    if (!file || !tour.files.some((entry) => entry.path === file)) {
      void vscode.window
        .showInformationMessage(
          "Kloser: this file is not part of the toured PR.",
        );
      return;
    }
    const diffTitle = `${file} (PR #${tour.pr.number} diff)`;
    if (await this.closeDiffTabs(diffTitle)) {
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      baseUriFor(tour.baseSha, file),
      vscode.Uri.file(path.join(tour.root, file)),
      diffTitle,
      { preview: true },
    );
  }

  public async reviewComments(): Promise<void> {
    const tour = this.active;
    if (!tour) {
      void vscode.window.showWarningMessage(
        "Kloser: start a PR tour first (Kloser: Review PR), then leave ? comments in the changed files.",
      );
      return;
    }
    if (tour.overviewHandle || tour.followupHandle) {
      tour.pane.note("_The agent is still responding — try again once it finishes._");
      return;
    }
    if (!tour.sessionId) {
      tour.pane.note("_No session available yet — wait for the overview to finish._");
      return;
    }
    const comments = await this.collectMarkerComments(tour);
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] comment scan: ${comments.length} marker comment(s) across ${tour.files.length} changed file(s)`,
    );
    for (const comment of comments) {
      this.deps.log.appendLine(`  ${comment.file}:${comment.line} — ? ${comment.text}`);
    }
    if (!comments.length) {
      tour.pane.note(
        `_No \`?\` comments found in this PR's ${tour.files.length} changed file(s). ` +
          "Leave comments like `// ? why this null check?` in the changed code, then press **Review my ? comments** again._",
      );
      return;
    }
    this.runFollowup(
      tour,
      buildPrCommentsPrompt({ comments, pr: { number: tour.pr.number, title: tour.pr.title } }),
      `Found ${comments.length} ? comment(s):\n\n` +
        comments
          .slice(0, 30)
          .map((comment) => `- \`${comment.file}:${comment.line}\` ? ${comment.text}`)
          .join("\n") +
        (comments.length > 30 ? `\n- …and ${comments.length - 30} more (see Show Logs)` : ""),
    );
  }

  public stopAll(): void {
    for (const handle of this.handles.values()) {
      handle.cancel();
    }
  }

  public dispose(): void {
    this.stopAll();
    this.docListener.dispose();
    this.addedType.dispose();
  }

  private async pickPullRequest(root: string): Promise<PrInfo | undefined> {
    let current: PrInfo | undefined;
    try {
      current = await viewPullRequest(root);
    } catch {
      current = undefined;
    }
    let items: PrListItem[] = [];
    try {
      items = await listPullRequests(root);
    } catch (error) {
      if (!current) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Kloser: ${message}`);
        return undefined;
      }
    }
    const seen = new Set<number>();
    const picks: Array<PrListItem & { isCurrent: boolean }> = [];
    if (current) {
      picks.push({
        author: "",
        headRefName: current.headRefName,
        isCurrent: true,
        number: current.number,
        title: current.title,
      });
      seen.add(current.number);
    }
    for (const item of items) {
      if (!seen.has(item.number)) {
        picks.push({ ...item, isCurrent: false });
        seen.add(item.number);
      }
    }
    if (!picks.length) {
      void vscode.window.showInformationMessage("Kloser: no open pull requests found.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      picks.map((item) => ({
        description: item.isCurrent
          ? `current branch · ${item.headRefName}`
          : `${item.headRefName}${item.author ? ` · ${item.author}` : ""}`,
        label: `#${item.number} ${item.title}`,
        value: item,
      })),
      { placeHolder: "Select a pull request to tour" },
    );
    if (!pick) {
      return undefined;
    }
    return pick.value.isCurrent && current
      ? current
      : viewPullRequest(root, pick.value.number);
  }

  private async beginTour(root: string, pr: PrInfo): Promise<void> {
    this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour: preparing #${pr.number} (${pr.headRefName} -> ${pr.baseRefName})`);
    const branch = await currentBranch(root);
    if (branch !== pr.headRefName) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Checkout PR branch "${pr.headRefName}"`, value: true },
          { label: "Cancel", value: false },
        ],
        { placeHolder: "Kloser needs the PR branch checked out to tour it in the editor." },
      );
      if (!choice || !choice.value) {
        this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour: cancelled at checkout prompt (on "${branch}")`);
        return;
      }
      this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour: checking out #${pr.number}…`);
      await checkoutPullRequest(root, pr.number);
    }
    this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour: fetching diff…`);

    const diff = await getPullRequestDiff(root, pr.number);
    await fetchPullRequestRefs(root, pr.number, pr.baseRefName);
    const baseSha = await mergeBase(root, pr.baseRefName, pr.headOid).catch(() => "");
    const files = parseUnifiedDiff(diff);
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] PR tour: ${files.length} changed files, base ${baseSha || "unknown"}`,
    );
    if (!files.length) {
      void vscode.window.showInformationMessage(`Kloser: PR #${pr.number} has no changes.`);
      return;
    }

    let tour: ActiveTour;
    const pane = new ReviewPane(
      `PR #${pr.number} — ${pr.title}`,
      {
        onAction: (action) => {
          if (!tour) {
            return;
          }
          if (action === "toggleDiff") {
            void this.toggleDiff();
          } else if (action === "nextSlice") {
            this.nextSlice();
          } else if (action === "reviewComments") {
            void this.reviewComments();
          }
        },
        onApply: (code) => {
          if (tour) {
            void this.applyProposedFix(tour, code);
          }
        },
        onDisposed: () => {
          if (tour) {
            this.endTour(tour);
          }
        },
        onFollowup: (text) => {
          if (tour) {
            this.runFollowup(tour, text, undefined);
          }
        },
      },
      {
        actions: [
          { id: "toggleDiff", label: "Toggle diff" },
          { id: "nextSlice", label: "Next slice ▸" },
          { id: "reviewComments", label: "Review my ? comments" },
        ],
        enableApply: true,
      },
    );
    const addedLines = new Map<string, vscode.Range[]>();
    for (const file of files) {
      addedLines.set(
        file.path,
        file.addedLines.map((line) => new vscode.Range(line - 1, 0, line - 1, 0)),
      );
    }
    tour = {
      addedLines,
      baseSha,
      files,
      pane,
      pendingApplies: [],
      pr,
      root,
      sliceIndex: -1,
      slices: [],
    };
    this.active = tour;
    void vscode.commands.executeCommand("setContext", "kloser.prTourActive", true);
    pane.setBanner(`Loading PR #${pr.number} — building the tour…`);

    const guidelines = await readBaseGuidelines(root);
    const prompt = buildPrTourPrompt({ diff, guidelines, pr });
    this.deps.log.appendLine(
      `[${new Date().toISOString()}] PR tour started: #${pr.number} (${files.length} files)`,
    );

    const config = getKloserConfig();
    const id = randomUUID();
    pane.beginAssistantTurn();
    const handle = runClaude({
      cwd: root,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (text) => {
        pane.appendAssistantDelta(text);
      },
      prompt,
    });
    tour.overviewHandle = handle;
    this.handles.set(id, handle);
    this.notify();

    void handle.sessionId.then((sessionId) => {
      if (this.active === tour && sessionId) {
        tour.sessionId = sessionId;
      }
    });

    handle.result
      .then((final) => {
        if (this.active !== tour) {
          return;
        }
        tour.overviewHandle = undefined;
        this.handles.delete(id);
        this.notify();
        const { overview, slices } = splitTourResponse(final);
        tour.slices = slices;
        if (slices.length) {
          pane.finishAssistantTurn(overview || undefined);
          this.gotoSlice(tour, 0);
        } else {
          pane.setBanner(`PR #${tour.pr.number} — ask questions below`);
          pane.finishAssistantTurn(final.trim() || undefined);
        }
      })
      .catch((error: unknown) => {
        if (this.active !== tour) {
          return;
        }
        tour.overviewHandle = undefined;
        this.handles.delete(id);
        this.notify();
        const message = error instanceof Error ? error.message : String(error);
        pane.failTurn(`**PR tour failed.** ${message}`);
        this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour failed: ${message}`);
      });
  }

  private gotoSlice(tour: ActiveTour, index: number): void {
    const slice = tour.slices[index];
    if (!slice) {
      return;
    }
    tour.sliceIndex = index;
    tour.pane.setBanner(`Slice ${index + 1}/${tour.slices.length} — ${slice.title}`);
    tour.pane.note(
      `${slice.summary}\n\n_Leave \`?\` comments in the code, ask below, or hit **Next slice ▸**._`,
    );
    for (const target of slice.targets) {
      void this.revealTarget(tour, target);
    }
  }

  private finishTour(tour: ActiveTour): void {
    tour.pane.setBanner(`PR #${tour.pr.number} — tour complete`);
    tour.pane.note(
      "_Tour complete. Leave `?` comments anywhere in the changed code as you look around, then press **Review my ? comments**._",
    );
  }

  private async revealTarget(tour: ActiveTour, target: TourTarget): Promise<void> {
    if (!target.file || !tour.addedLines.has(target.file)) {
      return;
    }
    const uri = vscode.Uri.file(path.join(tour.root, target.file));
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      });
      const line = target.line && target.line > 0 ? target.line : this.firstChangedLine(tour, target.file);
      if (line) {
        editor.revealRange(
          new vscode.Range(line - 1, 0, line - 1, 0),
          vscode.TextEditorRevealType.InCenter,
        );
      }
      this.applyHighlights(tour, editor);
    } catch {
      // target file may no longer exist; skip silently
    }
  }

  private firstChangedLine(tour: ActiveTour, file: string): number | undefined {
    const fileDiff = tour.files.find((entry) => entry.path === file);
    return fileDiff?.addedLines[0];
  }

  private applyHighlights(tour: ActiveTour, editor: vscode.TextEditor): void {
    const file = this.relativeToRoot(tour, editor.document.uri);
    if (!file) {
      return;
    }
    const ranges = tour.addedLines.get(file);
    editor.setDecorations(this.addedType, ranges ?? []);
  }

  private relativeToRoot(tour: ActiveTour, uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const relative = path.relative(tour.root, uri.fsPath);
    if (relative.startsWith("..")) {
      return undefined;
    }
    return relative.split(path.sep).join("/");
  }

  private async closeDiffTabs(titleMatch?: string): Promise<boolean> {
    let closed = false;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) {
          continue;
        }
        if (tab.input.original.scheme !== "kloser-pr-base") {
          continue;
        }
        if (titleMatch && !tab.label.includes(titleMatch)) {
          continue;
        }
        await vscode.window.tabGroups.close(tab);
        closed = true;
      }
    }
    return closed;
  }

  private async collectMarkerComments(tour: ActiveTour): Promise<PrComment[]> {
    const files = tour.files.filter((file) => !file.isDeleted).map((file) => file.path);
    return scanMarkerComments(tour.root, files);
  }

  private runFollowup(tour: ActiveTour, prompt: string, note?: string): void {
    if (tour.overviewHandle || tour.followupHandle) {
      tour.pane.note("_The agent is still responding — try again once it finishes._");
      return;
    }
    if (!tour.sessionId) {
      tour.pane.note("_No session yet — wait for the tour to finish loading._");
      return;
    }
    const isDebrief = note !== undefined;
    if (!isDebrief) {
      tour.pane.appendUserTurn(prompt);
    } else if (note) {
      tour.pane.note(`_${note}_`);
    }
    const config = getKloserConfig();
    tour.pane.beginAssistantTurn();
    const id = randomUUID();
    const handle = runClaude({
      cwd: tour.root,
      env: buildChildEnv(config),
      executable: config.claudeExecutable,
      extraArgs: config.extraArgs,
      model: config.model,
      onDelta: (text) => {
        tour.pane.appendAssistantDelta(text);
      },
      prompt,
      resumeSessionId: tour.sessionId,
    });
    tour.followupHandle = handle;
    this.handles.set(id, handle);
    this.notify();
    handle.result
      .then((final) => {
        tour.pendingApplies.push(...parseApplies(final));
        tour.pane.finishAssistantTurn(final.trim() || undefined);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        tour.pane.failTurn(`**Follow-up failed.** ${message}`);
      })
      .finally(() => {
        tour.followupHandle = undefined;
        this.handles.delete(id);
        this.notify();
      });
  }

  private async applyProposedFix(tour: ActiveTour, code: string): Promise<void> {
    const match = tour.pendingApplies.find(
      (pending) => pending.code.trim() === code.trim(),
    );
    if (!match) {
      void vscode.window.showWarningMessage(
        "Kloser: this code block has no apply target — ask the agent to include a kloser-apply line.",
      );
      return;
    }
    const result = await applyCodeAtTarget(tour.root, match, code);
    if (result.ok) {
      tour.pendingApplies = tour.pendingApplies.filter((pending) => pending !== match);
      this.deps.log.appendLine(`[${new Date().toISOString()}] ${result.detail}`);
      return;
    }
    void vscode.window.showWarningMessage(`Kloser: ${result.detail}`);
  }

  private endTour(tour: ActiveTour): void {
    if (this.active !== tour) {
      return;
    }
    this.active = undefined;
    if (tour.overviewHandle) {
      tour.overviewHandle.cancel();
    }
    if (tour.followupHandle) {
      tour.followupHandle.cancel();
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.addedType, []);
    }
    void vscode.commands.executeCommand("setContext", "kloser.prTourActive", false);
    this.notify();
    this.deps.log.appendLine(`[${new Date().toISOString()}] PR tour #${tour.pr.number} ended`);
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const tour = this.active;
    if (!tour || event.document.uri.scheme !== "file") {
      return;
    }
    const file = this.relativeToRoot(tour, event.document.uri);
    if (!file) {
      return;
    }
    const ranges = tour.addedLines.get(file);
    if (!ranges) {
      return;
    }
    for (const change of event.contentChanges) {
      for (let index = 0; index < ranges.length; index += 1) {
        ranges[index] = remapRange(ranges[index], change);
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.relativeToRoot(tour, editor.document.uri) === file) {
        editor.setDecorations(this.addedType, ranges);
      }
    }
  }

  private notify(): void {
    this.deps.onActiveCountChanged(this.handles.size);
  }
}

function splitTourResponse(response: string): { overview: string; slices: TourSlice[] } {
  const marker = response.indexOf("---SLICES---");
  const overview = marker === -1 ? response : response.slice(0, marker);
  return { overview: overview.trim(), slices: parseSlices(response) };
}

function parseSlices(response: string): TourSlice[] {
  const marker = response.indexOf("---SLICES---");
  if (marker === -1) {
    return [];
  }  let raw = response.slice(marker + "---SLICES---".length).trim();
  raw = raw.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
  const end = raw.lastIndexOf("]");
  if (end > 0) {
    raw = raw.slice(0, end + 1);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const slices: TourSlice[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        continue;
      }
      const targets: TourTarget[] = [];
      if (Array.isArray(entry.targets)) {
        for (const target of entry.targets) {
          if (isRecord(target) && typeof target.file === "string") {
            targets.push({
              file: target.file,
              line: typeof target.line === "number" ? target.line : undefined,
            });
          }
        }
      }
      if (typeof entry.title === "string" && targets.length) {
        slices.push({
          summary: typeof entry.summary === "string" ? entry.summary : "",
          targets,
          title: entry.title,
        });
      }
    }
    return slices;
  } catch {
    return [];
  }
}
