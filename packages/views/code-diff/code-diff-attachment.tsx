"use client";

import { useCallback, useRef, useState } from "react";
import { CodeDiffEntryCard } from "./code-diff-entry-card";
import { CodeDiffModal } from "./code-diff-modal";
import { loadDiffText } from "./load-diff-text";
import { parseUnifiedDiff, type ParsedDiffFile } from "./parse-unified-diff";

export interface CodeDiffAttachmentProps {
  filename: string;
  attachmentId?: string;
  sizeBytes?: number;
  onDownload: () => void;
}

type Cache = {
  key: string;
  files: ParsedDiffFile[] | null;
  error: "too_large" | "failed" | "parse_failed" | null;
};

export function CodeDiffAttachment({
  filename,
  attachmentId,
  sizeBytes,
  onDownload,
}: CodeDiffAttachmentProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<ParsedDiffFile[] | null>(null);
  const [error, setError] = useState<"too_large" | "failed" | "parse_failed" | null>(null);
  const cacheRef = useRef<Cache | null>(null);

  const load = useCallback(async () => {
    const key = attachmentId ?? filename;
    if (cacheRef.current?.key === key) {
      setFiles(cacheRef.current.files);
      setError(cacheRef.current.error);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await loadDiffText({ attachmentId, sizeBytes });
    let next: Cache;
    if (!result.ok) {
      next = { key, files: null, error: result.reason };
    } else {
      const parsed = parseUnifiedDiff(result.text);
      if (parsed.files.length === 0 && result.text.trim() !== "") {
        next = { key, files: null, error: "parse_failed" };
      } else {
        next = { key, files: parsed.files, error: null };
      }
    }
    cacheRef.current = next;
    setFiles(next.files);
    setError(next.error);
    setLoading(false);
  }, [attachmentId, filename, sizeBytes]);

  const handleOpen = () => {
    setOpen(true);
    void load();
  };

  return (
    <>
      <CodeDiffEntryCard filename={filename} onOpen={handleOpen} />
      <CodeDiffModal
        open={open}
        filename={filename}
        files={files}
        loading={loading}
        error={error}
        onClose={() => setOpen(false)}
        onDownload={onDownload}
      />
    </>
  );
}
