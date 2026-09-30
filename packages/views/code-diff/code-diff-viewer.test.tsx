import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffViewer } from "./code-diff-viewer";
import type { ParsedDiffFile } from "./parse-unified-diff";

vi.mock("@multica/ui/components/common/theme-provider", () => ({
  useTheme: () => ({ theme: "light", resolvedTheme: "light" }),
}));

vi.mock("@git-diff-view/react", () => ({
  DiffView: ({ data }: { data: { hunks: string[] } }) => (
    <pre data-testid="git-diff-view">{data.hunks.join("\n")}</pre>
  ),
  DiffModeEnum: { Unified: 4, Split: 2 },
}));

vi.mock("@git-diff-view/react/styles/diff-view.css", () => ({}));

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

describe("CodeDiffViewer", () => {
  it("lists files with +/- stats and switches the rendered hunk", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CodeDiffViewer files={files} />);
    expect(screen.getByTestId("code-diff-file-list")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByTestId("git-diff-view").textContent).toContain("-old");
    await user.click(screen.getByText("b.ts"));
    expect(screen.getByTestId("git-diff-view").textContent).toContain("+one");
  });

  it("collapses the selected file", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CodeDiffViewer files={files} />);
    await user.click(screen.getByRole("button", { name: "Collapse file" }));
    expect(screen.queryByTestId("git-diff-view")).toBeNull();
  });
});
