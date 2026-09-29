export const TAG_TONES: Record<string, string> = {
  waiting: "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30",
  "blocked·等": "bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-amber-500/30",
  blocked: "bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/40",
  待决策: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 ring-fuchsia-500/30",
  返工: "bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30",
  done: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 ring-emerald-500/25",
  cancelled: "bg-muted text-muted-foreground ring-border",
  in_progress: "bg-brand/15 text-brand ring-brand/30",
  in_review: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-indigo-500/30",
  todo: "bg-muted text-foreground ring-border",
  backlog: "bg-muted text-muted-foreground ring-border",
  folded: "bg-muted text-muted-foreground ring-border",
  scale: "bg-muted text-muted-foreground ring-border",
  empty: "bg-muted text-muted-foreground ring-border",
};

export const FILTER_TAGS = [
  "waiting",
  "blocked·等",
  "blocked",
  "待决策",
  "in_progress",
  "in_review",
  "done",
] as const;

export type FilterTag = (typeof FILTER_TAGS)[number];

export function tagTone(tag: string): string {
  return TAG_TONES[tag] ?? "bg-muted text-muted-foreground ring-border";
}
