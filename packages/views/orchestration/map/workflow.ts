import { inferStage, classifyIssue, displayTag, activityTs, sortIssues, issueKey, nodeId, ACTIVE, CLOSED, STAGE_COL, STAGE_TYPE } from "./classify";
import { truncateUnits } from "./text";
import type {
  BuildWorkflowOptions,
  ChainKind,
  IssueClass,
  LaneKind,
  OrchestrationIssue,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowLane,
  WorkflowNode,
  WorkflowStats,
} from "./types";
import {
  DEFAULT_MAX_NODES,
  DEFAULT_RECENT_CLOSED,
  LANE_LABEL_MAX_UNITS,
  NODE_WIDTH,
  SUBLABEL_MAX_UNITS,
  WORKFLOW_PHASES,
  Y_STACK,
} from "./types";

interface IssueIndex {
  byId: Map<string, OrchestrationIssue>;
  childrenOf: Map<string, OrchestrationIssue[]>;
}

interface Chain {
  id: string;
  root: OrchestrationIssue | null;
  children: OrchestrationIssue[];
  standalone: boolean;
  kind: ChainKind;
  activity: number;
}

function buildIndex(issues: OrchestrationIssue[]): IssueIndex {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenOf = new Map<string, OrchestrationIssue[]>();
  for (const issue of issues) {
    const pid = issue.parent_issue_id;
    if (!pid) continue;
    const bucket = childrenOf.get(pid);
    if (bucket) bucket.push(issue);
    else childrenOf.set(pid, [issue]);
  }
  for (const [pid, kids] of childrenOf) {
    childrenOf.set(pid, sortIssues(kids));
  }
  return { byId, childrenOf };
}

function chainKind(root: OrchestrationIssue | null, children: OrchestrationIssue[]): ChainKind {
  const members = root ? [root, ...children] : children;
  const statuses = new Set(members.map((m) => m.status));
  if ([...statuses].some((s) => ACTIVE.has(s))) return "active";
  if ([...statuses].every((s) => CLOSED.has(s))) return "closed";
  return "waiting";
}

function chainActivity(root: OrchestrationIssue | null, children: OrchestrationIssue[]): number {
  return Math.max(root ? activityTs(root) : 0, ...children.map(activityTs), 0);
}

function chainMemberCount(chain: Chain): number {
  return (chain.root ? 1 : 0) + chain.children.length;
}

/** 沿 parent_issue_id 上溯到数据集内顶层；父不在库中则归入该缺失父 id。 */
function walkToTop(
  issue: OrchestrationIssue,
  byId: Map<string, OrchestrationIssue>,
): { root: OrchestrationIssue | null; groupId: string } {
  let cur: OrchestrationIssue | undefined = issue;
  const seen: OrchestrationIssue[] = [];
  const seenSet = new Set<string>();
  while (cur?.parent_issue_id) {
    if (seenSet.has(cur.id)) {
      const ids = seen.map((x) => x.id).sort();
      return { root: byId.get(ids[0] ?? "") || cur, groupId: ids[0] ?? cur.id };
    }
    seen.push(cur);
    seenSet.add(cur.id);
    const parent = byId.get(cur.parent_issue_id);
    if (!parent) return { root: null, groupId: cur.parent_issue_id };
    cur = parent;
  }
  return { root: cur ?? null, groupId: cur?.id ?? issue.id };
}

function buildChains(issues: OrchestrationIssue[], { byId }: IssueIndex): Chain[] {
  const groups = new Map<string, { root: OrchestrationIssue | null; members: OrchestrationIssue[] }>();
  for (const issue of issues) {
    const { root, groupId } = walkToTop(issue, byId);
    if (!groups.has(groupId)) groups.set(groupId, { root, members: [] });
    const g = groups.get(groupId)!;
    if (root && !g.root) g.root = root;
    g.members.push(issue);
  }

  const chains: Chain[] = [];
  for (const [groupId, g] of groups) {
    const root = g.root;
    const children = sortIssues(g.members.filter((m) => !root || m.id !== root.id));
    chains.push({
      id: root?.id || groupId,
      root,
      children,
      standalone: Boolean(root) && children.length === 0,
      kind: chainKind(root, children),
      activity: chainActivity(root, children),
    });
  }
  return chains;
}

