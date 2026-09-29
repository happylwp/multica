// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fetchAllIssues, OrchestrationFetchError } from "../hooks/fetch-all-issues";
import { PAGE_SIZE } from "./types";

describe("fetchAllIssues", () => {
  it("walks pages until a short page", async () => {
    const pages = [
      { issues: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(i) })), total: 150 },
      { issues: Array.from({ length: 50 }, (_, i) => ({ id: String(100 + i) })), total: 150 },
    ];
    let calls = 0;
    const all = await fetchAllIssues(async ({ offset }) => {
      const page = pages[calls]!;
      calls += 1;
      expect(offset).toBe((calls - 1) * PAGE_SIZE);
      return page;
    });
    expect(all).toHaveLength(150);
    expect(calls).toBe(2);
  });

  it("stops when accumulated length reaches total", async () => {
    const all = await fetchAllIssues(async () => ({
      issues: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(i) })),
      total: PAGE_SIZE,
    }));
    expect(all).toHaveLength(PAGE_SIZE);
  });

  it("throws when issues is missing instead of treating it as empty", async () => {
    await expect(
      fetchAllIssues(async () => ({ issues: undefined as unknown as [], total: 0 })),
    ).rejects.toBeInstanceOf(OrchestrationFetchError);
  });
});
