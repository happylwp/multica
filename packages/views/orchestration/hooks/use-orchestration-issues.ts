"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys } from "@multica/core/issues/queries";
import { fetchAllOrchestrationIssues } from "../map/fetch";
import { buildWorkflow } from "../map/workflow";
import { DEFAULT_MAX_NODES } from "../map/types";

/**
 * The workspace-wide query client pins staleTime to Infinity with
 * refetchOnWindowFocus off; the orchestration canvas tracks live pipelines, so
 * it opts into periodic polling plus focus refetch on top of the websocket
 * invalidations.
 */
export const ORCHESTRATION_REFETCH_MS = 30_000;

export function orchestrationIssuesQueryOptions(wsId: string) {
  return {
    queryKey: [...issueKeys.all(wsId), "orchestration"] as const,
    queryFn: () =>
      fetchAllOrchestrationIssues((params) =>
        api.listIssues({ ...params, workspace_id: wsId }),
      ),
    enabled: Boolean(wsId),
    staleTime: ORCHESTRATION_REFETCH_MS,
    refetchInterval: ORCHESTRATION_REFETCH_MS,
    refetchOnWindowFocus: true,
  };
}

export function useOrchestrationGraph() {
  const wsId = useWorkspaceId();
  const query = useQuery(orchestrationIssuesQueryOptions(wsId));
  const graph = useMemo(
    () => buildWorkflow(query.data ?? [], { maxNodes: DEFAULT_MAX_NODES }),
    [query.data],
  );
  return { ...query, graph };
}
