/**
 * Classify lines that parseUnifiedDiff already extracted into a hunk.
 * A leading `+` / `-` is only the unified-diff marker: `--- keep old` is a
 * deleted `-- keep old` line, and `+++ foo` is an added `++ foo` line.
 * File headers are not decided here.
 */

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export type DiffLineKind = "hunk" | "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Body with the diff marker removed. Hunk headers and `\` markers stay intact. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DisplayLine extends DiffLine {
  note: string | null;
}

export interface FoldedLine {
  type: "line";
  key: string;
  line: DisplayLine;
}

export interface FoldMarker {
  type: "fold";
  key: string;
  count: number;
}

export type FoldedItem = FoldedLine | FoldMarker;

export type SplitRow =
  | { type: "fold"; key: string; count: number }
  | { type: "banner"; key: string; line: DisplayLine }
  | { type: "pair"; key: string; left: FoldedLine | null; right: FoldedLine | null };

function shown(no: number): number | null {
  return no > 0 ? no : null;
}

export function hunksToLines(hunks: readonly string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const hunk of hunks) {
    let oldNo = 0;
    let newNo = 0;
    for (const raw of hunk.split("\n")) {
      if (raw.startsWith("@@")) {
        const match = HUNK_HEADER.exec(raw);
        oldNo = match ? Number(match[1]) : 0;
        newNo = match ? Number(match[2]) : 0;
        lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
        continue;
      }
      if (raw.startsWith("\\")) {
        lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
        continue;
      }
      if (raw.startsWith("+")) {
        const newShown = shown(newNo);
        if (newNo > 0) newNo += 1;
        lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newShown });
        continue;
      }
      if (raw.startsWith("-")) {
        const oldShown = shown(oldNo);
        if (oldNo > 0) oldNo += 1;
        lines.push({ kind: "del", text: raw.slice(1), oldNo: oldShown, newNo: null });
        continue;
      }
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      const oldShown = shown(oldNo);
      const newShown = shown(newNo);
      if (oldNo > 0) oldNo += 1;
      if (newNo > 0) newNo += 1;
      lines.push({ kind: "context", text, oldNo: oldShown, newNo: newShown });
    }
  }
  return lines;
}

/** Stick `\ No newline` markers onto the line they follow so they don't split a change. */
export function attachMeta(lines: readonly DiffLine[]): DisplayLine[] {
  const out: DisplayLine[] = [];
  for (const line of lines) {
    if (line.kind === "meta") {
      const prev = out[out.length - 1];
      if (prev && prev.kind !== "hunk") {
        prev.note = prev.note == null ? line.text : `${prev.note}\n${line.text}`;
        continue;
      }
    }
    out.push({ ...line, note: null });
  }
  return out;
}

/** Collapse a long unchanged run to `edge` lines on each side. */
export function foldContext(
  lines: readonly DisplayLine[],
  expanded: ReadonlySet<string>,
  edge = 3,
): FoldedItem[] {
  const items: FoldedItem[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.kind !== "context") {
      if (line) items.push({ type: "line", key: `l${i}`, line });
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end]?.kind === "context") end += 1;
    const count = end - i;
    const key = `fold:${i}`;
    if (count > edge * 2 && !expanded.has(key)) {
      for (let k = 0; k < edge; k++) {
        const kept = lines[i + k];
        if (kept) items.push({ type: "line", key: `l${i + k}`, line: kept });
      }
      items.push({ type: "fold", key, count: count - edge * 2 });
      for (let k = count - edge; k < count; k++) {
        const kept = lines[i + k];
        if (kept) items.push({ type: "line", key: `l${i + k}`, line: kept });
      }
    } else {
      for (let k = i; k < end; k++) {
        const kept = lines[k];
        if (kept) items.push({ type: "line", key: `l${k}`, line: kept });
      }
    }
    i = end;
  }
  return items;
}

export function toSplitRows(items: readonly FoldedItem[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item) break;
    if (item.type === "fold") {
      rows.push({ type: "fold", key: item.key, count: item.count });
      i += 1;
      continue;
    }
    const kind = item.line.kind;
    if (kind === "hunk" || kind === "meta") {
      rows.push({ type: "banner", key: item.key, line: item.line });
      i += 1;
      continue;
    }
    if (kind === "context") {
      rows.push({ type: "pair", key: item.key, left: item, right: item });
      i += 1;
      continue;
    }
    const lefts: FoldedLine[] = [];
    const rights: FoldedLine[] = [];
    while (i < items.length) {
      const current = items[i];
      if (!current || current.type !== "line" || current.line.kind !== "del") break;
      lefts.push(current);
      i += 1;
    }
    while (i < items.length) {
      const current = items[i];
      if (!current || current.type !== "line" || current.line.kind !== "add") break;
      rights.push(current);
      i += 1;
    }
    const width = Math.max(lefts.length, rights.length);
    for (let k = 0; k < width; k++) {
      const left = lefts[k] ?? null;
      const right = rights[k] ?? null;
      rows.push({
        type: "pair",
        key: `${left?.key ?? "none"}:${right?.key ?? "none"}`,
        left,
        right,
      });
    }
  }
  return rows;
}
