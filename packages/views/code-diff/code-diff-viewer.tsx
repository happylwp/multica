"use client";

import { useMemo, useState } from "react";
import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { CodeDiffHunkView } from "./code-diff-hunk-view";
import { summarizeDiff, type ParsedDiffFile } from "./parse-unified-diff";

export interface CodeDiffViewerProps {
  files: ParsedDiffFile[];
  className?: string;
}

function HunkCrash({ reset }: { reset: () => void }) {
  const { t } = useT("editor");
  const { t: tUi } = useT("ui");
  return (
    <div
      role="alert"
      data-testid="code-diff-render-error"
      className="flex flex-col items-start gap-3 p-4"
    >
      <p className="text-body text-muted-foreground">{t(($) => $.code_diff.render_failed)}</p>
      <Button type="button" size="sm" variant="outline" onClick={reset}>
        {tUi(($) => $.error_boundary.try_again)}
      </Button>
    </div>
  );
}

export function CodeDiffViewer({ files, className }: CodeDiffViewerProps) {
  const { t } = useT("editor");
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [split, setSplit] = useState(false);

  const totals = useMemo(() => summarizeDiff(files), [files]);
  const file = files[selected];

  if (files.length === 0) {
    return (
      <div
        data-testid="code-diff-viewer"
        className={cn("flex h-full items-center justify-center px-6 text-body text-muted-foreground", className)}
      >
        {t(($) => $.code_diff.empty)}
      </div>
    );
  }

  return (
    <div
      data-testid="code-diff-viewer"
      className={cn("flex min-h-0 flex-1 flex-col md:flex-row", className)}
    >
      <nav
        data-testid="code-diff-file-list"
        className="flex max-h-40 shrink-0 flex-col overflow-auto border-b border-border md:max-h-none md:w-64 md:border-r md:border-b-0"
        aria-label={t(($) => $.code_diff.file_list)}
      >
        <div className="sticky top-0 border-b border-border bg-background px-3 py-2 text-caption text-muted-foreground">
          {t(($) => $.code_diff.files, { count: files.length })}
          <span className="ml-2 tabular-nums text-emerald-600 dark:text-emerald-400">
            +{totals.additions}
          </span>
          <span className="ml-1 tabular-nums text-red-600 dark:text-red-400">
            −{totals.deletions}
          </span>
        </div>
        <ul className="p-1">
          {files.map((item, index) => {
            const active = index === selected;
            return (
              <li key={`${item.path}-${index}`}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left text-caption transition-colors",
                    active ? "bg-muted text-foreground" : "hover:bg-muted/60",
                  )}
                  onClick={() => setSelected(index)}
                >
                  <span className="truncate font-medium">{item.path || item.oldPath}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {item.binary
                      ? t(($) => $.code_diff.binary)
                      : item.renamed
                        ? t(($) => $.code_diff.renamed)
                        : null}
                    {!item.binary && (
                      <>
                        <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                          +{item.additions}
                        </span>
                        <span className="ml-1 text-red-600 dark:text-red-400">
                          −{item.deletions}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <button
            type="button"
            className="truncate text-caption text-muted-foreground hover:text-foreground"
            onClick={() => {
              if (!file) return;
              const key = file.path;
              setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
            }}
          >
            {file && collapsed[file.path]
              ? t(($) => $.code_diff.expand_file)
              : t(($) => $.code_diff.collapse_file)}
          </button>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              className={cn(
                "rounded-md px-2 py-0.5 text-caption",
                !split ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
              onClick={() => setSplit(false)}
            >
              {t(($) => $.code_diff.unified)}
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md px-2 py-0.5 text-caption",
                split ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
              onClick={() => setSplit(true)}
            >
              {t(($) => $.code_diff.split)}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {file && !collapsed[file.path] && (
            <ErrorBoundary
              resetKeys={[selected, file.path, split]}
              fallback={({ reset }) => <HunkCrash reset={reset} />}
            >
              {file.binary || file.hunks.length === 0 ? (
                <div className="px-4 py-8 text-body text-muted-foreground">
                  {file.binary
                    ? t(($) => $.code_diff.binary)
                    : file.renamed
                      ? t(($) => $.code_diff.renamed)
                      : t(($) => $.code_diff.empty)}
                </div>
              ) : (
                <CodeDiffHunkView hunks={file.hunks} split={split} />
              )}
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
