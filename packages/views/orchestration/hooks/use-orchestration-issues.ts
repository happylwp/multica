"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys } from "@multica/core/issues/queries";
import { fetchAllOrchestrationIssues } from "../map/fetch";
import { buildWorkflow } from "../map/workflow";
import { DEFAULT_MAX_NODES, DEFAULT_RECENT_CLOSED } from "../map/types";

export function orchestrationIssuesQueryOptions(wsId: string) {
  return {
    queryKey: [...issueKeys.all(wsId), "orchestration"] as const,
    queryFn: () =>
      fetchAllOrchestrationIssues((params) =>
        api.listIssues({ ...params, workspace_id: wsId }),
      ),
    enabled: Boolean(wsId),
  };
}

export function useOrchestrationGraph() {
  const wsId = useWorkspaceId();
  const query = useQuery(orchestrationIssuesQueryOptions(wsId));
  const graph = useMemo(
    () => buildWorkflow(query.data ?? [], {
      maxNodes: DEFAULT_MAX_NODES,
      recentClosed: DEFAULT_RECENT_CLOSED,
    }),
    [query.data],
  );
  return { ...query, graph };
}
