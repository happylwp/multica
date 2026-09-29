// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildWorkflow } from "./workflow";
import type { MappingIssue } from "./types";

function issue(partial: Partial<MappingIssue> & Pick<MappingIssue, "id">): MappingIssue {
  return {
    identifier: partial.identifier ?? `MARO-${partial.id}`,
    title: partial.title ?? "task",
    status: partial.status ?? "todo",
    last_activity_at: partial.last_activity_at ?? "2026-09-29T00:00:00Z",
    ...partial,
  };
}

describe("buildWorkflow", () => {
  it("renders an empty workspace as a single empty lane", () => {
    const doc = buildWorkflow([]);
    expect(doc.lanes[0]!.id).toBe("lempty");
    expect(doc.nodes).toEqual([
      expect.objectContaining({ id: "empty", tag: "empty", col: 0 }),
    ]);
    expect(doc.stats.total).toBe(0);
  });

  it("puts the parent in col 0 and staged children in col 1-5", () => {
    const root = issue({ id: "root", identifier: "MARO-1", title: "父任务", status: "in_progress" });
    const impl = issue({ id: "i", identifier: "MARO-2", parent_issue_id: "root", stage: 1, status: "in_progress" });
    const review = issue({ id: "r", identifier: "MARO-3", parent_issue_id: "root", stage: 2, status: "backlog" });
    const doc = buildWorkflow([root, impl, review]);
    const byId = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
    expect(byId.pMARO1).toMatchObject({ col: 0, issueId: "root", lane: doc.lanes[0]!.id });
    expect(byId.nMARO2).toMatchObject({ col: 1, issueId: "i" });
    expect(byId.nMARO3).toMatchObject({ col: 2, tag: "waiting" });
    expect(doc.lanes[0]!.kind).toBe("active");
    expect(doc.edges.some((e) => e.label === "派工")).toBe(true);
  });

  it("folds closed chains into two endpoints", () => {
    const root = issue({
      id: "done-root",
      identifier: "MARO-10",
      status: "done",
      last_activity_at: "2026-09-20T00:00:00Z",
    });
    const child = issue({
      id: "done-child",
      identifier: "MARO-11",
      parent_issue_id: "done-root",
      stage: 1,
      status: "done",
    });
    const doc = buildWorkflow([root, child], { recentClosed: 4, maxNodes: 40 });
    expect(doc.nodes.some((n) => n.id === "pMARO10" && n.col === 0)).toBe(true);
    expect(doc.nodes.some((n) => n.id === "foldMARO10" && n.col === 5 && n.tag === "done")).toBe(true);
    expect(doc.edges.some((e) => e.label === "折叠")).toBe(true);
  });

  it("folds older closed chains into the history lane past recentClosed", () => {
    const issues: MappingIssue[] = [];
    for (let i = 0; i < 6; i += 1) {
      issues.push(issue({
        id: `c${i}`,
        identifier: `MARO-${100 + i}`,
        status: "done",
        last_activity_at: `2026-09-0${i + 1}T00:00:00Z`,
      }));
    }
    const doc = buildWorkflow(issues, { recentClosed: 2, maxNodes: 40 });
    expect(doc.stats.scale?.closedShown).toBe(2);
    expect(doc.stats.scale?.closedHistory).toBe(4);
    expect(doc.nodes.some((n) => n.id === "histClosed")).toBe(true);
  });

  it("folds waiting chains that exceed maxNodes", () => {
    const issues: MappingIssue[] = [];
    for (let i = 0; i < 8; i += 1) {
      issues.push(issue({
        id: `w${i}`,
        identifier: `MARO-${200 + i}`,
        status: "todo",
        last_activity_at: `2026-09-1${i}T00:00:00Z`,
      }));
    }
    const doc = buildWorkflow(issues, { recentClosed: 0, maxNodes: 3 });
    expect(doc.stats.scale?.waitingFolded).toBeGreaterThan(0);
    expect(doc.nodes.some((n) => n.id === "waitFoldStart" && n.tag === "waiting")).toBe(true);
  });

  it("puts pending-decision issues on the exception lane", () => {
    const root = issue({ id: "root", identifier: "MARO-1", status: "in_review" });
    const child = issue({
      id: "p",
      identifier: "MARO-9",
      parent_issue_id: "root",
      stage: 2,
      status: "blocked",
      labels: [{ name: "pending-decision" }],
      title: "待决策子任务",
    });
    const doc = buildWorkflow([root, child]);
    expect(doc.lanes.some((l) => l.id === "lexc")).toBe(true);
    expect(doc.nodes.some((n) => n.id === "xMARO9" && n.tag === "待决策")).toBe(true);
  });
});
