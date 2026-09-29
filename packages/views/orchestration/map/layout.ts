import type { Edge, Node } from "@xyflow/react";
import type { LaneKind, WorkflowGraph, WorkflowNode } from "./types";

export const COL_ORIGIN_X = 196;
export const COL_GAP = 196;
export const LANE_ORIGIN_Y = 72;
export const LANE_GAP = 156;

export type OrchestrationNodeData = {
  label: string;
  sublabel: string;
  tag: string;
  issueId?: string;
  laneKind?: LaneKind;
  col: number;
  lane: string;
  interactive: boolean;
};

export type OrchestrationLaneData = {
  label: string;
  kind?: LaneKind;
};

export function nodePosition(node: WorkflowNode, laneIndex: number): { x: number; y: number } {
  return {
    x: COL_ORIGIN_X + node.col * COL_GAP,
    y: LANE_ORIGIN_Y + laneIndex * LANE_GAP + (node.yOffset ?? 0),
  };
}

export function toFlowGraph(graph: WorkflowGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const laneIndex = new Map(graph.lanes.map((lane, i) => [lane.id, i]));
  const nodes: Node[] = graph.lanes.map((lane, i) => ({
    id: `lane:${lane.id}`,
    type: "orchestrationLane",
    position: { x: 8, y: LANE_ORIGIN_Y + i * LANE_GAP },
    data: { label: lane.label, kind: lane.kind },
    draggable: false,
    selectable: false,
    connectable: false,
  }));

  for (const node of graph.nodes) {
    const idx = laneIndex.get(node.lane) ?? 0;
    nodes.push({
      id: node.id,
      type: "orchestration",
      position: nodePosition(node, idx),
      data: {
        label: node.label,
        sublabel: node.sublabel,
        tag: node.tag,
        issueId: node.issueId,
        laneKind: node.laneKind,
        col: node.col,
        lane: node.lane,
        interactive: Boolean(node.issueId),
      },
      draggable: false,
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const main = new Set(graph.mainPath);
  const edges: Edge[] = graph.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      animated: e.variant === "emphasis" && (main.has(e.from) || main.has(e.to)),
      style: {
        stroke:
          e.role === "error"
            ? "var(--destructive)"
            : e.variant === "dashed"
              ? "var(--muted-foreground)"
              : "var(--foreground)",
        strokeDasharray: e.variant === "dashed" ? "6 4" : undefined,
        opacity: 0.55,
      },
    }));

  return { nodes, edges };
}
