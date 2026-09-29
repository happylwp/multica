import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type {
  OrchestrationLaneData,
  OrchestrationNodeData,
  OrchestrationPhaseData,
} from "../map/layout";
import { tagTone } from "./tag-style";

export const OrchestrationIssueNode = memo(function OrchestrationIssueNode({
  data,
}: NodeProps<Node<OrchestrationNodeData>>) {
  return (
    <div
      className={cn(
        "h-[68px] w-[168px] rounded-md border bg-card px-2.5 py-1.5 shadow-sm ring-1 ring-black/5",
        data.interactive && "cursor-pointer hover:border-brand/50",
        data.laneKind === "closed" && "opacity-70",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !bg-muted-foreground/50" />
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-caption font-medium">{data.label}</span>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1 py-px text-[10px] leading-4 ring-1",
            tagTone(data.tag),
          )}
        >
          {data.tag}
        </span>
      </div>
      <p className="mt-1 truncate text-caption text-muted-foreground">{data.sublabel}</p>
      <Handle type="source" position={Position.Right} className="!size-1.5 !bg-muted-foreground/50" />
    </div>
  );
});

export const OrchestrationLaneNode = memo(function OrchestrationLaneNode({
  data,
}: NodeProps<Node<OrchestrationLaneData>>) {
  return (
    <div className="flex h-[68px] w-[168px] items-center">
      <p className="line-clamp-2 text-caption font-medium text-muted-foreground">{data.label}</p>
    </div>
  );
});

export const OrchestrationPhaseNode = memo(function OrchestrationPhaseNode({
  data,
}: NodeProps<Node<OrchestrationPhaseData>>) {
  const { t } = useT("layout");
  const labels = {
    ph0: t(($) => $.orchestration.phase_ph0),
    ph1: t(($) => $.orchestration.phase_ph1),
    ph2: t(($) => $.orchestration.phase_ph2),
    ph3: t(($) => $.orchestration.phase_ph3),
    ph4: t(($) => $.orchestration.phase_ph4),
    ph5: t(($) => $.orchestration.phase_ph5),
  };
  return (
    <div className="pointer-events-none flex h-8 w-[168px] items-center justify-center text-caption font-medium text-muted-foreground">
      {labels[data.phaseId as keyof typeof labels] ?? data.phaseId}
    </div>
  );
});
