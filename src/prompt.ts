export interface PromptArgs {
  afterContext: string;
  beforeContext: string;
  instruction: string;
  languageId: string;
  relativePath: string;
  selectedCode: string;
}

export interface ReviewPromptArgs {
  afterContext: string;
  beforeContext: string;
  guidelines?: string;
  languageId: string;
  relativePath: string;
  selectedCode: string;
  startLine: number;
}

export function buildReviewPrompt(args: ReviewPromptArgs): string {
  const lines = [
    "You are Kloser's code reviewer, embedded in the user's editor.",
    "Perform a thorough code review of the SELECTED BLOCK and respond with a markdown review report.",
    "",
    "Report format:",
    "- Start with a one-line summary of the block.",
    "- Group findings under severity headings: `## Critical`, `## Warning`, `## Suggestion`. Omit empty groups.",
    "- For each finding: explain what and why, reference absolute file line numbers, and give a concrete fix (show corrected code where useful).",
    `- The selected block starts at file line ${args.startLine + 1}.`,
    "- End with a `## Verdict` section: approve, approve with changes, or request changes, with one sentence of justification.",
    "- If the block has no issues, say so plainly.",
    "- If the user later asks you to propose or implement fixes, return the COMPLETE replacement code for the entire block in a single fenced code block.",
    "",
    `File: ${args.relativePath} (language: ${args.languageId})`,
  ];
  if (args.guidelines) {
    lines.push(
      "",
      "## Project review guidelines (these take priority over the defaults above)",
      args.guidelines,
    );
  }
  lines.push(
    "",
    "--- CODE CONTEXT ---",
    args.beforeContext,
    "<<<KLOSER-SELECTED-BLOCK-START>>>",
    args.selectedCode,
    "<<<KLOSER-SELECTED-BLOCK-END>>>",
    args.afterContext,
    "--- END CODE CONTEXT ---",
  );
  return lines.join("\n");
}

export interface PrComment {
  file: string;
  line: number;
  text: string;
  context: string;
}

const MAX_DIFF_CHARS = 120_000;

function clampDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  const half = MAX_DIFF_CHARS / 2;
  return `${diff.slice(0, half)}\n\n… [diff truncated: ${diff.length - MAX_DIFF_CHARS} characters omitted] …\n\n${diff.slice(diff.length - half)}`;
}

export function buildPrTourPrompt(args: {
  diff: string;
  guidelines?: string;
  pr: { baseRefName: string; body: string; headRefName: string; number: number; title: string };
}): string {
  const lines = [
    `You are guiding a senior engineer through reviewing pull request #${args.pr.number}: ${args.pr.title}.`,
    `Branch: ${args.pr.headRefName} → ${args.pr.baseRefName}.`,
    args.pr.body ? `PR description:\n${args.pr.body.slice(0, 2000)}` : "",
    "",
    "Write an EXTREMELY concise briefing. Hard rules:",
    "- Maximum 100 words total.",
    "- Plain English. No headers, no bold labels except where shown, no preamble, no summary outro.",
    "- Do NOT restate the PR description or walk through files — the tour shows the code.",
    "- Line 1: what this PR does (one sentence).",
    "- Line 2: why (one sentence, omit if obvious from the title).",
    "- Then \"Watch:\" — up to 3 one-line bullets, ONLY risks the reviewer must verify. Omit entirely if nothing risky.",
    "",
    "Immediately after the briefing, define the tour as VERTICAL SLICES — by concern, not by file. 3-6 slices:",
    "- title: max 6 words.",
    "- summary: ONE sentence — what changed and the one thing to watch.",
    "- 1-3 target files per slice (line = line number in the PR head version).",
    "",
    "End with exactly this marker on its own line, then the JSON array — no code fences, no text after it:",
    "---SLICES---",
    '[{"title":"...","summary":"...","targets":[{"file":"relative/path","line":123}]}]',
  ];
  if (args.guidelines) {
    lines.push(
      "",
      "## Project review guidelines (apply silently; do not quote them)",
      args.guidelines.slice(0, 4000),
    );
  }
  lines.push("", "--- FULL DIFF ---", clampDiff(args.diff), "--- END DIFF ---");
  return lines.join("\n");
}

export function buildPrCommentsPrompt(args: {
  comments: PrComment[];
  pr?: { number: number; title: string };
}): string {
  const header = args.pr
    ? `The user finished touring PR #${args.pr.number} (${args.pr.title}) and left inline review comments in the code, each starting with "?".`
    : 'The user left inline review comments in their code, each starting with "?".';
  const grouped = args.comments
    .map(
      (comment) =>
        `### ${comment.file}:${comment.line}\n> ? ${comment.text}\n\nCode under the comment:\n\n\`\`\`\n${comment.context}\n\`\`\``,
    )
    .join("\n\n");
  return [
    header,
    "Address every comment, grouped by file in code order:",
    '- If it is a question: answer it precisely, referencing file:line.',
    '- If it flags a bug or needed change: confirm or correct the concern in one or two sentences, then propose the fix as a fenced code block immediately preceded by EXACTLY one line: `kloser-apply: <file>:<startLine>-<endLine>` — those inclusive 1-based lines are replaced by the block (use the same line for start and end on a pure insertion). The block must be the COMPLETE replacement for those lines, and may include the `?` comment line if the comment is resolved by it.',
    '- If it is a note of approval or preference: acknowledge briefly.',
    "Finish with a short summary: how many concerns were valid, and the recommended next step.",
    "",
    "--- COMMENTS ---",
    grouped,
    "--- END COMMENTS ---",
  ].join("\n");
}

export function buildRedirectPrompt(instruction: string, correction: string): string {
  return [
    "The user is interrupting the replacement code you are producing.",
    `Original instruction: ${instruction}`,
    `User correction: ${correction}`,
    "",
    "Start over and return ONLY the complete updated replacement code for the block from the beginning — no fences, no explanations — fully incorporating the correction.",
  ].join("\n");
}

export function buildReplacementPrompt(args: PromptArgs): string {
  return [
    "You are Kloser, a code-completion agent embedded in the user's editor.",
    "Rewrite the SELECTED BLOCK so that it fulfils the user's instruction.",
    "",
    "Output rules:",
    "- Respond with ONLY the replacement code for the selected block.",
    "- Do not include markdown code fences, explanations, or notes.",
    "- The output must be a drop-in replacement: match the surrounding indentation and style.",
    "- Do not output code that belongs outside the block.",
    "",
    "Interpretation rules:",
    "- The instruction applies to the SELECTED BLOCK as a single unit, never to each line individually.",
    "- Example: \"add a comment above\" means ONE comment above the entire block, not a comment above every line.",
    "- Keep every line of the original block unless the instruction explicitly asks to change, add, or remove it.",
    "",
    `File: ${args.relativePath} (language: ${args.languageId})`,
    `User instruction: ${args.instruction}`,
    "",
    "--- CODE CONTEXT ---",
    args.beforeContext,
    "<<<KLOSER-SELECTED-BLOCK-START>>>",
    args.selectedCode,
    "<<<KLOSER-SELECTED-BLOCK-END>>>",
    args.afterContext,
    "--- END CODE CONTEXT ---",
  ].join("\n");
}
