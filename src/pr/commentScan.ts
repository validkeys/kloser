import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PrComment } from "../prompt";

const COMMENT_MARKER = /^\s*(?:\/\/|#|--|;|%|\/\*|\*|<!--) ?\? +(.+)$/;
const COMMENT_CONTEXT_LINES = 3;
const MAX_SCAN_FILE_BYTES = 512_000;

export async function scanMarkerComments(root: string, files: string[]): Promise<PrComment[]> {
  const comments: PrComment[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    let content: string;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
        continue;
      }
      content = await fs.readFile(absolute, "utf8");
    } catch {
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
