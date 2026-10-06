# Kloser — Feature Ideas

Goal: keep the developer in the code, not on the sidelines. The agent proposes;
you decide; nothing lands silently.

Legend: ✅ shipped · 🚧 in progress · 💡 idea

## Watch it write, steer while it writes

- ✅ **Streaming ghost text** — the replacement streams into the actual editor as it
  is generated, line by line, instead of arriving as a black-box result. (v0.4.0)
- ✅ **Interrupt & redirect mid-stream** — press the trigger (`Ctrl+Shift+9`) while a
  stream is active and type a correction ("no — reuse the existing config helper").
  The agent rewrites from the same session; no restart, no lost context. (v0.4.0)
- ✅ **Tab to accept / Esc to reject** — accept whatever has streamed so far, or
  revert the block to its original text. Works while streaming and after the
  stream settles. The whole stream is a single undo step. (v0.4.0)
- 💡 **Finer-grained hunks** — accept/reject per-line or per-hunk as it writes
  (today the unit is the whole block at any point in time).

## The agent asks before it guesses

- 💡 **Clarifying questions** — when the instruction is ambiguous, the agent asks
  ("should this mutate or return new?") instead of guessing and making you undo.
- 💡 **Confidence markers** — flag lines the agent was unsure about so your review
  attention goes exactly where it is needed.
- 💡 **Inline constraints** — cheap guardrails in the prompt box ("don't change
  signatures", "max 15 lines").

## It learns your code, not the other way around

- 💡 **Teach by sketch** — write a rough 3-line version or comment outline; the
  agent completes it in your style using patterns from the surrounding file.
- 💡 **`.kloser/rules.md`** — project rules (naming, error handling, imports) that
  shape every completion, like `.kloser/code-review.md` does for reviews.
- 💡 **Learn from undos** — when you revert an agent edit, capture the preference
  for the project.

## Full transparency of what it knows

- ✅ **Peek at the exact prompt** — Kloser: Show Logs already dumps full
  prompts/responses; promote to a one-keystroke "what did it see?" view. (partial)
- 💡 **Per-request cost/token counts** — status bar indicator so experimentation
  stays deliberate.

## Working across blocks like a conversation

- ✅ **PR guided tour** — plain-English overview, then vertical slices with
  in-code `?` comments, toggleable diffs, and an agent debrief of your
  annotations. (v0.5.0)
- 💡 **GitHub posting** — convert the debrief into a submitted `gh pr review`
  (approve / request changes) with your comments.
- ✅ **Debrief apply** — debrief fix proposals carry a `kloser-apply:` target
  (file + line range) and land via per-block Apply buttons. (v0.5.4)
- ✅ **Multiple pinned blocks** — several completions/reviews can run at once today;
  a queue/triage view would make this first-class. (partial)
- 💡 **Plan-first mode** — agent proposes a numbered plan; you approve steps
  one-by-one before it touches code (the 99 `set_work` idea adapted to blocks).
