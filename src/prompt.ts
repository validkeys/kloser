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
