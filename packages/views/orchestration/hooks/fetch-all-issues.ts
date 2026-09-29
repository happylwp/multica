import { OFFSET_CAP, PAGE_SIZE } from "../map/types";

export interface IssuePage<T> {
  issues: T[];
  total: number;
}

export class OrchestrationFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationFetchError";
  }
}

/**
 * Walk GET /api/issues with limit/offset until a short page or `total`.
 * Mirrors orchestration-gen: a missing issues array is fatal, never empty.
 */
export async function fetchAllIssues<T>(
  listIssues: (params: { limit: number; offset: number }) => Promise<IssuePage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    if (offset >= OFFSET_CAP) {
      throw new OrchestrationFetchError(
        `issue list offset exceeded ${OFFSET_CAP} (fetched ${all.length})`,
      );
    }
    const data = await listIssues({ limit: PAGE_SIZE, offset });
    if (!data || !Array.isArray(data.issues)) {
      throw new OrchestrationFetchError("issue list response missing issues array");
    }
    all.push(...data.issues);
    if (data.issues.length < PAGE_SIZE) break;
    if (typeof data.total === "number" && all.length >= data.total) break;
    offset += data.issues.length;
  }
  return all;
}
