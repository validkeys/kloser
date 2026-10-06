import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PrComment } from "../prompt";
import { validateWorkspacePath, PRValidationError } from "./validation";

const COMMENT_MARKER = /^\s*(?:\/\/|#|--|;|%|\/\*|\*|<!--) ?\? +(.+)$/;
const COMMENT_CONTEXT_LINES = 3;
const MAX_SCAN_FILE_BYTES = 512_000;

export async function scanMarkerComments(root: string, files: string[]): Promise<PrComment[]> {
  const comments: PrComment[] = [];
  for (const file of files) {
    let absolute: string;
    let content: string;
    try {
      // Validate path before accessing
      absolute = validateWorkspacePath(root, file);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
        continue;
      }
      content = await fs.readFile(absolute, "utf8");
    } catch (error) {
      if (error instanceof PRValidationError) {
        // Security issue - log and skip
        console.error(`[CommentScan] Security: ${error.message}`);
        continue;
      }
      // File not found or other expected errors
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ENOENT") {
          // Expected: file was deleted during PR review
          continue;
        }
        if (error.code === "EACCES" || error.code === "EPERM") {
          // Permission denied
          console.warn(`[CommentScan] Permission denied: ${file}`);
          continue;
        }
      }
      // Unexpected error - log but continue
      console.error(`[CommentScan] Error scanning ${file}:`, error);
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = COMMENT_MARKER.exec(lines[index]);
      if (!match) {
        continue;
      }
      const context = lines.slice(index + 1, index + 1 + COMMENT_CONTEXT_LINES).join("\n");
      comments.push({
        context,
        file,
        line: index + 1,
        text: (match[1] ?? "").trim(),
      });
    }
  }
  return comments;
}
