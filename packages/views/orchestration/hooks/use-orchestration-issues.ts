import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { fetchAllIssues } from "./fetch-all-issues";

export const orchestrationKeys = {
  all: (wsId: string) => ["orchestration", "issues", wsId] as const,
};

export function useOrchestrationIssues(wsId: string) {
  return useQuery({
    queryKey: orchestrationKeys.all(wsId),
    queryFn: () => fetchAllIssues<Issue>((params) => api.listIssues(params)),
    enabled: Boolean(wsId),
  });
}
