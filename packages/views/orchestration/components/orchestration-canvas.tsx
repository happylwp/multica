"use client";

import { useCallback, useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../../i18n";
import { useIntentNavigate } from "../../navigation";
import type { WorkflowGraph } from "../map/types";
import { toFlowGraph, type OrchestrationNodeData } from "../map/layout";
import {
  OrchestrationIssueNode,
  OrchestrationLaneNode,
  OrchestrationPhaseNode,
} from "./orchestration-node";
import type { FilterTag } from "./tag-style";

const NODE_TYPES = {
  orchestration: OrchestrationIssueNode,
  orchestrationLane: OrchestrationLaneNode,
  orchestrationPhase: OrchestrationPhaseNode,
};

function isChromeNode(type: string | undefined): boolean {
  return type === "orchestrationLane" || type === "orchestrationPhase";
}

export function OrchestrationCanvas({
  graph,
  focusActive,
  activeFilter,
}: {
  graph: WorkflowGraph;
  focusActive: boolean;
  activeFilter: FilterTag | null;
}) {
  const { t } = useT("layout");
  const paths = useWorkspacePaths();
  const intentNavigate = useIntentNavigate();
  const flow = useMemo(() => toFlowGraph(graph), [graph]);

  const visibleLanes = useMemo(() => {
    if (!focusActive) return null;
    return new Set(
      graph.lanes.filter((lane) => lane.kind === "active" || lane.kind === "meta").map((l) => l.id),
    );
  }, [focusActive, graph.lanes]);

  const { nodes, edges } = useMemo(() => {
    let next = flow.nodes;
    if (visibleLanes) {
      next = next.filter((node) => {
        if (node.type === "orchestrationPhase") return true;
        if (node.type === "orchestrationLane") {
          return visibleLanes.has(node.id.replace(/^lane:/, ""));
        }
        const lane = (node.data as OrchestrationNodeData).lane;
        return visibleLanes.has(lane);
      });
    }
    if (activeFilter) {
      next = next.filter((node) => {
        if (isChromeNode(node.type)) return true;
        return (node.data as OrchestrationNodeData).tag === activeFilter;
      });
    }
    const keep = new Set(next.map((n) => n.id));
    return {
      nodes: next,
      edges: flow.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [flow, visibleLanes, activeFilter]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node: Node) => {
      const issueId = (node.data as OrchestrationNodeData | undefined)?.issueId;
      if (!issueId) return;
      intentNavigate(paths.issueDetail(issueId), "push");
    },
    [intentNavigate, paths],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        aria-label={t(($) => $.orchestration.canvas_label)}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
