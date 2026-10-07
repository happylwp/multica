import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffViewer } from "./code-diff-viewer";
import { parseUnifiedDiff, type ParsedDiffFile } from "./parse-unified-diff";

const files: ParsedDiffFile[] = [
  {
    oldPath: "a.ts",
    newPath: "a.ts",
    path: "a.ts",
    renamed: false,
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: ["@@ -1 +1 @@\n-old\n+new"],
  },
  {
    oldPath: "b.ts",
    newPath: "b.ts",
    path: "b.ts",
    renamed: false,
    binary: false,
    additions: 2,
    deletions: 0,
    hunks: ["@@ -0,0 +1,2 @@\n+one\n+two"],
  },
];

const SQL = `diff --git a/schema.sql b/schema.sql
--- a/schema.sql
+++ b/schema.sql
@@ -1,4 +1,4 @@
 SELECT 1;
--- keep old
+-- keep new
 FROM t;
`;

const EMBEDDED = [
  "diff --git a/parse.test.ts b/parse.test.ts",
  "--- a/parse.test.ts",
  "+++ b/parse.test.ts",
  "@@ -1 +1,3 @@",
  " kept",
  "+--- a/schema.sql",
  "++++ b/schema.sql",
  "+@@ -1 +1 @@",
  "",
].join("\n");

function kindOf(text: string): string | null {
  return screen.getByText(text).closest("[data-kind]")?.getAttribute("data-kind") ?? null;
}

describe("CodeDiffViewer", () => {
  it("lists files with +/- stats and switches the rendered hunk", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CodeDiffViewer files={files} />);
    expect(screen.getByTestId("code-diff-file-list")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(kindOf("old")).toBe("del");
    expect(screen.getByText("old").closest("[data-kind]")?.className).toContain("bg-red-500/15");
    await user.click(screen.getByText("b.ts"));
    expect(kindOf("one")).toBe("add");
    expect(screen.getByText("one").closest("[data-kind]")?.className).toContain("bg-emerald-500/15");
  });

  it("collapses the selected file", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CodeDiffViewer files={files} />);
    await user.click(screen.getByRole("button", { name: "Collapse file" }));
    expect(screen.queryByTestId("code-diff-hunk")).toBeNull();
  });

  it("colors SQL -- comment lines inside the hunk", () => {
    const { files: parsed } = parseUnifiedDiff(SQL);
    renderWithI18n(<CodeDiffViewer files={parsed} />);
    expect(kindOf("-- keep old")).toBe("del");
    expect(screen.getByText("-- keep old").closest("[data-kind]")?.className).toContain("bg-red-500/15");
    expect(kindOf("-- keep new")).toBe("add");
    expect(screen.getByText("-- keep new").closest("[data-kind]")?.className).toContain("bg-emerald-500/15");
  });

  it("renders an embedded sample diff as added lines", () => {
    const { files: parsed } = parseUnifiedDiff(EMBEDDED);
    renderWithI18n(<CodeDiffViewer files={parsed} />);
    expect(parsed).toHaveLength(1);
    expect(kindOf("--- a/schema.sql")).toBe("add");
    expect(kindOf("+++ b/schema.sql")).toBe("add");
    expect(kindOf("@@ -1 +1 @@")).toBe("add");
  });

  it("expands folded unchanged context", async () => {
    const user = userEvent.setup();
    const body = Array.from({ length: 10 }, (_, i) => ` line ${i}`).join("\n");
    renderWithI18n(
      <CodeDiffViewer
        files={[
          {
            ...files[0]!,
            path: "long.ts",
            hunks: [`@@ -1,11 +1,11 @@\n${body}\n-old`],
          },
        ]}
      />,
    );
    expect(screen.queryByText("line 4")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show 4 unchanged lines" }));
    expect(screen.getByText("line 4")).toBeInTheDocument();
  });
});
