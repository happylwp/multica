"use client";

import { useState } from "react";
import { AlertCircle, Loader2, Workflow } from "lucide-react";
import { useT } from "../../i18n";
import {
  CollectionPageHeader,
  CollectionPageState,
} from "../../layout/collection-page";
import { useOrchestrationGraph } from "../hooks/use-orchestration-issues";
import { OrchestrationCanvas } from "./orchestration-canvas";
import { OrchestrationToolbar } from "./orchestration-toolbar";
import type { FilterTag } from "./tag-style";

export function OrchestrationPage() {
  const { t } = useT("layout");
  const { graph, isPending, isError, isFetching, refetch } = useOrchestrationGraph();
  const [focusActive, setFocusActive] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterTag | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={Workflow}
        title={t(($) => $.orchestration.title)}
        count={graph.stats.total}
        description={t(($) => $.orchestration.description)}
      />
      <OrchestrationToolbar
        stats={graph.stats}
        focusActive={focusActive}
        onFocusActiveChange={setFocusActive}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        onRefresh={() => void refetch()}
        isRefreshing={isFetching}
      />
      {isPending ? (
        <CollectionPageState
          icon={Loader2}
          title={t(($) => $.orchestration.loading)}
        />
      ) : isError ? (
        <CollectionPageState
          icon={AlertCircle}
          tone="destructive"
          title={t(($) => $.orchestration.load_error)}
          actions={
            <button
              type="button"
              className="text-caption underline"
              onClick={() => void refetch()}
            >
              {t(($) => $.orchestration.retry)}
            </button>
          }
        />
      ) : (
        <OrchestrationCanvas
          graph={graph}
          focusActive={focusActive}
          activeFilter={activeFilter}
        />
      )}
    </div>
  );
}
