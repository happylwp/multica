"use client";

import { RefreshCw } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "@multica/ui/components/ui/button";
import { Switch } from "@multica/ui/components/ui/switch";
import { cn } from "@multica/ui/lib/utils";
import type { WorkflowStats } from "../map/types";
import { FILTER_TAGS, type FilterTag, tagTone } from "./tag-style";

export function OrchestrationToolbar({
  stats,
  focusActive,
  onFocusActiveChange,
  activeFilter,
  onFilterChange,
  onRefresh,
  isRefreshing,
}: {
  stats: WorkflowStats;
  focusActive: boolean;
  onFocusActiveChange: (value: boolean) => void;
  activeFilter: FilterTag | null;
  onFilterChange: (value: FilterTag | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  const { t } = useT("layout");
  const filterLabel: Record<FilterTag, string> = {
    waiting: t(($) => $.orchestration.filter_waiting),
    "blocked·等": t(($) => $.orchestration.filter_blocked_waiting),
    blocked: t(($) => $.orchestration.filter_blocked),
    待决策: t(($) => $.orchestration.filter_pending),
    in_progress: t(($) => $.orchestration.filter_in_progress),
    in_review: t(($) => $.orchestration.filter_in_review),
    done: t(($) => $.orchestration.filter_done),
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <label className="flex items-center gap-2 text-caption text-muted-foreground">
        <Switch
          checked={focusActive}
          onCheckedChange={onFocusActiveChange}
        />
        <span>{t(($) => $.orchestration.focus_active)}</span>
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {FILTER_TAGS.map((tag) => {
          const selected = activeFilter === tag;
          return (
            <Button
              key={tag}
              type="button"
              size="sm"
              variant={selected ? "secondary" : "ghost"}
              className={cn("h-7 px-2 text-caption", selected && tagTone(tag))}
              onClick={() => onFilterChange(selected ? null : tag)}
            >
              {filterLabel[tag]}
            </Button>
          );
        })}
      </div>
      <p className="ml-auto text-caption text-muted-foreground">
        {t(($) => $.orchestration.stats, {
          waiting: stats.waiting,
          blocked: stats.trueBlocked,
          pending: stats.pending,
        })}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        aria-label={t(($) => $.orchestration.refresh)}
        title={t(($) => $.orchestration.refresh)}
        disabled={isRefreshing}
        onClick={onRefresh}
      >
        <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
      </Button>
    </div>
  );
}
