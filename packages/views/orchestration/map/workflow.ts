import {
  buildChains,
  buildIndex,
  chainMemberCount,
  classifyIssue,
  displayTag,
  inferStage,
  issueKey,
  nodeId,
  selectChains,
  summarize,
} from "./classify";
import { truncateUnits } from "./text";
import {
  CLOSED,
  DEFAULT_WORKFLOW_OPTS,
  LANE_LABEL_MAX_UNITS,
  NODE_WIDTH,
  PHASES,
  STAGE_COL,
  STAGE_TYPE,
  SUBLABEL_MAX_UNITS,
  Y_STACK,
  type IssueChain,
  type MappingIssue,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowLane,
  type WorkflowNode,
  type WorkflowOpts,
  type WorkflowStats,
} from "./types";

function stackOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const mid = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => Math.round((i - mid) * Y_STACK));
}

function laneLabelFor(chain: IssueChain): string {
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
  extra: Partial<WorkflowEdge> = {},
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
    const group = groups.get(key) ?? [];
    group.push(n);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const offs = stackOffsets(group.length);
    group.forEach((n, i) => {
      if (offs[i]) n.yOffset = offs[i];
    });
  }
}

function expandFullChain(
  chain: IssueChain,
  laneId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
) {
  const { children } = chain;
  const root = chain.root;
  const visible: Array<{
    issue: MappingIssue;
    id: string;
    stage: number;
    cls: ReturnType<typeof classifyIssue>;
  }> = [];

  if (root) {
    const cls = classifyIssue(root, children);
    const id = addNode(nodes, {
      id: nodeId("p", root),
      lane: laneId,
      col: 0,
      type: "external",
      label: root.identifier || root.id,
      sublabel: truncateUnits(root.title, SUBLABEL_MAX_UNITS),
      tag: displayTag(root, cls),
      width: NODE_WIDTH,
      issueId: root.id,
      status: root.status,
    });
    visible.push({ issue: root, id, stage: 0, cls });
  }

  const byStage = new Map<number, typeof visible>();
  for (const child of children) {
    const cls = classifyIssue(child, children);
    const stage = Math.max(1, cls.stage);
    const col = STAGE_COL[Math.min(stage, 5)] ?? 1;
    const id = addNode(nodes, {
      id: nodeId("n", child),
      lane: laneId,
      col,
      type: STAGE_TYPE[Math.min(stage, 5)] || "backend",
      label: child.identifier || child.id,
      sublabel: truncateUnits(child.title, SUBLABEL_MAX_UNITS),
      tag: displayTag(child, cls),
      width: NODE_WIDTH,
      issueId: child.id,
      status: child.status,
    });
    const rec = { issue: child, id, stage, cls };
    visible.push(rec);
    const bucket = byStage.get(stage) ?? [];
    bucket.push(rec);
    byStage.set(stage, bucket);
  }

  const stages = [...byStage.keys()].sort((a, b) => a - b);
  if (root) {
    const first = byStage.get(stages[0]!) || [];
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
    const froms = byStage.get(stages[i]!)!;
    const tos = byStage.get(stages[i + 1]!)!;
    const n = Math.max(froms.length, tos.length);
    for (let k = 0; k < n; k += 1) {
      const from = froms[Math.min(k, froms.length - 1)]!;
      const to = tos[Math.min(k, tos.length - 1)]!;
      const reworkHop = from.cls.rework || to.cls.rework || from.issue.status === "cancelled";
      edges.push(edge(
        `e_${laneId}_${stages[i]}_${stages[i + 1]}_${k}`,
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
  chain: IssueChain,
  laneId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  tag: string,
) {
  const root = chain.root;
  const kids = chain.children;
  const closedN = kids.filter((c) => CLOSED.has(c.status || "")).length;
  const labelIssue = root || kids[0];
  if (!labelIssue) return { visible: [] as ReturnType<typeof expandFullChain>, anchorId: null as string | null };

  const startId = addNode(nodes, {
    id: nodeId("p", labelIssue),
    lane: laneId,
    col: 0,
    type: "external",
    label: labelIssue.identifier || labelIssue.id,
    sublabel: truncateUnits(labelIssue.title, SUBLABEL_MAX_UNITS),
    tag: root?.status || "done",
    width: NODE_WIDTH,
    issueId: labelIssue.id,
    status: labelIssue.status,
  });
  addNode(nodes, {
    id: `fold${issueKey(labelIssue)}`,
    lane: laneId,
    col: 5,
    type: "cloud",
    label: chain.standalone ? "独立任务" : `子任务${kids.length}`,
    sublabel: truncateUnits(chain.standalone ? "已关闭" : `${closedN} 已关闭`, SUBLABEL_MAX_UNITS),
    tag,
    width: NODE_WIDTH,
  });
  edges.push(edge(`e_${laneId}_fold`, startId, `fold${issueKey(labelIssue)}`, "折叠", { variant: "dashed" }));
  return {
    visible: [{ issue: labelIssue, id: startId, stage: 0, cls: classifyIssue(labelIssue, kids) }],
    anchorId: startId,
  };
}

function collectExceptionEvents(chains: IssueChain[], cap = 6) {
  const events: Array<{
    issue: MappingIssue;
    cls: ReturnType<typeof classifyIssue>;
    chain: IssueChain;
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
      events.push({
        issue,
        cls,
        chain,
        activity: Date.parse(String(issue.last_activity_at || issue.updated_at || issue.created_at || 0)) || 0,
      });
    }
  }
  events.sort((a, b) => {
    const open = (x: (typeof events)[number]) => (CLOSED.has(x.issue.status || "") ? 1 : 0);
    if (open(a) !== open(b)) return open(a) - open(b);
    return b.activity - a.activity;
  });
  return events.slice(0, cap);
}

function pickMainPath(chain: IssueChain | undefined, nodes: WorkflowNode[]): string[] {
  if (!chain) return [];
  const ids: string[] = [];
  if (chain.root) {
    const id = nodeId("p", chain.root);
    if (nodes.some((n) => n.id === id)) ids.push(id);
  }
  const byStage = new Map<number, MappingIssue>();
  for (const child of chain.children) {
    const s = inferStage(child);
    if (!byStage.has(s)) byStage.set(s, child);
  }
  for (const s of [...byStage.keys()].sort((a, b) => a - b)) {
    const id = nodeId("n", byStage.get(s)!);
    if (nodes.some((n) => n.id === id)) ids.push(id);
  }
  return ids;
}

export function buildWorkflow(
  issues: MappingIssue[],
  opts: WorkflowOpts = DEFAULT_WORKFLOW_OPTS,
): WorkflowDoc {
  const index = buildIndex(issues);
  const chains = buildChains(issues, index);
  const picked = selectChains(chains, opts);

  const lanes: WorkflowLane[] = [];
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const visible: ReturnType<typeof expandFullChain> = [];
  const anchors = new Map<string, string>();

  const pushLane = (
    id: string,
    label: string,
    kind: WorkflowLane["kind"],
    variant?: string,
  ) => {
    const lane: WorkflowLane = { id, label, kind };
    if (variant) lane.variant = variant;
    lanes.push(lane);
  };

  const rememberAnchor = (chain: IssueChain | undefined, nodeIdVal: string | null | undefined) => {
    if (chain?.id && nodeIdVal) anchors.set(chain.id, nodeIdVal);
  };

  for (const chain of picked.active) {
    const laneId = `ln${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "active");
    const vis = expandFullChain(chain, laneId, nodes, edges);
    visible.push(...vis);
    rememberAnchor(chain, vis[0]?.id);
  }

  const waitingExpanded: IssueChain[] = [];
  const waitingOverflow: IssueChain[] = [];
  for (const chain of picked.waiting) {
    const cost = chainMemberCount(chain);
    if (nodes.length + cost > opts.maxNodes) {
      waitingOverflow.push(chain);
      continue;
    }
    const laneId = `lw${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "waiting");
    const vis = expandFullChain(chain, laneId, nodes, edges);
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
    });
    edges.push(edge("e_waitfold", "waitFoldStart", "waitFoldEnd", "折叠", { variant: "dashed" }));
    for (const chain of waitingOverflow) rememberAnchor(chain, "waitFoldStart");
  }

  let closedShown = 0;
  const closedOverflow: IssueChain[] = [];
  for (const chain of picked.keptClosed) {
    if (nodes.length + 2 > opts.maxNodes) {
      closedOverflow.push(chain);
      continue;
    }
    const laneId = `lc${issueKey(chain.root || chain.children[0]!)}`;
    pushLane(laneId, laneLabelFor(chain), "closed");
    const folded = foldChain(chain, laneId, nodes, edges, "done");
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
        label: ev.issue.identifier || ev.issue.id,
        sublabel: truncateUnits(ev.cls.pending ? "待决策" : "返工事件", SUBLABEL_MAX_UNITS),
        tag: ev.cls.pending ? "待决策" : "返工",
        width: NODE_WIDTH,
        issueId: ev.issue.id,
        status: ev.issue.status,
      });
      const origin = visible.find((v) => v.issue.id === ev.issue.id);
      let fromId = origin?.id
        || (nodeIds.has(anchors.get(ev.chain.id) || "") ? anchors.get(ev.chain.id) : null)
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
    });
  }

  assignLaneStacks(nodes);

  const stats: WorkflowStats = summarize(issues, index);
  const scale = {
    maxNodes: opts.maxNodes,
    activeExpanded: picked.active.length,
    waitingExpanded: waitingExpanded.length,
    waitingFolded: waitingOverflow.length,
    closedShown,
    closedHistory: rest.length,
  };
  stats.scale = scale;
  const mainPath = pickMainPath(picked.active[0] || picked.waiting[0], nodes);

  return {
    schema_version: 2,
    diagram_type: "workflow",
    lanes,
    phases: PHASES,
    ...(mainPath.length >= 2 ? { mainPath } : {}),
    nodes,
    edges,
    stats,
  };
}
