export interface OrchestrationIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  stage?: number | null;
  parent_issue_id?: string | null;
  labels?: Array<string | { name?: string | null }>;
  number?: number;
  last_activity_at?: string | null;
  updated_at?: string;
  created_at?: string;
}

export type ChainKind = "active" | "waiting" | "closed";
export type LaneKind = ChainKind | "meta";

export interface IssueClass {
  stage: number;
  pending: boolean;
  rework: boolean;
  waitingOnPrior: boolean;
  trueBlocked: boolean;
}

export interface WorkflowNode {
  id: string;
  lane: string;
  col: number;
  type: string;
  label: string;
  sublabel: string;
  tag: string;
  width: number;
  yOffset?: number;
  issueId?: string;
  laneKind?: LaneKind;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  variant?: string;
  role?: string;
}

export interface WorkflowLane {
  id: string;
  label: string;
  variant?: string;
  kind?: LaneKind;
}

export interface WorkflowPhase {
  id: string;
  label: string;
  fromCol: number;
  toCol: number;
  variant?: string;
}

export interface WorkflowScale {
  maxNodes: number;
  activeExpanded: number;
  waitingExpanded: number;
  waitingFolded: number;
  /** Fully closed chains kept out of the canvas entirely. */
  closedHidden: number;
}

export interface WorkflowStats {
  waiting: number;
  trueBlocked: number;
  pending: number;
  rework: number;
  byStatus: Record<string, number>;
  total: number;
  scale?: WorkflowScale;
}

export interface WorkflowGraph {
  lanes: WorkflowLane[];
  phases: WorkflowPhase[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  mainPath: string[];
  stats: WorkflowStats;
}

export interface BuildWorkflowOptions {
  maxNodes?: number;
}

export const DEFAULT_MAX_NODES = 80;

export const SUBLABEL_MAX_UNITS = 18;
export const LANE_LABEL_MAX_UNITS = 22;
export const NODE_WIDTH = 110;
export const Y_STACK = 80;

export const WORKFLOW_PHASES: WorkflowPhase[] = [
  { id: "ph0", label: "入口", fromCol: 0, toCol: 0 },
  { id: "ph1", label: "实现", fromCol: 1, toCol: 1, variant: "emphasis" },
  { id: "ph2", label: "审查", fromCol: 2, toCol: 2 },
  { id: "ph3", label: "测试", fromCol: 3, toCol: 3 },
  { id: "ph4", label: "发布", fromCol: 4, toCol: 4 },
  { id: "ph5", label: "终验", fromCol: 5, toCol: 5, variant: "dashed" },
];
