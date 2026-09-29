"use client";

import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import type { WorkflowStats } from "../map/types";

export type StatusFilter = "all" | "waiting" | "blocked" | "done";

export function OrchestrationToolbar({
  stats,
  nodeCount,
  laneCount,
  focusActive,
  onFocusActiveChange,
  statusFilter,
  onStatusFilterChange,
}: {
  stats: WorkflowStats;
  nodeCount: number;
  laneCount: number;
  focusActive: boolean;
  onFocusActiveChange: (next: boolean) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (next: StatusFilter) => void;
}) {
  const { t } = useT("orchestration");
  const filters: Array<{ key: StatusFilter; label: string }> = [
    { key: "all", label: t(($) => $.toolbar.filter_all) },
    { key: "waiting", label: t(($) => $.toolbar.filter_waiting) },
    { key: "blocked", label: t(($) => $.toolbar.filter_blocked) },
    { key: "done", label: t(($) => $.toolbar.filter_done) },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-caption text-muted-foreground">
        {t(($) => $.toolbar.stats, {
          total: stats.total,
          lanes: laneCount,
          nodes: nodeCount,
          waiting: stats.waiting,
          blocked: stats.trueBlocked,
        })}
      </p>
      <Button
        type="button"
        size="xs"
        variant={focusActive ? "brand" : "ghost"}
        aria-pressed={focusActive}
        onClick={() => onFocusActiveChange(!focusActive)}
      >
        {t(($) => $.toolbar.focus_active)}
      </Button>
      {filters.map((item) => (
        <Button
          key={item.key}
          type="button"
          size="xs"
          variant={statusFilter === item.key ? "brand" : "ghost"}
          aria-pressed={statusFilter === item.key}
          onClick={() => onStatusFilterChange(item.key)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
