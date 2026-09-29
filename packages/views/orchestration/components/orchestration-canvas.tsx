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
import { OrchestrationIssueNode, OrchestrationLaneNode } from "./orchestration-node";
import type { FilterTag } from "./tag-style";

const NODE_TYPES = {
  orchestration: OrchestrationIssueNode,
  orchestrationLane: OrchestrationLaneNode,
};

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
  const phaseLabels = {
    ph0: t(($) => $.orchestration.phase_ph0),
    ph1: t(($) => $.orchestration.phase_ph1),
    ph2: t(($) => $.orchestration.phase_ph2),
    ph3: t(($) => $.orchestration.phase_ph3),
    ph4: t(($) => $.orchestration.phase_ph4),
    ph5: t(($) => $.orchestration.phase_ph5),
  };

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
        if (node.type === "orchestrationLane") {
          return visibleLanes.has(node.id.replace(/^lane:/, ""));
        }
        const lane = (node.data as OrchestrationNodeData).lane;
        return visibleLanes.has(lane);
      });
    }
    if (activeFilter) {
      next = next.filter((node) => {
        if (node.type === "orchestrationLane") return true;
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
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex gap-0 pl-[196px] pr-4 pt-2">
        {graph.phases.map((phase) => (
          <div
            key={phase.id}
            className="w-[196px] text-center text-caption font-medium text-muted-foreground"
          >
            {phaseLabels[phase.id as keyof typeof phaseLabels]}
          </div>
        ))}
      </div>
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
