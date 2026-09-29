import { describe, expect, it } from "vitest";
import { issueKeys } from "@multica/core/issues/queries";
import { orchestrationIssuesQueryOptions } from "./use-orchestration-issues";

describe("orchestrationIssuesQueryOptions", () => {
  it("nests under the workspace issue key so list invalidation refreshes the graph", () => {
    const opts = orchestrationIssuesQueryOptions("ws-1");
    expect(opts.queryKey[0]).toEqual(issueKeys.all("ws-1")[0]);
    expect(opts.queryKey).toContain("orchestration");
    expect(opts.enabled).toBe(true);
  });
});
