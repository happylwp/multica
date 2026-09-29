"use client";

import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { Button } from "@multica/ui/components/ui/button";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import { useOrchestrationIssues } from "../hooks/use-orchestration-issues";
import { buildWorkflow } from "../map/workflow";
import { DEFAULT_WORKFLOW_OPTS } from "../map/types";
import { OrchestrationCanvas } from "./orchestration-canvas";
import { OrchestrationToolbar, type StatusFilter } from "./orchestration-toolbar";

export function OrchestrationPage() {
  const { t } = useT("orchestration");
  const wsId = useWorkspaceId();
  const query = useOrchestrationIssues(wsId);
  const [focusActive, setFocusActive] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const doc = useMemo(
    () => (query.data ? buildWorkflow(query.data, DEFAULT_WORKFLOW_OPTS) : null),
    [query.data],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader
        icon={GitBranch}
        title={t(($) => $.page.title)}
        count={query.data?.length}
        description={query.isFetching ? t(($) => $.page.loading) : undefined}
        actions={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t(($) => $.toolbar.refresh)}
          </Button>
        }
      />
      {doc ? (
        <div className={`${PAGE_GUTTER} pb-2`}>
          <OrchestrationToolbar
            stats={doc.stats}
            nodeCount={doc.nodes.length}
            laneCount={doc.lanes.length}
            focusActive={focusActive}
            onFocusActiveChange={setFocusActive}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {query.isPending ? (
          <CollectionPageState
            icon={GitBranch}
            title={t(($) => $.page.loading)}
          />
        ) : query.isError ? (
          <CollectionPageState
            icon={GitBranch}
            title={t(($) => $.error.load_failed)}
            actions={
              <Button type="button" size="sm" onClick={() => void query.refetch()}>
                {t(($) => $.toolbar.refresh)}
              </Button>
            }
          />
        ) : doc ? (
          <OrchestrationCanvas
            doc={doc}
            focusActive={focusActive}
            statusFilter={statusFilter}
          />
        ) : null}
      </div>
    </div>
  );
}
