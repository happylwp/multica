import dagre, { Graph } from "@dagrejs/dagre";
import type { WorkflowDoc, WorkflowNode } from "./types";

export const COL_WIDTH = 196;
export const LANE_GAP = 148;
export const NODE_HEIGHT = 64;
export const GRAPH_PAD_X = 28;
export const GRAPH_PAD_Y = 48;

export interface LaidOutPosition {
  x: number;
  y: number;
}

export function laneTopForIndex(laneIndex: number): number {
  return laneIndex * LANE_GAP + GRAPH_PAD_Y;
}

/**
 * Swimlane layout: X is snapped to mapping `col` so phases stay aligned
 * across lanes; Y is computed by dagre within each lane, then offset by
 * lane index and the mapping `yOffset` stack.
 */
export function layoutWorkflow(doc: WorkflowDoc): Map<string, LaidOutPosition> {
  const positions = new Map<string, LaidOutPosition>();

  doc.lanes.forEach((lane, laneIndex) => {
    const laneNodes = doc.nodes.filter((n) => n.lane === lane.id);
    if (!laneNodes.length) return;

    const g = new Graph();
    g.setGraph({
      rankdir: "LR",
      nodesep: 18,
      ranksep: 72,
      marginx: 0,
      marginy: 8,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of laneNodes) {
      g.setNode(n.id, { width: n.width || 110, height: NODE_HEIGHT });
    }
    for (const e of doc.edges) {
      if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
    }
    dagre.layout(g);

    const laneTop = laneTopForIndex(laneIndex);
    for (const n of laneNodes) {
      const laid = g.node(n.id) as { y?: number } | undefined;
      positions.set(n.id, positionFor(n, laneTop, laid?.y));
    }
  });

  return positions;
}

export function positionFor(
  node: WorkflowNode,
  laneTop: number,
  dagreY?: number,
): LaidOutPosition {
  return {
    x: GRAPH_PAD_X + node.col * COL_WIDTH,
    y: laneTop + (dagreY ?? NODE_HEIGHT / 2) + (node.yOffset ?? 0) - NODE_HEIGHT / 2,
  };
}

export function graphBounds(positions: Map<string, LaidOutPosition>): {
  width: number;
  height: number;
} {
  let maxX = 0;
  let maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + NODE_WIDTH_FALLBACK);
    maxY = Math.max(maxY, p.y + NODE_HEIGHT);
  }
  return { width: maxX + GRAPH_PAD_X, height: maxY + GRAPH_PAD_Y };
}

const NODE_WIDTH_FALLBACK = 110;
