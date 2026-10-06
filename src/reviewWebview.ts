import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { marked } from "marked";
import { isRecord } from "./util";

export interface ReviewPaneCallbacks {
  onApply?: (code: string) => void;
  onAction?: (action: string) => void;
  onDisposed: () => void;
  onFollowup: (text: string) => void;
}

export interface ReviewPaneOptions {
  actions?: Array<{ id: string; label: string }>;
  enableApply?: boolean;
}

const RENDER_THROTTLE_MS = 100;

export class ReviewPane implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly callbacks: ReviewPaneCallbacks;
  private banner = "";
  private committed = "";
  private currentAssistant = "";
  private disposed = false;
  private readonly enableApply: boolean;
  private renderTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(title: string, callbacks: ReviewPaneCallbacks, options?: ReviewPaneOptions) {
    this.callbacks = callbacks;
    this.enableApply = options?.enableApply !== false;
    this.panel = vscode.window.createWebviewPanel(
      "kloser.codeReview",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const nonce = randomBytes(16).toString("hex");
    this.panel.webview.html = buildShellHtml(nonce, options?.actions ?? []);
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.callbacks.onDisposed();
    });
  }

  public setBanner(banner: string): void {
    this.banner = banner;
    this.render();
  }

  public note(text: string): void {
    this.commitAssistantTurn();
    this.currentAssistant = text;
    this.commitAssistantTurn();
    this.render();
  }

  public beginAssistantTurn(): void {
    this.currentAssistant = "";
    this.setRunning(true);
    this.render();
  }

  public appendAssistantDelta(text: string): void {
    this.currentAssistant += text;
    this.scheduleRender();
  }

  public finishAssistantTurn(finalText?: string): void {
    if (finalText) {
      this.currentAssistant = finalText;
    }
    this.commitAssistantTurn();
    this.setRunning(false);
    this.render();
  }

  public appendUserTurn(text: string): void {
    this.commitAssistantTurn();
    this.committed += `${this.committed ? "\n\n---\n\n" : ""}**You:** ${text}`;
    this.render();
  }

  public failTurn(note: string): void {
    if (this.currentAssistant) {
      this.currentAssistant += `\n\n${note}`;
    } else {
      this.currentAssistant = note;
    }
    this.commitAssistantTurn();
    this.setRunning(false);
    this.render();
  }

  public dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (!this.disposed) {
      this.disposed = true;
      this.panel.dispose();
    }
  }

  private commitAssistantTurn(): void {
    if (!this.currentAssistant) {
      return;
    }
    this.committed += `${this.committed ? "\n\n---\n\n" : ""}**Kloser:**\n\n${this.currentAssistant}`;
    this.currentAssistant = "";
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    if (message.type === "followup" && typeof message.text === "string") {
      this.callbacks.onFollowup(message.text);
      return;
    }
    if (message.type === "apply" && typeof message.code === "string") {
      this.callbacks.onApply?.(message.code);
      return;
    }
    if (message.type === "action" && typeof message.action === "string") {
      this.callbacks.onAction?.(message.action);
    }
  }

  private buildMarkdown(): string {
    let body = this.committed;
    if (this.running || this.currentAssistant) {
      const turn = `**Kloser:**\n\n${this.currentAssistant || "_…_"}`;
      body = body ? `${body}\n\n---\n\n${turn}` : turn;
    }
    return body;
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.disposed) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RENDER_THROTTLE_MS);
  }

  private render(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.disposed) {
      return;
    }
    const body = renderMarkdown(this.buildMarkdown());
    const html = this.enableApply ? injectApplyButtons(body) : body;
    void this.panel.webview.postMessage({
      banner: this.banner,
      html,
      running: this.running,
      type: "render",
    });
  }

  private setRunning(running: boolean): void {
    this.running = running;
  }
}