function selectChains(chains: Chain[], opts: { recentClosed: number }) {
  const active = chains.filter((c) => c.kind === "active").sort((a, b) => b.activity - a.activity);
  const waiting = chains.filter((c) => c.kind === "waiting").sort((a, b) => b.activity - a.activity);
  const closed = chains.filter((c) => c.kind === "closed").sort((a, b) => {
    if (a.standalone !== b.standalone) return a.standalone ? 1 : -1;
    return b.activity - a.activity;
  });
  const keptClosed = closed.slice(0, Math.max(0, opts.recentClosed));
  const foldedClosed = closed.slice(keptClosed.length);
  return { active, waiting, keptClosed, foldedClosed };
}

function stackOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const mid = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => Math.round((i - mid) * Y_STACK));
}

function laneLabelFor(chain: Chain): string {
  const root = chain.root;
  const ident = root?.identifier || "CHAIN";
  const title = truncateUnits(root?.title || "独立任务", 12);
  return truncateUnits(`${ident} ${title}`, LANE_LABEL_MAX_UNITS);
}

function edge(
  id: string,
  from: string,
  to: string,
  label?: string,
  extra: { variant?: string; role?: string } = {},
): WorkflowEdge {
  const e: WorkflowEdge = { id, from, to };
  if (label) e.label = label;
  Object.assign(e, extra);
  return e;
}

function addNode(nodes: WorkflowNode[], rec: WorkflowNode): string {
  nodes.push(rec);
  return rec.id;
}

