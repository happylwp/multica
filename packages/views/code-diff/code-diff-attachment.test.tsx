import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffAttachment } from "./code-diff-attachment";

const { loadDiffText } = vi.hoisted(() => ({
  loadDiffText: vi.fn(),
}));

vi.mock("./load-diff-text", () => ({ loadDiffText }));

const SAMPLE = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

describe("CodeDiffAttachment", () => {
  it("opens the viewer after loading a parseable diff", async () => {
    loadDiffText.mockResolvedValueOnce({ ok: true, text: SAMPLE });
    const user = userEvent.setup();
    renderWithI18n(
      <CodeDiffAttachment filename="changes.diff" attachmentId="att-1" onDownload={() => {}} />,
    );
    await user.click(screen.getByTestId("code-diff-entry"));
    await waitFor(() => {
      expect(screen.getByTestId("code-diff-viewer")).toBeInTheDocument();
    });
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(loadDiffText).toHaveBeenCalledWith({ attachmentId: "att-1", sizeBytes: undefined });
  });

  it("shows the download fallback when the body is too large", async () => {
    loadDiffText.mockResolvedValueOnce({ ok: false, reason: "too_large" });
    const onDownload = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(
      <CodeDiffAttachment filename="changes.diff" attachmentId="att-1" onDownload={onDownload} />,
    );
    await user.click(screen.getByTestId("code-diff-entry"));
    await waitFor(() => {
      expect(screen.getByText("File is too large to preview. Please download.")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalled();
  });
});
