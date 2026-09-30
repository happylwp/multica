import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffModal } from "./code-diff-modal";
import type { ParsedDiffFile } from "./parse-unified-diff";

vi.mock("./code-diff-viewer", () => ({
  CodeDiffViewer: () => {
    throw new Error("Invalid hunk header format");
  },
}));

const files: ParsedDiffFile[] = [
  {
    oldPath: "a.ts",
    newPath: "a.ts",
    path: "a.ts",
    renamed: false,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  },
];

describe("CodeDiffModal error boundary", () => {
  it("keeps the dialog chrome when the viewer throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithI18n(
      <div>
        <p>page-marker</p>
        <CodeDiffModal
          open
          filename="changes.diff"
          files={files}
          loading={false}
          error={null}
          onClose={() => {}}
          onDownload={() => {}}
        />
      </div>,
    );
    expect(screen.getByText("page-marker")).toBeInTheDocument();
    expect(screen.getByText("Code changes")).toBeInTheDocument();
    expect(screen.getByTestId("code-diff-modal-error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