function assignLaneStacks(nodes: WorkflowNode[]) {
  const groups = new Map<string, WorkflowNode[]>();
  for (const n of nodes) {
    const key = `${n.lane}:${n.col}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(n);
    else groups.set(key, [n]);
  }
  for (const group of groups.values()) {
    const offs = stackOffsets(group.length);
    group.forEach((n, i) => {
      if (offs[i]) n.yOffset = offs[i];
    });
  }
}

interface VisibleRec {
  issue: OrchestrationIssue;
  id: string;
  stage: number;
  cls: IssueClass;
}

function expandFullChain(
  chain: Chain,
  laneId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  laneKind: LaneKind,
): VisibleRec[] {
  const { children } = chain;
  const root = chain.root;
  const visible: VisibleRec[] = [];

  if (root) {
    const cls = classifyIssue(root, children);
    const id = addNode(nodes, {
      id: nodeId("p", root),
      lane: laneId,
      col: 0,
      type: "external",
      label: root.identifier,
      sublabel: truncateUnits(root.title, SUBLABEL_MAX_UNITS),
      tag: displayTag(root, cls),
      width: NODE_WIDTH,
      issueId: root.id,
      laneKind,
    });
    visible.push({ issue: root, id, stage: 0, cls });
  }

  const byStage = new Map<number, VisibleRec[]>();
  for (const child of children) {
    const cls = classifyIssue(child, children);
    const stage = Math.max(1, cls.stage);
    const col = STAGE_COL[Math.min(stage, 5)] ?? 1;
    const id = addNode(nodes, {
      id: nodeId("n", child),
      lane: laneId,
      col,
      type: STAGE_TYPE[Math.min(stage, 5)] || "backend",
      label: child.identifier,
      sublabel: truncateUnits(child.title, SUBLABEL_MAX_UNITS),
      tag: displayTag(child, cls),
      width: NODE_WIDTH,
      issueId: child.id,
      laneKind,
    });
    const rec = { issue: child, id, stage, cls };
    visible.push(rec);
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(rec);
    else byStage.set(stage, [rec]);
  }

  const stages = [...byStage.keys()].sort((a, b) => a - b);
  if (root) {
    const first = byStage.get(stages[0] ?? -1) || [];
    first.forEach((rec, idx) => {
      edges.push(edge(
        `e_${laneId}_p_${idx}`,
        nodeId("p", root),
        rec.id,
        idx === 0 ? "派工" : "并行",
        idx === 0 ? { variant: "emphasis" } : { variant: "dashed", role: "branch" },
      ));
    });
  }

  for (let i = 0; i < stages.length - 1; i += 1) {
    const fromStage = stages[i];
    const toStage = stages[i + 1];
    if (fromStage === undefined || toStage === undefined) continue;
    const froms = byStage.get(fromStage);
    const tos = byStage.get(toStage);
    if (!froms || !tos) continue;
    const n = Math.max(froms.length, tos.length);
    for (let k = 0; k < n; k += 1) {
      const from = froms[Math.min(k, froms.length - 1)];
      const to = tos[Math.min(k, tos.length - 1)];
      if (!from || !to) continue;
      const reworkHop = from.cls.rework || to.cls.rework || from.issue.status === "cancelled";
      edges.push(edge(
        `e_${laneId}_${fromStage}_${toStage}_${k}`,
        from.id,
        to.id,
        reworkHop ? "返工接力" : "接力",
        reworkHop ? { variant: "security", role: "error" } : { variant: "emphasis" },
      ));
    }
  }

  return visible;
}

function foldChain(
  chain: Chain,
  laneId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  tag: string,
  laneKind: LaneKind,
): { visible: VisibleRec[]; anchorId: string | null } {
  const root = chain.root;
  const kids = chain.children;
  const closedN = kids.filter((c) => CLOSED.has(c.status)).length;
  const labelIssue = root || kids[0];
  if (!labelIssue) return { visible: [], anchorId: null };

  const startId = addNode(nodes, {
    id: nodeId("p", labelIssue),
    lane: laneId,
    col: 0,
    type: "external",
    label: labelIssue.identifier,
    sublabel: truncateUnits(labelIssue.title, SUBLABEL_MAX_UNITS),
    tag: root?.status || "done",
    width: NODE_WIDTH,
    issueId: labelIssue.id,
    laneKind,
  });
  const endId = addNode(nodes, {
    id: `fold${issueKey(labelIssue)}`,
    lane: laneId,
    col: 5,
    type: "cloud",
    label: chain.standalone ? "独立任务" : `子任务${kids.length}`,
    sublabel: truncateUnits(chain.standalone ? "已关闭" : `${closedN} 已关闭`, SUBLABEL_MAX_UNITS),
    tag,
    width: NODE_WIDTH,
    laneKind,
  });
  edges.push(edge(`e_${laneId}_fold`, startId, endId, "折叠", { variant: "dashed" }));
  return {
    visible: [{ issue: labelIssue, id: startId, stage: 0, cls: classifyIssue(labelIssue, kids) }],
    anchorId: startId,
  };
}

function collectExceptionEvents(chains: Chain[], cap = 6) {
  const events: Array<{
    issue: OrchestrationIssue;
    cls: IssueClass;
    chain: Chain;
    activity: number;
  }> = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    const members = [...(chain.root ? [chain.root] : []), ...chain.children];
    for (const issue of members) {
      const cls = classifyIssue(issue, chain.children);
      if (!cls.pending && !cls.rework) continue;
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      events.push({ issue, cls, chain, activity: activityTs(issue) });
    }
  }
  events.sort((a, b) => {
    const open = (x: typeof a) => (CLOSED.has(x.issue.status) ? 1 : 0);
    if (open(a) !== open(b)) return open(a) - open(b);
    return b.activity - a.activity;
  });
  return events.slice(0, cap);
}

export function summarize(issues: OrchestrationIssue[], index?: IssueIndex): WorkflowStats {
  const { childrenOf, byId } = index || buildIndex(issues);
  let waiting = 0;
  let trueBlocked = 0;
  let pending = 0;
  let rework = 0;
  const byStatus: Record<string, number> = {};
  for (const issue of issues) {
    byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
    const siblings = issue.parent_issue_id
      ? (childrenOf.get(issue.parent_issue_id) || [])
      : (childrenOf.get(issue.id) || []);
    const cls = classifyIssue(issue, siblings);
    if (cls.waitingOnPrior) waiting += 1;
    if (cls.trueBlocked) trueBlocked += 1;
    if (cls.pending) pending += 1;
    if (cls.rework) rework += 1;
    void byId;
  }
  return { waiting, trueBlocked, pending, rework, byStatus, total: issues.length };
}

function pickMainPath(chain: Chain | undefined, nodes: WorkflowNode[]): string[] {
  if (!chain) return [];
  const ids: string[] = [];
  if (chain.root) {
    const id = nodeId("p", chain.root);
    if (nodes.some((n) => n.id === id)) ids.push(id);
  }
  const byStage = new Map<number, OrchestrationIssue>();
  for (const child of chain.children) {
    const s = inferStage(child);
    if (!byStage.has(s)) byStage.set(s, child);
  }
  for (const s of [...byStage.keys()].sort((a, b) => a - b)) {
    const issue = byStage.get(s);
    if (!issue) continue;
    const id = nodeId("n", issue);
    if (nodes.some((n) => n.id === id)) ids.push(id);
  }
  return ids;
}

export function buildWorkflow(
  issues: OrchestrationIssue[],
  opts: BuildWorkflowOptions = {},
): WorkflowGraph {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const recentClosed = opts.recentClosed ?? DEFAULT_RECENT_CLOSED;
  const index = buildIndex(issues);
  const chains = buildChains(issues, index);
  const picked = selectChains(chains, { recentClosed });

  const lanes: WorkflowLane[] = [];
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const visible: VisibleRec[] = [];
  const anchors = new Map<string, string>();

  const pushLane = (id: string, label: string, kind: LaneKind, variant?: string) => {
    const lane: WorkflowLane = { id, label, kind };
    if (variant) lane.variant = variant;
    lanes.push(lane);
  };

  const rememberAnchor = (chain: Chain, nodeIdVal?: string | null) => {
    if (chain?.id && nodeIdVal) anchors.set(chain.id, nodeIdVal);
  };

  for (const chain of picked.active) {
    const laneId = `ln${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "active");
    const vis = expandFullChain(chain, laneId, nodes, edges, "active");
    visible.push(...vis);
    rememberAnchor(chain, vis[0]?.id);
  }

  const waitingExpanded: Chain[] = [];
  const waitingOverflow: Chain[] = [];
  for (const chain of picked.waiting) {
    const cost = chainMemberCount(chain);
    if (nodes.length + cost > maxNodes) {
      waitingOverflow.push(chain);
      continue;
    }
    const laneId = `lw${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "waiting");
    const vis = expandFullChain(chain, laneId, nodes, edges, "waiting");
    visible.push(...vis);
    rememberAnchor(chain, vis[0]?.id);
    waitingExpanded.push(chain);
  }

  if (waitingOverflow.length) {
    pushLane("lwfold", "等待链折叠", "meta");
    const waitCount = waitingOverflow.reduce((n, c) => n + chainMemberCount(c), 0);
    addNode(nodes, {
      id: "waitFoldStart",
      lane: "lwfold",
      col: 0,
      type: "external",
      label: `${waitingOverflow.length}条链`,
      sublabel: truncateUnits("后置规划折叠", SUBLABEL_MAX_UNITS),
      tag: "waiting",
      width: NODE_WIDTH,
      laneKind: "meta",
    });
    addNode(nodes, {
      id: "waitFoldEnd",
      lane: "lwfold",
      col: 5,
      type: "cloud",
      label: "等待折叠",
      sublabel: truncateUnits(`${waitCount} 任务排队`, SUBLABEL_MAX_UNITS),
      tag: "folded",
      width: NODE_WIDTH,
      laneKind: "meta",
    });
    edges.push(edge("e_waitfold", "waitFoldStart", "waitFoldEnd", "折叠", { variant: "dashed" }));
    for (const chain of waitingOverflow) rememberAnchor(chain, "waitFoldStart");
  }

  let closedShown = 0;
  const closedOverflow: Chain[] = [];
  for (const chain of picked.keptClosed) {
    if (nodes.length + 2 > maxNodes) {
      closedOverflow.push(chain);
      continue;
    }
    const laneId = `lc${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "closed");
    const folded = foldChain(chain, laneId, nodes, edges, "done", "closed");
    visible.push(...folded.visible);
    rememberAnchor(chain, folded.anchorId);
    closedShown += 1;
  }

  const rest = [...picked.foldedClosed, ...closedOverflow];
  if (rest.length) {
    const issueCount = rest.reduce((n, c) => n + chainMemberCount(c), 0);
    pushLane("lhist", "历史已完成", "meta");
    const dummy = rest[0]!.root || rest[0]!.children[0];
    addNode(nodes, {
      id: "histClosed",
      lane: "lhist",
      col: 5,
      type: "cloud",
      label: `${rest.length}条链`,
      sublabel: truncateUnits(`${issueCount} 任务已关闭`, SUBLABEL_MAX_UNITS),
      tag: "folded",
      width: NODE_WIDTH,
      laneKind: "meta",
    });
    if (dummy) {
      addNode(nodes, {
        id: "histStart",
        lane: "lhist",
        col: 0,
        type: "external",
        label: "更早任务",
        sublabel: truncateUnits("活跃链优先截断", SUBLABEL_MAX_UNITS),
        tag: "scale",
        width: NODE_WIDTH,
        laneKind: "meta",
      });
      edges.push(edge("e_hist", "histStart", "histClosed", "折叠", { variant: "dashed" }));
    }
    for (const chain of rest) rememberAnchor(chain, "histClosed");
  }

  const events = collectExceptionEvents(chains);
  if (events.length) {
    pushLane("lexc", "异常·返工待决策", "meta", "exception");
    const nodeIds = new Set(nodes.map((n) => n.id));
    events.forEach((ev, idx) => {
      const col = STAGE_COL[Math.min(Math.max(ev.cls.stage, 0), 5)] ?? 2;
      const id = nodeId("x", ev.issue);
      addNode(nodes, {
        id,
        lane: "lexc",
        col,
        type: "security",
        label: ev.issue.identifier,
        sublabel: truncateUnits(ev.cls.pending ? "待决策" : "返工事件", SUBLABEL_MAX_UNITS),
        tag: ev.cls.pending ? "待决策" : "返工",
        width: NODE_WIDTH,
        issueId: ev.issue.id,
        laneKind: "meta",
      });
      const origin = visible.find((v) => v.issue.id === ev.issue.id);
      const anchored = ev.chain.id ? anchors.get(ev.chain.id) : undefined;
      let fromId = origin?.id
        || (anchored && nodeIds.has(anchored) ? anchored : null)
        || (nodeIds.has("histClosed") ? "histClosed" : null)
        || (nodeIds.has("waitFoldStart") ? "waitFoldStart" : null);
      if (!fromId) {
        if (!nodeIds.has("xHist")) {
          addNode(nodes, {
            id: "xHist",
            lane: "lexc",
            col: 0,
            type: "external",
            label: "历史折叠",
            sublabel: truncateUnits("异常锚点", SUBLABEL_MAX_UNITS),
            tag: "folded",
            width: NODE_WIDTH,
            laneKind: "meta",
          });
          nodeIds.add("xHist");
        }
        fromId = "xHist";
      }
      edges.push(edge(
        `e_x_${idx}`,
        fromId,
        id,
        ev.cls.pending ? "升级" : "记录",
        origin ? { variant: "security", role: "error" } : { variant: "dashed", role: "error" },
      ));
    });
  }

  if (!lanes.length || !nodes.length) {
    pushLane("lempty", "空工作区", "meta");
    addNode(nodes, {
      id: "empty",
      lane: "lempty",
      col: 0,
      type: "external",
      label: "无任务",
      sublabel: "工作区为空",
      tag: "empty",
      width: NODE_WIDTH,
      laneKind: "meta",
    });
  }

  assignLaneStacks(nodes);

  const stats = summarize(issues, index);
  stats.scale = {
    maxNodes,
    activeExpanded: picked.active.length,
    waitingExpanded: waitingExpanded.length,
    waitingFolded: waitingOverflow.length,
    closedShown,
    closedHistory: rest.length,
  };

  return {
    lanes,
    phases: WORKFLOW_PHASES,
    nodes,
    edges,
    mainPath: pickMainPath(picked.active[0] || picked.waiting[0], nodes),
    stats,
  };
}
