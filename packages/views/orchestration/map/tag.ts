export type TagTone = "waiting" | "blocked" | "done" | "active" | "pending" | "muted";

export function tagTone(tag: string | undefined, status?: string): TagTone {
  const value = tag || status || "";
  if (value === "待决策" || value === "pending") return "pending";
  if (value === "blocked" || value === "返工") return "blocked";
  if (value === "waiting" || value === "blocked·等" || value === "backlog") return "waiting";
  if (value === "done" || value === "cancelled" || value === "folded") return "done";
  if (value === "in_progress" || value === "in_review" || value === "todo") return "active";
  return "muted";
}

export function matchesStatusFilter(
  filter: "all" | "waiting" | "blocked" | "done",
  tag: string | undefined,
  status?: string,
): boolean {
  if (filter === "all") return true;
  const tone = tagTone(tag, status);
  if (filter === "waiting") return tone === "waiting";
  if (filter === "blocked") return tone === "blocked" || tone === "pending";
  return tone === "done";
}

export const TAG_TONE_CLASS: Record<TagTone, string> = {
  waiting: "border-amber-400/70 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100",
  blocked: "border-rose-500/70 bg-rose-50 text-rose-950 dark:bg-rose-950/40 dark:text-rose-100",
  done: "border-emerald-400/50 bg-emerald-50/80 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100",
  active: "border-sky-400/70 bg-sky-50 text-sky-950 dark:bg-sky-950/40 dark:text-sky-100",
  pending: "border-violet-400/70 bg-violet-50 text-violet-950 dark:bg-violet-950/40 dark:text-violet-100",
  muted: "border-border bg-card text-card-foreground",
};
