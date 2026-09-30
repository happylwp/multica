import {
  api,
  PreviewTooLargeError,
  PreviewUnsupportedError,
} from "@multica/core/api";
import { CODE_DIFF_PREVIEW_MAX_BYTES, isCodeDiffOverLimit } from "./limits";

export type LoadDiffTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "failed" };

/**
 * Load a .diff/.patch body without new backend endpoints.
 * Prefer the existing text-preview proxy (text/* already allowed). If the
 * sniffer stored an unlisted MIME and the proxy returns 415, fall back to
 * the authenticated download blob and decode UTF-8.
 */
export async function loadDiffText(input: {
  attachmentId?: string;
  sizeBytes?: number;
}): Promise<LoadDiffTextResult> {
  if (isCodeDiffOverLimit(input.sizeBytes)) {
    return { ok: false, reason: "too_large" };
  }
  if (!input.attachmentId) {
    return { ok: false, reason: "failed" };
  }

  try {
    const { text } = await api.getAttachmentTextContent(input.attachmentId);
    return { ok: true, text };
  } catch (err) {
    if (err instanceof PreviewTooLargeError) {
      return { ok: false, reason: "too_large" };
    }
    if (!(err instanceof PreviewUnsupportedError)) {
      return { ok: false, reason: "failed" };
    }
  }

  try {
    const blob = await api.getAttachmentBlob(input.attachmentId);
    if (blob.size > CODE_DIFF_PREVIEW_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    const text = await blob.text();
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
