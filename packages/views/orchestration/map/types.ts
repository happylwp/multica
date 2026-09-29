export interface MappingIssue {
  id: string;
  identifier?: string;
  title?: string;
  status?: string;
  stage?: number | null;
  parent_issue_id?: string | null;
  labels?: Array<string | { name?: string }>;
  number?: number;
  last_activity_at?: string | null;
  updated_at?: string;
  created_at?: string;
}

export interface IssueClass {
  stage: number;
  pending: boolean;
  rework: boolean;
  waitingOnPrior: boolean;
  trueBlocked: boolean;
}

export type ChainKind = "active" | "waiting" | "closed";

export interface IssueChain {
  id: string;
  root: MappingIssue | null;
  children: MappingIssue[];
  standalone: boolean;
  kind: ChainKind;
  activity: number;
}

export interface WorkflowLane {
  id: string;
  label: string;
  variant?: string;
  kind?: "active" | "waiting" | "closed" | "meta";
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
  status?: string;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  variant?: string;
  role?: string;
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
  closedShown: number;
  closedHistory: number;
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

export interface WorkflowOpts {
  recentClosed: number;
  maxNodes: number;
  quality?: "standard" | "showcase";
}

export interface WorkflowDoc {
  schema_version: 2;
  diagram_type: "workflow";
  lanes: WorkflowLane[];
  phases: WorkflowPhase[];
  mainPath?: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  stats: WorkflowStats;
}

export const PAGE_SIZE = 100;
export const OFFSET_CAP = 10_000;
export const NODE_WIDTH = 110;
export const SUBLABEL_MAX_UNITS = 18;
export const LANE_LABEL_MAX_UNITS = 22;
export const Y_STACK = 80;

export const ACTIVE = new Set(["in_progress", "in_review", "blocked"]);
export const CLOSED = new Set(["done", "cancelled"]);
export const WAITING_STATUSES = new Set(["backlog", "todo", "blocked"]);

export const STAGE_LABELS: Record<number, string> = {
  1: "implementation",
  2: "review",
  3: "test",
  4: "release",
};

export const STAGE_COL: Record<number, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
};

export const STAGE_TYPE: Record<number, string> = {
  0: "external",
  1: "backend",
  2: "security",
  3: "messagebus",
  4: "cloud",
  5: "cloud",
};

export const DEFAULT_WORKFLOW_OPTS: WorkflowOpts = {
  recentClosed: 4,
  maxNodes: 240,
};

export const PHASES: WorkflowPhase[] = [
  { id: "ph0", label: "入口", fromCol: 0, toCol: 0 },
  { id: "ph1", label: "实现", fromCol: 1, toCol: 1, variant: "emphasis" },
  { id: "ph2", label: "审查", fromCol: 2, toCol: 2 },
  { id: "ph3", label: "测试", fromCol: 3, toCol: 3 },
  { id: "ph4", label: "发布", fromCol: 4, toCol: 4 },
  { id: "ph5", label: "终验", fromCol: 5, toCol: 5, variant: "dashed" },
];
