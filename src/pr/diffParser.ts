export interface FileDiff {
  addedLines: number[];
  isAdded: boolean;
  isDeleted: boolean;
  path: string;
  previousPath?: string;
}

/**
 * Safely extracts a regex match group, returning empty string if not found.
 */
function getMatchGroup(match: RegExpExecArray | null, index: number): string {
  return match?.[index] ?? "";
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let headLine = 0;
  let pendingAdded = false;
  let pendingDeleted = false;
  let pendingRenameFrom: string | undefined;
  let pendingMinusPath: string | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      headLine = 0;
      pendingAdded = false;
      pendingDeleted = false;
      pendingRenameFrom = undefined;
      pendingMinusPath = undefined;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      pendingAdded = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      pendingDeleted = true;
      continue;
    }
    const renameFrom = /^rename from (.+)$/.exec(line);
    if (renameFrom) {
      pendingRenameFrom = getMatchGroup(renameFrom, 1);
      continue;
    }
    const minusPath = /^--- a\/(.+)$/.exec(line);
    if (minusPath) {
      pendingMinusPath = getMatchGroup(minusPath, 1);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      current = {
        addedLines: [],
        isAdded: false,
        isDeleted: true,
        path: pendingMinusPath ?? "",
        previousPath: pendingRenameFrom,
      };
      files.push(current);
      continue;
    }
    const plusPath = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusPath) {
      current = {
        addedLines: [],
        isAdded: pendingAdded,
        isDeleted: false,
        path: getMatchGroup(plusPath, 1),
        previousPath: pendingRenameFrom,
      };
      files.push(current);
      pendingAdded = false;
      pendingDeleted = false;
      pendingRenameFrom = undefined;
      continue;
    }
    if (!current) {
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      const lineNumStr = getMatchGroup(hunk, 1);
      headLine = Number(lineNumStr) - 1;
      // Validate parsed number
      if (!Number.isFinite(headLine) || headLine < 0) {
        headLine = 0;
      }
      continue;
    }
    if (line.startsWith("+")) {
      headLine += 1;
      current.addedLines.push(headLine);
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }
    headLine += 1;
  }
  return files;
}

export function relativeFilePaths(files: FileDiff[]): string[] {
  return files.filter((file) => !file.isDeleted).map((file) => file.path);
}
