"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import { TAG_TONE_CLASS, tagTone } from "../map/tag";

export interface OrchestrationNodeData extends Record<string, unknown> {
  label: string;
  sublabel: string;
  tag: string;
  issueId?: string;
  status?: string;
  dimmed?: boolean;
}

export function OrchestrationNode({ data, selected }: NodeProps) {
  const node = data as OrchestrationNodeData;
  const tone = tagTone(node.tag, node.status);
  return (
    <div
      className={cn(
        "min-w-[110px] max-w-[140px] rounded-md border px-2 py-1.5 shadow-xs transition-opacity",
        TAG_TONE_CLASS[tone],
        selected && "ring-2 ring-ring",
        node.dimmed && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !bg-border" />
      <p className="truncate font-mono text-micro font-medium">{node.label}</p>
      <p className="truncate text-micro text-muted-foreground">{node.sublabel}</p>
      <p className="mt-0.5 truncate font-mono text-[10px] leading-4 opacity-80">{node.tag}</p>
      <Handle type="source" position={Position.Right} className="!size-1.5 !bg-border" />
    </div>
  );
}
