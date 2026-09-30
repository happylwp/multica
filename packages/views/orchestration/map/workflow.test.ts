import { describe, expect, it } from "vitest";
import { buildWorkflow } from "./workflow";
import type { OrchestrationIssue } from "./types";

function issue(
  partial: Partial<OrchestrationIssue> & Pick<OrchestrationIssue, "id" | "identifier">,
): OrchestrationIssue {
  return {
    title: partial.title ?? partial.identifier,
    status: partial.status ?? "todo",
    updated_at: partial.updated_at ?? "2026-09-01T00:00:00Z",
    ...partial,
  };
}

describe("buildWorkflow", () => {
  it("puts descendants of one root on a single lane and zips adjacent stages", () => {
    const root = issue({ id: "p", identifier: "MARO-1", title: "父任务", status: "in_progress" });
    const impl = issue({ id: "c1", identifier: "MARO-2", parent_issue_id: "p", stage: 1, status: "in_progress" });
    const review = issue({ id: "c2", identifier: "MARO-3", parent_issue_id: "p", stage: 2, status: "backlog" });
    const graph = buildWorkflow([root, impl, review]);
    const issueNodes = graph.nodes.filter((n) => n.issueId);
    expect(new Set(issueNodes.map((n) => n.lane)).size).toBe(1);
    expect(issueNodes.find((n) => n.issueId === "p")?.col).toBe(0);
    expect(issueNodes.find((n) => n.issueId === "c1")?.col).toBe(1);
    expect(issueNodes.find((n) => n.issueId === "c2")?.col).toBe(2);
    expect(issueNodes.find((n) => n.issueId === "c2")?.tag).toBe("waiting");
    expect(graph.edges.some((e) => e.from.startsWith("p") && e.to.startsWith("n"))).toBe(true);
  });

  it("gives standalone issues their own lane and orphans a missing parent", () => {
    const alone = issue({ id: "s", identifier: "MARO-9", status: "todo" });
    const orphan = issue({ id: "o", identifier: "MARO-8", parent_issue_id: "missing", status: "todo" });
    const graph = buildWorkflow([alone, orphan]);
    expect(graph.lanes.length).toBeGreaterThanOrEqual(2);
    expect(graph.nodes.some((n) => n.issueId === "s")).toBe(true);
    expect(graph.nodes.some((n) => n.issueId === "o")).toBe(true);
  });

  it("expands active chains and hides fully closed ones from the canvas", () => {
    const activeRoot = issue({ id: "a", identifier: "MARO-10", status: "in_progress", last_activity_at: "2026-09-20T00:00:00Z" });
    const closedRoot = issue({ id: "d", identifier: "MARO-11", status: "done", last_activity_at: "2026-09-10T00:00:00Z" });
    const closedChild = issue({
      id: "d1",
      identifier: "MARO-12",
      parent_issue_id: "d",
      stage: 1,
      status: "done",
      last_activity_at: "2026-09-10T00:00:00Z",
    });
    const graph = buildWorkflow([activeRoot, closedRoot, closedChild]);
    expect(graph.stats.scale?.activeExpanded).toBe(1);
    expect(graph.stats.scale?.closedHidden).toBe(1);
    expect(graph.lanes.find((l) => l.kind === "closed")).toBeUndefined();
    expect(graph.nodes.some((n) => n.issueId === "d" || n.issueId === "d1")).toBe(false);
  });

  it("folds overflow waiting chains into one 等待链折叠 lane", () => {
    const issues: OrchestrationIssue[] = [];
    for (let i = 0; i < 6; i += 1) {
      issues.push(issue({
        id: `w${i}`,
        identifier: `MARO-${20 + i}`,
        status: "backlog",
        last_activity_at: `2026-09-0${i + 1}T00:00:00Z`,
      }));
    }
    const graph = buildWorkflow(issues, { maxNodes: 3 });
    expect(graph.stats.scale?.waitingFolded).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.id === "waitFoldStart")).toBe(true);
  });

  it("renders an empty workspace placeholder", () => {
    const graph = buildWorkflow([]);
    expect(graph.nodes[0]?.id).toBe("empty");
    expect(graph.lanes[0]?.id).toBe("lempty");
  });

  it("surfaces pending-decision on the exception lane", () => {
    const root = issue({ id: "p", identifier: "MARO-30", status: "in_progress" });
    const pending = issue({
      id: "x",
      identifier: "MARO-31",
      parent_issue_id: "p",
      stage: 2,
      status: "blocked",
      labels: ["pending-decision"],
    });
    const graph = buildWorkflow([root, pending]);
    expect(graph.lanes.some((l) => l.id === "lexc")).toBe(true);
    expect(graph.nodes.some((n) => n.tag === "待决策" && n.lane === "lexc")).toBe(true);
  });
});
