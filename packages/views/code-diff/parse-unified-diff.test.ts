// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CODE_DIFF_MAX_LINE_CHARS, parseUnifiedDiff, summarizeDiff } from "./parse-unified-diff";
import { unescapeGitPath } from "./unescape-git-path";

const MULTI = `diff --git a/src/hello.ts b/src/hello.ts
index 111..222 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,3 +1,4 @@
 export function hello() {
-  return "hi";
+  return "hello";
+  // trailing
 }
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Title
+more
`;

const RENAME = `diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
`;

const BINARY = `diff --git a/pic.png b/pic.png
index 000..aaa
Binary files a/pic.png and b/pic.png differ
`;

const PLAIN_PATCH = `--- a/plain.txt
+++ b/plain.txt
@@ -1 +1 @@
-old
+new
`;

const NO_NEWLINE = `diff --git a/eof.txt b/eof.txt
--- a/eof.txt
+++ b/eof.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

describe("unescapeGitPath", () => {
  it("strips a/ b/ and /dev/null", () => {
    expect(unescapeGitPath("a/src/foo.ts")).toBe("src/foo.ts");
    expect(unescapeGitPath("/dev/null")).toBe("");
  });

  it("decodes quoted octal UTF-8 Chinese paths", () => {
    const quoted = '"a/\\346\\265\\213\\350\\257\\225.ts"';
    expect(unescapeGitPath(quoted)).toBe("测试.ts");
  });
});

describe("parseUnifiedDiff", () => {
  it("splits multi-file git diffs and counts +/-", () => {
    const { files } = parseUnifiedDiff(MULTI);
    expect(files.map((f) => f.path)).toEqual(["src/hello.ts", "README.md"]);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
    expect(files[1]?.additions).toBe(1);
    expect(summarizeDiff(files)).toEqual({ additions: 3, deletions: 1 });
  });

  it("keeps rename-only files", () => {
    const { files } = parseUnifiedDiff(RENAME);
    expect(files).toHaveLength(1);
    expect(files[0]?.renamed).toBe(true);
    expect(files[0]?.oldPath).toBe("old name.ts");
    expect(files[0]?.newPath).toBe("new name.ts");
    expect(files[0]?.hunks).toEqual([]);
  });

  it("marks binary files", () => {
    const { files } = parseUnifiedDiff(BINARY);
    expect(files[0]?.binary).toBe(true);
    expect(files[0]?.path).toBe("pic.png");
  });

  it("parses a plain unified patch without git headers", () => {
    const { files } = parseUnifiedDiff(PLAIN_PATCH);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("plain.txt");
    expect(files[0]?.additions).toBe(1);
    expect(files[0]?.deletions).toBe(1);
  });

  it("keeps the no-newline marker", () => {
    const { files } = parseUnifiedDiff(NO_NEWLINE);
    expect(files[0]?.hunks[0]).toContain("\\ No newline at end of file");
  });

  it("clips extremely long lines", () => {
    const long = `+${"x".repeat(CODE_DIFF_MAX_LINE_CHARS + 80)}`;
    const text = `--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1 @@\n${long}\n`;
    const { files } = parseUnifiedDiff(text);
    const hunk = files[0]?.hunks[0] ?? "";
    const added = hunk.split("\n").find((l) => l.startsWith("+"));
    expect(added?.endsWith("…")).toBe(true);
    expect((added?.length ?? 0) <= CODE_DIFF_MAX_LINE_CHARS + 1).toBe(true);
  });

  it("accepts unquoted UTF-8 paths", () => {
    const text = `diff --git a/中文/路径.ts b/中文/路径.ts
--- a/中文/路径.ts
+++ b/中文/路径.ts
@@ -1 +1 @@
-a
+b
`;
    const { files } = parseUnifiedDiff(text);
    expect(files[0]?.path).toBe("中文/路径.ts");
  });
});
