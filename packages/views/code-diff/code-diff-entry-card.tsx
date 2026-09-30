"use client";

import { FileCode2 } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "@multica/ui/lib/utils";

export interface CodeDiffEntryCardProps {
  filename: string;
  onOpen: () => void;
  className?: string;
}

export function CodeDiffEntryCard({
  filename,
  onOpen,
  className,
}: CodeDiffEntryCardProps) {
  const { t } = useT("editor");

  return (
    <button
      type="button"
      data-testid="code-diff-entry"
      className={cn(
        "my-1 flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={onOpen}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileCode2 className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{filename}</span>
        <span className="block truncate text-caption text-brand">
          {t(($) => $.code_diff.view_changes)}
        </span>
      </span>
    </button>
  );
}
