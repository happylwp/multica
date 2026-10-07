"use client";

import { useMemo, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import {
  attachMeta,
  foldContext,
  hunksToLines,
  toSplitRows,
  type DisplayLine,
  type FoldedItem,
} from "./hunk-lines";

const KIND_BG: Record<DisplayLine["kind"], string> = {
  add: "bg-emerald-500/15",
  del: "bg-red-500/15",
  context: "",
  hunk: "bg-sky-500/10 text-muted-foreground",
  meta: "bg-muted/40 text-muted-foreground",
};

function signFor(kind: DisplayLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  if (kind === "context") return " ";
  return "";
}

function ExpandContext({ count, onExpand }: { count: number; onExpand: () => void }) {
  const { t } = useT("editor");
  return (
    <button
      type="button"
      className="w-full bg-muted/50 py-1 text-center text-caption text-muted-foreground hover:bg-muted"
      data-testid="code-diff-expand-context"
      onClick={onExpand}
    >
      {t(($) => $.code_diff.expand_context, { count })}
    </button>
  );
}

function LineBody({ line, gutter }: { line: DisplayLine; gutter: "both" | "old" | "new" }) {
  const sign = signFor(line.kind);
  return (
    <div
      data-testid="code-diff-line"
      data-kind={line.kind}
      className={cn("flex min-w-0 flex-1", KIND_BG[line.kind])}
    >
      {gutter !== "new" && (
        <span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground tabular-nums">
          {line.oldNo ?? ""}
        </span>
      )}
      {gutter !== "old" && (
        <span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground tabular-nums">
          {line.newNo ?? ""}
        </span>
      )}
      <span className="w-4 shrink-0 select-none text-muted-foreground">{sign}</span>
      <span className="min-w-0 flex-1 whitespace-pre pr-3">
        {line.text}
        {line.note && (
          <span className="block text-muted-foreground italic">{line.note}</span>
        )}
      </span>
    </div>
  );
}

function EmptySide() {
  return <div className="min-h-5 min-w-0 flex-1 bg-muted/30" />;
}

export function CodeDiffHunkView({
  hunks,
  split,
}: {
  hunks: readonly string[];
  split: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(
    () => foldContext(attachMeta(hunksToLines(hunks)), expanded),
    [hunks, expanded],
  );
  const onExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  return (
    <div data-testid="code-diff-hunk" className="min-w-full font-mono text-caption leading-5">
      {split ? <SplitItems items={items} onExpand={onExpand} /> : <UnifiedItems items={items} onExpand={onExpand} />}
    </div>
  );
}

function UnifiedItems({
  items,
  onExpand,
}: {
  items: FoldedItem[];
  onExpand: (key: string) => void;
}) {
  return (
    <>
      {items.map((item) =>
        item.type === "fold" ? (
          <ExpandContext key={item.key} count={item.count} onExpand={() => onExpand(item.key)} />
        ) : (
          <LineBody key={item.key} line={item.line} gutter="both" />
        ),
      )}
    </>
  );
}

function SplitItems({
  items,
  onExpand,
}: {
  items: FoldedItem[];
  onExpand: (key: string) => void;
}) {
  const rows = useMemo(() => toSplitRows(items), [items]);
  return (
    <>
      {rows.map((row) => {
        if (row.type === "fold") {
          return <ExpandContext key={row.key} count={row.count} onExpand={() => onExpand(row.key)} />;
        }
        if (row.type === "banner") {
          return <LineBody key={row.key} line={row.line} gutter="both" />;
        }
        return (
          <div key={row.key} className="flex items-stretch">
            <div className="flex min-w-0 flex-1 border-r border-border">
              {row.left ? <LineBody line={row.left.line} gutter="old" /> : <EmptySide />}
            </div>
            <div className="flex min-w-0 flex-1">
              {row.right ? <LineBody line={row.right.line} gutter="new" /> : <EmptySide />}
            </div>
          </div>
        );
      })}
    </>
  );
}
