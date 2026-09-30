// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAttachmentTextContent,
  getAttachmentBlob,
  PreviewTooLargeError,
  PreviewUnsupportedError,
} = vi.hoisted(() => {
  class PreviewTooLargeError extends Error {
    override name = "PreviewTooLargeError";
  }
  class PreviewUnsupportedError extends Error {
    override name = "PreviewUnsupportedError";
  }
  return {
    getAttachmentTextContent: vi.fn(),
    getAttachmentBlob: vi.fn(),
    PreviewTooLargeError,
    PreviewUnsupportedError,
  };
});

vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent, getAttachmentBlob },
  PreviewTooLargeError,
  PreviewUnsupportedError,
}));

import { CODE_DIFF_PREVIEW_MAX_BYTES } from "./limits";
import { loadDiffText } from "./load-diff-text";

describe("loadDiffText", () => {
  beforeEach(() => {
    getAttachmentTextContent.mockReset();
    getAttachmentBlob.mockReset();
  });

  it("rejects oversize before fetching", async () => {
    const result = await loadDiffText({
      attachmentId: "a",
      sizeBytes: CODE_DIFF_PREVIEW_MAX_BYTES + 1,
    });
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(getAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("uses the text preview proxy when available", async () => {
    getAttachmentTextContent.mockResolvedValueOnce({
      text: "diff --git a/a b/a\n",
      originalContentType: "text/plain",
    });
    const result = await loadDiffText({ attachmentId: "a", sizeBytes: 12 });
    expect(result).toEqual({ ok: true, text: "diff --git a/a b/a\n" });
  });

  it("falls back to the download blob after 415", async () => {
    getAttachmentTextContent.mockRejectedValueOnce(new PreviewUnsupportedError());
    getAttachmentBlob.mockResolvedValueOnce(new Blob(["patch"]));
    const result = await loadDiffText({ attachmentId: "a" });
    expect(result).toEqual({ ok: true, text: "patch" });
  });

  it("maps 413 to too_large", async () => {
    getAttachmentTextContent.mockRejectedValueOnce(new PreviewTooLargeError());
    const result = await loadDiffText({ attachmentId: "a" });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("fails without an attachment id", async () => {
    const result = await loadDiffText({ filename: "x.diff" } as never);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});
