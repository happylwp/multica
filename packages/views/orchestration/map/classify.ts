import {
  ACTIVE,
  CLOSED,
  STAGE_LABELS,
  WAITING_STATUSES,
  type ChainKind,
  type IssueChain,
  type IssueClass,
  type MappingIssue,
  type WorkflowStats,
} from "./types";

export function labelNames(issue: MappingIssue): string[] {
  return (issue.labels || [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((name): name is string => Boolean(name));
}

export function hasLabel(issue: MappingIssue, name: string): boolean {
  return labelNames(issue).includes(name);
}

export function isRework(issue: MappingIssue): boolean {
  return /返工/.test(issue.title || "");
}

export function issueKey(issue: MappingIssue): string {
  return String(issue.identifier || issue.id || "x").replace(/[^a-zA-Z0-9]/g, "");
}

export function nodeId(prefix: string, issue: MappingIssue): string {
  return `${prefix}${issueKey(issue)}`;
}

export function inferStage(issue: MappingIssue): number {
  if (Number.isInteger(issue.stage) && (issue.stage ?? 0) >= 1) {
    return Math.min(issue.stage as number, 5);
  }
  const names = labelNames(issue);
  for (const [stage, label] of Object.entries(STAGE_LABELS)) {
    if (names.includes(label)) return Number(stage);
  }
  if (issue.status === "in_review") return 2;
  if (issue.status === "done" || issue.status === "cancelled") return 5;
  if (issue.status === "backlog") return 0;
  return 1;
}

export function activityTs(issue: MappingIssue): number {
  const raw = issue.last_activity_at || issue.updated_at || issue.created_at || 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

export function sortIssues(list: MappingIssue[]): MappingIssue[] {
  return [...list].sort((a, b) => {
    const sa = inferStage(a);
    const sb = inferStage(b);
    if (sa !== sb) return sa - sb;
    const na = Number(a.number) || 0;
    const nb = Number(b.number) || 0;
    if (na !== nb) return na - nb;
    return String(a.identifier).localeCompare(String(b.identifier));
  });
}

export function priorStagesComplete(children: MappingIssue[], stage: number): boolean {
  const present = new Set(children.map(inferStage));
  for (let s = 1; s < stage; s += 1) {
    if (!present.has(s)) continue;
    const at = children.filter((c) => inferStage(c) === s);
    if (!at.every((c) => CLOSED.has(c.status || ""))) return false;
  }
  return true;
}

/**
 * waiting：有唤醒路径（等前序 stage / 排队），不是停滞。
 * trueBlocked：blocked 且前序已齐，无自动唤醒路径。
 */
export function classifyIssue(issue: MappingIssue, children: MappingIssue[] = []): IssueClass {
  const stage = inferStage(issue);
  const pending = hasLabel(issue, "pending-decision");
  const waitingOnPrior = WAITING_STATUSES.has(issue.status || "") && !priorStagesComplete(children, stage);
  const trueBlocked = issue.status === "blocked" && !pending && priorStagesComplete(children, stage);
  return {
    stage,
    pending,
    rework: isRework(issue),
    waitingOnPrior,
    trueBlocked,
  };
}

export function displayTag(issue: MappingIssue, cls: IssueClass): string {
  if (cls.pending) return "待决策";
  if (cls.trueBlocked) return "blocked";
  if (cls.waitingOnPrior && issue.status === "blocked") return "blocked·等";
  if (cls.waitingOnPrior && issue.status === "backlog") return "waiting";
  return issue.status || "todo";
}

export function chainKind(root: MappingIssue | null, children: MappingIssue[]): ChainKind {
  const members = root ? [root, ...children] : children;
  const statuses = new Set(members.map((m) => m.status));
  if ([...statuses].some((s) => ACTIVE.has(s || ""))) return "active";
  if ([...statuses].every((s) => CLOSED.has(s || ""))) return "closed";
  return "waiting";
}

export function chainActivity(root: MappingIssue | null, children: MappingIssue[]): number {
  return Math.max(root ? activityTs(root) : 0, ...children.map(activityTs), 0);
}

export function chainMemberCount(chain: IssueChain): number {
  return (chain.root ? 1 : 0) + chain.children.length;
}

export function buildIndex(issues: MappingIssue[]) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenOf = new Map<string, MappingIssue[]>();
  for (const issue of issues) {
    const pid = issue.parent_issue_id;
    if (!pid) continue;
    const kids = childrenOf.get(pid) ?? [];
    kids.push(issue);
    childrenOf.set(pid, kids);
  }
  for (const [pid, kids] of childrenOf) {
    childrenOf.set(pid, sortIssues(kids));
  }
  return { byId, childrenOf };
}

/** 沿 parent_issue_id 上溯到数据集内顶层；父不在库中则归入该缺失父 id（root=null，保留孤儿链）。 */
export function walkToTop(
  issue: MappingIssue,
  byId: Map<string, MappingIssue>,
): { root: MappingIssue | null; groupId: string } {
  let cur: MappingIssue | undefined = issue;
  const seen: MappingIssue[] = [];
  const seenSet = new Set<string>();
  while (cur?.parent_issue_id) {
    if (seenSet.has(cur.id)) {
      const ids = seen.map((x) => x.id).sort();
      return { root: byId.get(ids[0]!) || cur, groupId: ids[0]! };
    }
    seen.push(cur);
    seenSet.add(cur.id);
    const parent = byId.get(cur.parent_issue_id);
    if (!parent) return { root: null, groupId: cur.parent_issue_id };
    cur = parent;
  }
  return { root: cur ?? null, groupId: cur?.id ?? issue.id };
}

export function buildChains(
  issues: MappingIssue[],
  { byId }: { byId: Map<string, MappingIssue> },
): IssueChain[] {
  const groups = new Map<string, { root: MappingIssue | null; members: MappingIssue[] }>();
  for (const issue of issues) {
    const { root, groupId } = walkToTop(issue, byId);
    if (!groups.has(groupId)) groups.set(groupId, { root, members: [] });
    const g = groups.get(groupId)!;
    if (root && !g.root) g.root = root;
    g.members.push(issue);
  }

  const chains: IssueChain[] = [];
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

export function selectChains(chains: IssueChain[], opts: { recentClosed: number }) {
  const active = chains
    .filter((c) => c.kind === "active")
    .sort((a, b) => b.activity - a.activity);
  const waiting = chains
    .filter((c) => c.kind === "waiting")
    .sort((a, b) => b.activity - a.activity);
  const closed = chains
    .filter((c) => c.kind === "closed")
    .sort((a, b) => {
      if (a.standalone !== b.standalone) return a.standalone ? 1 : -1;
      return b.activity - a.activity;
    });

  const keptClosed = closed.slice(0, Math.max(0, opts.recentClosed));
  const foldedClosed = closed.slice(keptClosed.length);
  return { active, waiting, keptClosed, foldedClosed };
}

export function summarize(
  issues: MappingIssue[],
  index?: ReturnType<typeof buildIndex>,
): WorkflowStats {
  const { childrenOf, byId } = index || buildIndex(issues);
  let waiting = 0;
  let trueBlocked = 0;
  let pending = 0;
  let rework = 0;
  const byStatus: Record<string, number> = {};
  for (const issue of issues) {
    const status = issue.status || "todo";
    byStatus[status] = (byStatus[status] || 0) + 1;
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