function renderMarkdown(markdown: string): string {
  try {
    const parsed = marked.parse(markdown, { async: false, gfm: true });
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // fall through to the escaped fallback below
  }
  return `<pre>${escapeHtml(markdown)}</pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function injectApplyButtons(html: string): string {
  const withButtons = html.replace(
    /<pre>/g,
    '<div class="kloser-block"><div class="kloser-actions"><button class="kloser-apply" type="button">Apply to block</button></div><pre>',
  );
  if (withButtons === html) {
    return html;
  }
  return withButtons.replace(/<\/pre>/g, "</pre></div>");
}

function buildShellHtml(nonce: string, actions: Array<{ id: string; label: string }>): string {
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src https: data:",
  ].join("; ");
  const actionButtons = actions
    .map(
      (action) =>
        `<button class="kloser-action" type="button" data-action="${action.id}">${action.label}</button>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.55; }
  #content { flex: 1; overflow-y: auto; padding: 12px 16px; }
  h1, h2, h3 { font-weight: 600; margin: 1.1em 0 0.45em; }
  h1 { font-size: 1.3em; }
  h2 { font-size: 1.15em; }
  h3 { font-size: 1em; }
  p { margin: 0.5em 0; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.95em; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 0.2em 0 0.8em; }
  pre code { background: none; padding: 0; }
  ul, ol { padding-left: 1.5em; }
  blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 0.5em 0; padding: 0.1em 12px; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; margin: 0.6em 0; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  a { color: var(--vscode-textLink-foreground); }
  hr { border: 0; border-top: 1px solid var(--vscode-panel-border); }
  .kloser-block { margin: 0.6em 0; }
  .kloser-actions { margin-bottom: 2px; text-align: right; }
  .kloser-apply { background: var(--vscode-button-secondary-background); color: var(--vscode-button-secondary-foreground); border: none; border-radius: 3px; padding: 2px 10px; font-size: 0.85em; font-family: inherit; cursor: pointer; }
  .kloser-apply:hover { background: var(--vscode-button-secondary-hoverBackground, var(--vscode-button-secondary-background)); }
  #kloser-typing { display: none; padding: 2px 16px 6px; color: var(--vscode-descriptionForeground); font-style: italic; }
  #kloser-banner { display: none; padding: 6px 16px; background: var(--vscode-editorInlayHint-background, rgba(128,128,128,0.1)); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
  #kloser-actions { display: flex; gap: 8px; padding: 6px 16px; border-top: 1px solid var(--vscode-panel-border); }
  .kloser-action { background: var(--vscode-button-secondary-background); color: var(--vscode-button-secondary-foreground); border: none; border-radius: 3px; padding: 4px 12px; font-family: inherit; font-size: 0.9em; cursor: pointer; }
  .kloser-action:hover { filter: brightness(1.1); }
  #kloser-footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 12px; display: flex; gap: 8px; align-items: flex-start; background: var(--vscode-editor-background); }
  #kloser-input { flex: 1; resize: vertical; min-height: 2.2em; max-height: 10em; font-family: inherit; font-size: 1em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 4px 6px; }
  #kloser-send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 6px 14px; font-family: inherit; font-size: 1em; cursor: pointer; }
  #kloser-send:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  #kloser-input:disabled, #kloser-send:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="kloser-banner"></div>
<div id="content"><p><em>Starting review…</em></p></div>
<div id="kloser-typing">Kloser is responding…</div>
${actionButtons ? `<div id="kloser-actions">${actionButtons}</div>` : ""}
<div id="kloser-footer">
  <textarea id="kloser-input" placeholder="Ask a question about this review…" rows="1"></textarea>
  <button id="kloser-send" type="button">Send</button>
</div>
<script nonce="${nonce}">
  (function () {
    var api = acquireVsCodeApi();
    var content = document.getElementById("content");
    var input = document.getElementById("kloser-input");
    var send = document.getElementById("kloser-send");
    var typing = document.getElementById("kloser-typing");
    function submit() {
      var text = input.value.trim();
      if (!text) { return; }
      api.postMessage({ type: "followup", text: text });
      input.value = "";
    }
    send.addEventListener("click", submit);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) { return; }
      var actionButton = target.closest(".kloser-action");
      if (actionButton) {
        api.postMessage({ type: "action", action: actionButton.getAttribute("data-action") });
        return;
      }
      var applyButton = target.closest(".kloser-apply");
      if (!applyButton) { return; }
      var holder = applyButton.closest(".kloser-block");
      var code = holder ? holder.querySelector("pre code") : null;
      if (code) { api.postMessage({ type: "apply", code: code.innerText }); }
    });
    window.addEventListener("message", function (event) {
      var message = event.data;
      if (!message || message.type !== "render") { return; }
      var doc = document.documentElement;
      var nearBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 48;
      var banner = document.getElementById("kloser-banner");
      if (typeof message.banner === "string" && message.banner) {
        banner.textContent = message.banner;
        banner.style.display = "block";
      } else {
        banner.style.display = "none";
      }
      content.innerHTML = message.html;
      var busy = !!message.running;
      input.disabled = busy;
      send.disabled = busy;
      typing.style.display = busy ? "block" : "none";
      if (nearBottom) { window.scrollTo(0, doc.scrollHeight); }
    });
  })();
</script>
</body>
</html>`;
}
