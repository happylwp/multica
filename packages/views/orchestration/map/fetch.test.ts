import { describe, expect, it, vi } from "vitest";
import { fetchAllOrchestrationIssues, ORCHESTRATION_PAGE_SIZE } from "./fetch";
import type { OrchestrationIssue } from "./types";

function issue(id: string): OrchestrationIssue {
  return { id, identifier: id, title: id, status: "todo" };
}

describe("fetchAllOrchestrationIssues", () => {
  it("walks pages by returned length until a short page", async () => {
    const page1 = Array.from({ length: ORCHESTRATION_PAGE_SIZE }, (_, i) => issue(`a${i}`));
    const page2 = [issue("last")];
    const listIssues = vi
      .fn()
      .mockResolvedValueOnce({ issues: page1, total: 101 })
      .mockResolvedValueOnce({ issues: page2, total: 101 });
    const all = await fetchAllOrchestrationIssues(listIssues);
    expect(all).toHaveLength(101);
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues).toHaveBeenNthCalledWith(2, { limit: ORCHESTRATION_PAGE_SIZE, offset: 100 });
  });

  it("stops when total is reached on a full page", async () => {
    const page = Array.from({ length: ORCHESTRATION_PAGE_SIZE }, (_, i) => issue(`b${i}`));
    const listIssues = vi.fn().mockResolvedValue({ issues: page, total: 100 });
    const all = await fetchAllOrchestrationIssues(listIssues);
    expect(all).toHaveLength(100);
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  it("rejects a response without an issues array", async () => {
    await expect(
      fetchAllOrchestrationIssues(async () => ({ issues: undefined as unknown as OrchestrationIssue[], total: 0 })),
    ).rejects.toThrow(/issues array/);
  });
});
