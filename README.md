# Kloser

Give a Claude Code agent control of a selected block of code. The agent runs in the
background — you can click away, keep editing, and watch a live spinner in the gutter
next to the block it is working on. When it finishes, the block is replaced in place.

Inspired by the `visual()` workflow of [ThePrimeagen/99](https://github.com/ThePrimeagen/99).

## How it works

1. Select one or more lines (an empty selection uses the current line).
2. Run **Kloser: Complete Selection with Agent** (`Ctrl+Shift+9`, or the editor
   context menu).
3. Type an instruction and press `Enter`. The replacement **streams directly
   into the editor** as the agent writes it — watch it materialize line by line
   (indigo tint + gutter spinner mark the live block).
4. Steer it, keyboard-first:
   - **Tab** — accept what has streamed so far (kills generation, keeps the text)
   - **Esc** — reject: revert the block to its original text
   - **Ctrl+Shift+9** — redirect mid-stream: type a correction ("no — reuse the
     existing config helper") and the agent rewrites from the same session
5. After the stream finishes the block stays in a *pending* state (yellow
   marker) until you **Tab** to accept or **Esc** to reject.
6. The whole stream is a single undo step (`Cmd+Z` after accepting reverts the
   agent's entire edit).

Only one completion stream is active at a time; multiple code reviews can
still run in parallel.

## Requirements

- [Claude Code](https://claude.com/product/claude-code) CLI (`claude`) installed and authenticated.
- Kloser talks to `claude -p` (non-interactive print mode), so anything your Claude
  Code setup supports works here — including **AWS Bedrock**.

## AWS Bedrock

Kloser inherits the environment of the VS Code process. If you launch `code` from a
terminal where Claude Code already works with Bedrock, no configuration is needed.
Your shell vars (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_MODEL`, `AWS_PROFILE`,
`AWS_REGION`, …) are passed straight through to the agent.

If you launch VS Code from the Dock (no shell env), configure Bedrock explicitly:

```jsonc
// settings.json
{
  "kloser.claudeExecutable": "/absolute/path/to/claude", // e.g. ~/.nvm/versions/node/v23.9.0/bin/claude
  "kloser.bedrock.useBedrock": true,
  "kloser.bedrock.model": "us.anthropic.claude-sonnet-4-6",
  "kloser.bedrock.smallFastModel": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "kloser.env": {
    "AWS_PROFILE": "AWS-CWP-Developers-Dev-442294689084",
    "AWS_REGION": "ca-central-1"
  }
}
```

## Code review (streaming, interactive)

Select a block and run **Kloser: Code Review Selection** (`Ctrl+Shift+8`). The
review streams live into a side pane as the agent writes it, with severity
groupings (Critical / Warning / Suggestion) and a final verdict. The selected
block shows the same gutter spinner while the review runs.

### Acting on a review

- **Follow-up chat:** type in the box at the bottom of the pane (Enter to send,
  Shift+Enter for a newline). Follow-ups resume the same Claude Code session
  (`claude --resume`), so the model remembers the review — e.g.
  *"propose solutions for finding 2"* or *"rewrite the block fixing all critical issues"*.
- **Apply to block:** every fenced code block in the conversation gets an
  *Apply to block* button. Clicking replaces the reviewed block (live-tracked,
  even if you've edited the file since) with the proposed code — a normal
  undoable edit.

### Project review guidelines (`.kloser/`)

Kloser walks up from the file to the nearest `.git` root (falling back to the
workspace root) and loads guidelines from a `.kloser/` folder there:

| File | Purpose |
| --- | --- |
| `.kloser/code-review.md` | Base guidelines, always included (any language). |
| `.kloser/code-review.<languageId>.md` | Language-specific guidelines, e.g. `code-review.typescript.md` for TS files. |
| `.kloser/code-review.<ext>.md` | Fallback by file extension, e.g. `code-review.py.md`. |

The base document is **prefixed** to the language-specific document (base
first, then language rules), and both are injected into the review prompt with
priority over the built-in defaults. If no guidelines exist, Kloser says so and
uses its built-in review prompt.

## PR guided tour

Review an agent's PR the way you'd actually read it: whole solution first, then
vertical slices, with your questions left as comments **in the code**.

Run **Kloser: Review PR (Guided Tour)** (command palette). The flow:

1. **Pick a PR** (current branch's PR is offered first). If you're not on the PR
   branch, Kloser offers to check it out — the tour edits and annotates real files.
2. **Plain-English overview** streams into the pane: what was done, why, the
   approach, and the riskiest changes. The agent also proposes **3–7 vertical
   slices** of the change (by concern, not by file).
3. **Tour the slices**: each slice opens its key files in the editor with the
   PR's added lines highlighted green; the pane explains what changed and what
   to watch for. `Ctrl+Shift+7` or **Next slice ▸** advances.
4. **View code your way**: files open as the current (head) state — press
   `Ctrl+Shift+6` or **Toggle diff** to flip any file into a base-vs-head diff.
5. **Annotate as you go**: leave `?` comments directly in the code
   (`// ? why this null check?`, `# ? duplicated elsewhere?`).
6. **Debrief**: hit **Review my ? comments** — Kloser sweeps every `?` comment
   in the changed files and the agent answers each (grouped by file, in code
   order), proposing concrete fixes where warranted.

Mid-tour chat works too — questions resume the same Claude session that read
the whole diff. `.kloser/code-review.md` guidelines shape the tour.

## Commands

| Command | Title |
| --- | --- |
| `kloser.completeSelection` | Kloser: Complete Selection with Agent |
| `kloser.codeReview` | Kloser: Code Review Selection |
| `kloser.stopAllRequests` | Kloser: Stop All Requests (cancels completions and reviews) |
| `kloser.showLogs` | Kloser: Show Logs (full prompts/responses for the last runs) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kloser.claudeExecutable` | `claude` | CLI executable (name on PATH or absolute path). |
| `kloser.model` | `""` | Model override passed via `--model`. Empty = Claude Code default. |
| `kloser.contextLines` | `60` | Lines of context above/below the selection included in the prompt. |
| `kloser.extraArgs` | `[]` | Extra CLI args appended to every `claude` invocation. |
| `kloser.env` | `{}` | Env vars merged into the claude child process. |
| `kloser.bedrock.useBedrock` | `false` | Sets `CLAUDE_CODE_USE_BEDROCK=1`. |
| `kloser.bedrock.model` | `""` | Sets `ANTHROPIC_MODEL`. |
| `kloser.bedrock.smallFastModel` | `""` | Sets `ANTHROPIC_SMALL_FAST_MODEL`. |
| `kloser.bedrock.baseUrl` | `""` | Sets `ANTHROPIC_BEDROCK_BASE_URL`. |

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Open the folder in VS Code and press `F5` (*Run Extension*) to launch the
Extension Development Host.

## Notes / roadmap

- v1 replaces the selected block in one shot via `claude -p`. Streaming the
  replacement into the editor and tool-using agents (scoped edits) are future work.
- The prompt asks the model to return raw code only; markdown fences are stripped
  defensively.
