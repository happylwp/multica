import { describe, expect, it } from "vitest";
import {
  LANE_ORIGIN_Y,
  columnX,
  nodePosition,
  phasePosition,
  toFlowGraph,
  type OrchestrationNodeData,
} from "./layout";
import { buildWorkflow } from "./workflow";
import type { OrchestrationIssue } from "./types";

function issue(id: string, extra: Partial<OrchestrationIssue> = {}): OrchestrationIssue {
  return {
    id,
    identifier: `MARO-${id}`,
    title: id,
    status: extra.status ?? "in_progress",
    ...extra,
  };
}

describe("toFlowGraph", () => {
  it("places columns left-to-right and emits one lane node per swimlane", () => {
    const graph = buildWorkflow([
      issue("p"),
      issue("c", { parent_issue_id: "p", stage: 1, status: "todo" }),
    ]);
    const flow = toFlowGraph(graph);
    const laneNodes = flow.nodes.filter((n) => n.type === "orchestrationLane");
    expect(laneNodes).toHaveLength(graph.lanes.length);
    const col0 = flow.nodes.find((n) => n.id.startsWith("p"));
    const col1 = flow.nodes.find((n) => n.id.startsWith("n"));
    expect(col0 && col1).toBeTruthy();
    expect((col1?.position.x ?? 0) > (col0?.position.x ?? 0)).toBe(true);
  });

  it("places phase headers on the same canvas x as their column nodes", () => {
    const graph = buildWorkflow([
      issue("p"),
      issue("c", { parent_issue_id: "p", stage: 1, status: "todo" }),
      issue("r", { parent_issue_id: "p", stage: 2, status: "backlog" }),
    ]);
    const flow = toFlowGraph(graph);
    const phases = flow.nodes.filter((n) => n.type === "orchestrationPhase");
    expect(phases).toHaveLength(6);
    for (const col of [0, 1, 2, 4] as const) {
      const issueNode = flow.nodes.find(
        (n) =>
          n.type === "orchestration" &&
          (n.data as OrchestrationNodeData).col === col,
      );
      const phase = flow.nodes.find((n) => n.id === `phase:ph${col}`);
      expect(phase?.position).toEqual(phasePosition(col));
      if (issueNode) {
        expect(phase?.position.x).toBe(issueNode.position.x);
        expect(phase?.position.x).toBe(columnX(col));
      }
    }
    expect(phasePosition(0).y).toBeLessThan(LANE_ORIGIN_Y);
  });

  it("keeps yOffset stacking for same-lane same-col nodes", () => {
    const a = { id: "a", lane: "l", col: 1, type: "backend", label: "A", sublabel: "", tag: "todo", width: 110, yOffset: -80 };
    const b = { id: "b", lane: "l", col: 1, type: "backend", label: "B", sublabel: "", tag: "todo", width: 110, yOffset: 80 };
    expect(nodePosition(a, 0).y).toBeLessThan(nodePosition(b, 0).y);
  });
});
