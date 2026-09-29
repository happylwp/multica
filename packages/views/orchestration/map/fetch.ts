import type { OrchestrationIssue } from "./types";

export const ORCHESTRATION_PAGE_SIZE = 100;
export const ORCHESTRATION_OFFSET_CAP = 10_000;

export interface IssuePage {
  issues: OrchestrationIssue[];
  total: number;
}

/**
 * Paginate GET /api/issues until the workspace is exhausted.
 * Matches orchestration-gen: walk by actual page length, cap offset, never
 * treat a missing array as an empty workspace.
 */
export async function fetchAllOrchestrationIssues(
  listIssues: (params: { limit: number; offset: number }) => Promise<IssuePage>,
): Promise<OrchestrationIssue[]> {
  const all: OrchestrationIssue[] = [];
  let offset = 0;
  for (;;) {
    if (offset >= ORCHESTRATION_OFFSET_CAP) {
      throw new Error(
        `issue list offset exceeded ${ORCHESTRATION_OFFSET_CAP} (fetched ${all.length})`,
      );
    }
    const res = await listIssues({
      limit: ORCHESTRATION_PAGE_SIZE,
      offset,
    });
    const page = res.issues;
    if (!Array.isArray(page)) {
      throw new Error("issue list response is missing an issues array");
    }
    all.push(...page);
    if (page.length < ORCHESTRATION_PAGE_SIZE) break;
    if (typeof res.total === "number" && all.length >= res.total) break;
    offset += page.length;
  }
  return all;
}
