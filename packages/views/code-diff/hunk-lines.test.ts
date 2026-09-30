import { describe, expect, it } from "vitest";
import {
  attachMeta,
  foldContext,
  hunksToLines,
  toSplitRows,
} from "./hunk-lines";

const SQL_HUNK = `@@ -1,4 +1,4 @@
 SELECT 1;
--- keep old
+-- keep new
 FROM t;`;

const EMBEDDED_HUNK = `@@ -1 +1,3 @@
 kept
+--- a/schema.sql
++++ b/schema.sql
+@@ -1 +1 @@`;

describe("hunksToLines", () => {
  it("treats --- / +++ inside a hunk as content, not file headers", () => {
    const lines = hunksToLines([SQL_HUNK]);
    const del = lines.find((line) => line.kind === "del");
    const add = lines.find((line) => line.kind === "add");
    expect(del).toMatchObject({ text: "-- keep old", oldNo: 2, newNo: null });
    expect(add).toMatchObject({ text: "-- keep new", oldNo: null, newNo: 2 });
    expect(lines.filter((line) => line.kind === "hunk")).toHaveLength(1);
  });

  it("keeps an embedded sample diff as added lines", () => {
    const lines = hunksToLines([EMBEDDED_HUNK]);
    const added = lines.filter((line) => line.kind === "add").map((line) => line.text);
    expect(added).toEqual(["--- a/schema.sql", "+++ b/schema.sql", "@@ -1 +1 @@"]);
  });

  it("attaches the no-newline marker to the line above it", () => {
    const lines = attachMeta(
      hunksToLines([
        "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
      ]),
    );
    expect(lines.map((line) => line.kind)).toEqual(["hunk", "del", "add"]);
    expect(lines[1]?.note).toBe("\\ No newline at end of file");
    expect(lines[2]?.note).toBe("\\ No newline at end of file");
  });
});

describe("foldContext", () => {
  it("hides the middle of a long unchanged run", () => {
    const body = Array.from({ length: 10 }, (_, i) => ` line ${i}`).join("\n");
    const lines = attachMeta(hunksToLines([`@@ -1,11 +1,11 @@\n${body}\n-old`]));
    const folded = foldContext(lines, new Set());
    const hidden = folded.find((item) => item.type === "fold");
    expect(hidden).toMatchObject({ type: "fold", count: 4 });
    const visible = folded
      .filter((item) => item.type === "line" && item.line.kind === "context")
      .map((item) => (item.type === "line" ? item.line.text : ""));
    expect(visible).toEqual(["line 0", "line 1", "line 2", "line 7", "line 8", "line 9"]);
  });
});

describe("toSplitRows", () => {
  it("pairs a deletion with the following addition", () => {
    const items = foldContext(
      attachMeta(hunksToLines(["@@ -1,2 +1,2 @@\n-old\n+new\n same"])),
      new Set(),
    );
    const rows = toSplitRows(items);
    const pair = rows.find((row) => row.type === "pair" && row.left?.line.kind === "del");
    expect(pair).toMatchObject({
      left: { line: { text: "old" } },
      right: { line: { text: "new" } },
    });
  });
});
