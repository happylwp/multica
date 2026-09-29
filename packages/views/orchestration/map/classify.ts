import type { IssueClass, OrchestrationIssue } from "./types";

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

export function labelNames(issue: OrchestrationIssue): string[] {
  return (issue.labels || [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((name): name is string => Boolean(name));
}

export function hasLabel(issue: OrchestrationIssue, name: string): boolean {
  return labelNames(issue).includes(name);
}

export function isRework(issue: OrchestrationIssue): boolean {
  return /返工/.test(issue.title || "");
}

export function inferStage(issue: OrchestrationIssue): number {
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

export function priorStagesComplete(children: OrchestrationIssue[], stage: number): boolean {
  const present = new Set(children.map(inferStage));
  for (let s = 1; s < stage; s += 1) {
    if (!present.has(s)) continue;
    const at = children.filter((c) => inferStage(c) === s);
    if (!at.every((c) => CLOSED.has(c.status))) return false;
  }
  return true;
}

/**
 * waiting：有唤醒路径（等前序 stage / 排队），不是停滞。
 * trueBlocked：blocked 且前序已齐，无自动唤醒路径。
 */
export function classifyIssue(
  issue: OrchestrationIssue,
  children: OrchestrationIssue[] = [],
): IssueClass {
  const stage = inferStage(issue);
  const pending = hasLabel(issue, "pending-decision");
  const waitingOnPrior = WAITING_STATUSES.has(issue.status) && !priorStagesComplete(children, stage);
  const trueBlocked = issue.status === "blocked" && !pending && priorStagesComplete(children, stage);
  return {
    stage,
    pending,
    rework: isRework(issue),
    waitingOnPrior,
    trueBlocked,
  };
}

export function displayTag(issue: OrchestrationIssue, cls: IssueClass): string {
  if (cls.pending) return "待决策";
  if (cls.trueBlocked) return "blocked";
  if (cls.waitingOnPrior && issue.status === "blocked") return "blocked·等";
  if (cls.waitingOnPrior && issue.status === "backlog") return "waiting";
  return issue.status || "todo";
}

export function activityTs(issue: OrchestrationIssue): number {
  const raw = issue.last_activity_at || issue.updated_at || issue.created_at || 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

export function sortIssues(list: OrchestrationIssue[]): OrchestrationIssue[] {
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

export function issueKey(issue: { identifier?: string; id?: string }): string {
  return String(issue.identifier || issue.id || "x").replace(/[^a-zA-Z0-9]/g, "");
}

export function nodeId(prefix: string, issue: { identifier?: string; id?: string }): string {
  return `${prefix}${issueKey(issue)}`;
}
