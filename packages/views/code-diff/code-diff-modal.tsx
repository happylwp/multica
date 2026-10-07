"use client";

import { Loader2, X } from "lucide-react";
import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { CodeDiffViewer } from "./code-diff-viewer";
import type { ParsedDiffFile } from "./parse-unified-diff";

export interface CodeDiffModalProps {
  open: boolean;
  filename: string;
  files: ParsedDiffFile[] | null;
  loading: boolean;
  error: "too_large" | "failed" | "parse_failed" | null;
  onClose: () => void;
  onDownload: () => void;
}

export function CodeDiffModal({
  open,
  filename,
  files,
  loading,
  error,
  onClose,
  onDownload,
}: CodeDiffModalProps) {
  const { t } = useT("editor");

  let body = null;
  if (loading) {
    body = (
      <div className="flex h-full items-center justify-center gap-2 text-body text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t(($) => $.attachment.preview_loading)}
      </div>
    );
  } else if (error === "too_large") {
    body = (
      <Fallback
        message={t(($) => $.attachment.preview_too_large)}
        onDownload={onDownload}
      />
    );
  } else if (error === "failed") {
    body = (
      <Fallback
        message={t(($) => $.attachment.preview_failed)}
        onDownload={onDownload}
      />
    );
  } else if (error === "parse_failed") {
    body = (
      <Fallback
        message={t(($) => $.code_diff.parse_failed)}
        onDownload={onDownload}
      />
    );
  } else if (files) {
    body = <CodeDiffViewer files={files} />;
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-full max-w-[min(96rem,calc(100%-2rem))] sm:max-w-[min(96rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0">
            <DialogTitle className="truncate text-body font-medium">
              {t(($) => $.code_diff.title)}
            </DialogTitle>
            <DialogDescription className="truncate text-caption text-muted-foreground">
              {filename}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t(($) => $.attachment.close)}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <ErrorBoundary
            resetKeys={[filename, loading, error, files?.length ?? 0]}
            fallback={({ reset }) => (
              <ModalCrash reset={reset} onDownload={onDownload} />
            )}
          >
            {body}
          </ErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModalCrash({
  reset,
  onDownload,
}: {
  reset: () => void;
  onDownload: () => void;
}) {
  const { t } = useT("editor");
  const { t: tUi } = useT("ui");
  return (
    <div
      role="alert"
      data-testid="code-diff-modal-error"
      className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
    >
      <p className="text-body text-muted-foreground">{t(($) => $.code_diff.render_failed)}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={reset}>
          {tUi(($) => $.error_boundary.try_again)}
        </Button>
        <Button type="button" variant="outline" onClick={onDownload}>
          {t(($) => $.image.download)}
        </Button>
      </div>
    </div>
  );
}

function Fallback({
  message,
  onDownload,
}: {
  message: string;
  onDownload: () => void;
}) {
  const { t } = useT("editor");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="text-body text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" onClick={onDownload}>
        {t(($) => $.image.download)}
      </Button>
    </div>
  );
}
