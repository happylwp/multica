import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffViewer } from "./code-diff-viewer";
import type { ParsedDiffFile } from "./parse-unified-diff";

vi.mock("./code-diff-hunk-view", () => ({
  CodeDiffHunkView: ({ hunks }: { hunks: readonly string[] }) => {
    if (hunks.some((hunk) => hunk.includes("BOOM"))) {
      throw new Error("Invalid hunk header format");
    }
    return <pre data-testid="code-diff-hunk">{hunks.join("\n")}</pre>;
  },
}));

const files: ParsedDiffFile[] = [
  {
    oldPath: "boom.ts",
    newPath: "boom.ts",
    path: "boom.ts",
    renamed: false,
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: ["@@ -0,0 +1 @@\n+BOOM"],
  },
  {
    oldPath: "ok.ts",
    newPath: "ok.ts",
    path: "ok.ts",
    renamed: false,
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: ["@@ -0,0 +1 @@\n+ok"],
  },
];

describe("CodeDiffViewer error boundary", () => {
  it("keeps the file list usable when the hunk pane throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithI18n(
      <div>
        <p>page-marker</p>
        <CodeDiffViewer files={files} />
      </div>,
    );
    expect(screen.getByText("page-marker")).toBeInTheDocument();
    expect(screen.getByTestId("code-diff-file-list")).toBeInTheDocument();
    expect(screen.getByTestId("code-diff-render-error")).toBeInTheDocument();
    expect(screen.queryByTestId("code-diff-hunk")).toBeNull();

    await user.click(screen.getByText("ok.ts"));
    expect(screen.queryByTestId("code-diff-render-error")).toBeNull();
    expect(screen.getByTestId("code-diff-hunk").textContent).toContain("+ok");
    expect(screen.getByText("page-marker")).toBeInTheDocument();
  });
});
