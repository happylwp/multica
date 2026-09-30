import { unescapeGitPath } from "./unescape-git-path";

/** Cap a single line so a hostile or generated file cannot freeze the viewer. */
export const CODE_DIFF_MAX_LINE_CHARS = 4000;

export interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  path: string;
  renamed: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: string[];
}

export interface ParseUnifiedDiffResult {
  files: ParsedDiffFile[];
}

type DraftFile = {
  oldPath: string;
  newPath: string;
  renamed: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: string[];
  currentHunk: string[];
};

function emptyDraft(): DraftFile {
  return {
    oldPath: "",
    newPath: "",
    renamed: false,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    currentHunk: [],
  };
}

function flushHunk(draft: DraftFile): void {
  if (draft.currentHunk.length === 0) return;
  draft.hunks.push(draft.currentHunk.join("\n"));
  draft.currentHunk = [];
}

function finalize(draft: DraftFile): ParsedDiffFile {
  flushHunk(draft);
  const path = draft.newPath || draft.oldPath;
  const renamed =
    draft.renamed ||
    (draft.oldPath !== "" && draft.newPath !== "" && draft.oldPath !== draft.newPath);
  return {
    oldPath: draft.oldPath,
    newPath: draft.newPath,
    path,
    renamed,
    binary: draft.binary,
    additions: draft.additions,
    deletions: draft.deletions,
    hunks: draft.hunks,
  };
}

function hasFileIdentity(draft: DraftFile): boolean {
  return (
    draft.oldPath !== "" ||
    draft.newPath !== "" ||
    draft.hunks.length > 0 ||
    draft.currentHunk.length > 0 ||
    draft.binary ||
    draft.renamed
  );
}

function clipLine(line: string): string {
  if (line.length <= CODE_DIFF_MAX_LINE_CHARS) return line;
  return `${line.slice(0, CODE_DIFF_MAX_LINE_CHARS)}…`;
}

function nextNonEmptyLine(lines: string[], afterIndex: number): string | undefined {
  for (let i = afterIndex + 1; i < lines.length; i++) {
    const candidate = lines[i];
    if (candidate !== undefined && candidate !== "") return clipLine(candidate);
  }
  return undefined;
}

function inOpenHunk(draft: DraftFile | null): draft is DraftFile {
  return !!draft && draft.currentHunk.length > 0;
}

function consumeHunkLine(draft: DraftFile, line: string): void {
  if (line.startsWith("\\")) {
    draft.currentHunk.push(line);
    return;
  }
  const prefix = line[0];
  if (prefix === "+") {
    draft.additions += 1;
    draft.currentHunk.push(line);
  } else if (prefix === "-") {
    draft.deletions += 1;
    draft.currentHunk.push(line);
  } else if (prefix === " " || prefix === undefined) {
    draft.currentHunk.push(prefix === undefined ? ` ${line}` : line);
  } else {
    draft.currentHunk.push(line);
  }
}

function parseGitPaths(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length).trim();
  const quoted = /^("(?:\\.|[^"\\])*")\s+("(?:\\.|[^"\\])*")$/.exec(rest);
  if (quoted) {
    return {
      oldPath: unescapeGitPath(quoted[1] ?? ""),
      newPath: unescapeGitPath(quoted[2] ?? ""),
    };
  }
  const match = /^(.+?) (.+)$/.exec(rest);
  if (!match) return null;
  return {
    oldPath: unescapeGitPath(match[1] ?? ""),
    newPath: unescapeGitPath(match[2] ?? ""),
  };
}

/**
 * Parse a unified diff (git format or plain `diff -u`) entirely on the client.
 * Unknown / malformed hunks are skipped; a binary or rename-only file is kept.
 */
export function parseUnifiedDiff(text: string): ParseUnifiedDiffResult {
  const files: ParsedDiffFile[] = [];
  const state: { draft: DraftFile | null } = { draft: null };

  const startFile = (): DraftFile => {
    const current = state.draft;
    if (current && hasFileIdentity(current)) files.push(finalize(current));
    state.draft = emptyDraft();
    return state.draft;
  };

  const ensureDraft = (): DraftFile => state.draft ?? startFile();

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = clipLine(lines[i] ?? "");

    if (line.startsWith("diff --git ")) {
      const current = startFile();
      const paths = parseGitPaths(line);
      if (paths) {
        current.oldPath = paths.oldPath;
        current.newPath = paths.newPath;
      }
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      ensureDraft().binary = true;
      continue;
    }

    if (line.startsWith("rename from ")) {
      const current = ensureDraft();
      current.oldPath = unescapeGitPath(line.slice("rename from ".length));
      current.renamed = true;
      continue;
    }

    if (line.startsWith("rename to ")) {
      const current = ensureDraft();
      current.newPath = unescapeGitPath(line.slice("rename to ".length));
      current.renamed = true;
      continue;
    }

    if (line.startsWith("--- ")) {
      // A deleted `-- comment` becomes `--- comment`. Only start a new file
      // when we are already in a hunk AND the next non-empty line is `+++ `.
      const open = state.draft;
      if (inOpenHunk(open)) {
        const next = nextNonEmptyLine(lines, i);
        if (!next?.startsWith("+++ ")) {
          consumeHunkLine(open, line);
          continue;
        }
        const started = startFile();
        started.oldPath = unescapeGitPath(line.slice(4));
        continue;
      }
      const current = open ?? startFile();
      current.oldPath = unescapeGitPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      const open = state.draft;
      if (inOpenHunk(open)) {
        consumeHunkLine(open, line);
        continue;
      }
      ensureDraft().newPath = unescapeGitPath(line.slice(4));
      continue;
    }

    if (line.startsWith("@@")) {
      const current = ensureDraft();
      flushHunk(current);
      current.currentHunk.push(line);
      continue;
    }

    const open = state.draft;
    if (!open || open.currentHunk.length === 0) continue;
    consumeHunkLine(open, line);
  }

  if (state.draft && hasFileIdentity(state.draft)) files.push(finalize(state.draft));

  return { files };
}

export function summarizeDiff(files: ParsedDiffFile[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}
