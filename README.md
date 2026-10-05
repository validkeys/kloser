# Kloser

Give a Claude Code agent control of a selected block of code. The agent runs in the
background — you can click away, keep editing, and watch a live spinner in the gutter
next to the block it is working on. When it finishes, the block is replaced in place.

Inspired by the `visual()` workflow of [ThePrimeagen/99](https://github.com/ThePrimeagen/99).

## How it works

1. Select one or more lines (an empty selection uses the current line).
2. Run **Kloser: Complete Selection with Agent** (`Ctrl+Shift+9`, or the editor
   context menu).
3. Type an instruction and press `Enter`. The prompt box disappears and the request
   runs in the background — you are free to click away and keep coding.
4. An animated gutter spinner + subtle highlight mark the active block. Multiple
   blocks can be in flight at the same time.
5. On completion the block is replaced with the agent's code (a normal edit —
   `Cmd+Z` / `Ctrl+Z` undoes it). A green gutter marker lingers briefly.
   On failure a red marker appears and an error message is shown.
6. The status bar shows the number of active requests; click it to stop them all.

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
