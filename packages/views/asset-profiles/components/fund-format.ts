// Shared number formatting for fund-portfolio surfaces (dashboard, detail
// dialog, positions editor). CN market convention: red = gain, green = loss.
export const PNL_POSITIVE = "#ef4444";
export const PNL_NEGATIVE = "#10b981";

export function formatCNY(v: number, decimals = 2) {
  const digits =
    decimals === 0
      ? { maximumFractionDigits: 0, minimumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const formatted = v.toLocaleString(undefined, digits);
  return `¥${formatted}`;
}

export function formatPnL(v: number) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${formatCNY(v)}`;
}

export function formatPct(v: number) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

export function pnlTextClass(v: number) {
  return v >= 0
    ? "text-red-500 dark:text-red-400"
    : "text-emerald-600 dark:text-emerald-400";
}
