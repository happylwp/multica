// CJK / emoji width — same textUnits rules as orchestration-gen/generate.mjs
// (copied from archify renderers/shared/utils.mjs, not imported).

const FULLWIDTH_RE =
  /[\u1100-\u115F\u231A-\u231B\u2329-\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2630-\u2637\u2648-\u2653\u267F\u268A-\u268F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\uA4CF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{18DFF}\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B2FF}\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const VARIATION_SELECTOR_FIRST = 0xfe00;
const VARIATION_SELECTOR_LAST = 0xfe0f;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;

export function textUnits(text: string | null | undefined): number {
  const chars = Array.from(String(text ?? ""));
  let units = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint >= VARIATION_SELECTOR_FIRST && codePoint <= VARIATION_SELECTOR_LAST) {
      continue;
    }
    const nextCh = chars[i + 1];
    const next = nextCh ? (nextCh.codePointAt(0) ?? -1) : -1;
    if (next === VARIATION_SELECTOR_EMOJI) units += 2;
    else units += FULLWIDTH_RE.test(ch) ? 2 : 1;
  }
  return units;
}

export function truncateUnits(text: string | null | undefined, maxUnits: number): string {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (textUnits(raw) <= maxUnits) return raw;
  const ellipsis = "…";
  const budget = maxUnits - textUnits(ellipsis);
  let out = "";
  for (const ch of raw) {
    const next = `${out}${ch}`;
    if (textUnits(next) > budget) break;
    out = next;
  }
  return `${out}${ellipsis}`;
}
