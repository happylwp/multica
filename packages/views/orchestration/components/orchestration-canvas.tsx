"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";
import { COL_WIDTH, GRAPH_PAD_X, laneTopForIndex, layoutWorkflow } from "../map/layout";
import { matchesStatusFilter } from "../map/tag";
import type { WorkflowDoc } from "../map/types";
import { OrchestrationNode, type OrchestrationNodeData } from "./orchestration-node";
import type { StatusFilter } from "./orchestration-toolbar";

const NODE_TYPES = {
  orchestration: OrchestrationNode,
  chartLabel: ChartLabelNode,
};

function ChartLabelNode({ data }: { data: { label: string } }) {
  return (
    <div className="pointer-events-none max-w-[160px] truncate text-micro text-muted-foreground">
      {data.label}
    </div>
  );
}

function edgeStroke(variant?: string): string {
  if (variant === "security") return "var(--color-rose-500, #f43f5e)";
  if (variant === "dashed") return "var(--color-muted-foreground)";
  return "var(--color-foreground)";
}

function toFlow(
  doc: WorkflowDoc,
  focusActive: boolean,
  statusFilter: StatusFilter,
): { nodes: Node[]; edges: Edge[] } {
  const positions = layoutWorkflow(doc);
  const visibleIds = new Set<string>();
  const nodes: Node[] = [];

  doc.phases.forEach((phase) => {
    nodes.push({
      id: phase.id,
      type: "chartLabel",
      position: { x: GRAPH_PAD_X + phase.fromCol * COL_WIDTH, y: 8 },
      data: { label: phase.label },
      selectable: false,
      draggable: false,
    });
  });
  doc.lanes.forEach((lane, index) => {
    nodes.push({
      id: `lane-${lane.id}`,
      type: "chartLabel",
      position: { x: 0, y: laneTopForIndex(index) },
      data: { label: lane.label },
      selectable: false,
      draggable: false,
    });
  });

  for (const n of doc.nodes) {
    const pos = positions.get(n.id) ?? { x: n.col * 196, y: 0 };
    const lane = doc.lanes.find((l) => l.id === n.lane);
    const dimmed = focusActive && lane?.kind !== "active" && lane?.kind !== undefined && lane.kind !== "meta";
    if (!matchesStatusFilter(statusFilter, n.tag, n.status)) continue;
    visibleIds.add(n.id);
    nodes.push({
      id: n.id,
      type: "orchestration",
      position: pos,
      data: {
        label: n.label,
        sublabel: n.sublabel,
        tag: n.tag,
        issueId: n.issueId,
        status: n.status,
        dimmed,
      },
      style: { width: n.width },
    });
  }

  const edges: Edge[] = doc.edges
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      animated: e.variant === "emphasis",
      style: {
        stroke: edgeStroke(e.variant),
        strokeDasharray: e.variant === "dashed" ? "4 4" : undefined,
      },
    }));

  return { nodes, edges };
}

function CanvasInner({
  doc,
  focusActive,
  statusFilter,
}: {
  doc: WorkflowDoc;
  focusActive: boolean;
  statusFilter: StatusFilter;
}) {
  const { push } = useNavigation();
  const paths = useWorkspacePaths();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  const { nodes, edges } = useMemo(
    () => toFlow(doc, focusActive, statusFilter),
    [doc, focusActive, statusFilter],
  );

  if (!ready) return <div className="h-full min-h-[320px]" />;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.15}
      maxZoom={1.6}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => {
        const issueId = (node.data as OrchestrationNodeData).issueId;
        if (issueId) push(paths.issueDetail(issueId));
      }}
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}

export function OrchestrationCanvas(props: {
  doc: WorkflowDoc;
  focusActive: boolean;
  statusFilter: StatusFilter;
}) {
  return (
    <div className="h-full min-h-0 w-full">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
