/** Aligns with server `maxPreviewTextSize` in file.go (2 MiB). No backend change. */
export const CODE_DIFF_PREVIEW_MAX_BYTES = 2 << 20;

const DIFF_EXT = /\.(diff|patch)$/i;

export function isCodeDiffFilename(filename: string): boolean {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  return DIFF_EXT.test(base);
}

export function isCodeDiffOverLimit(sizeBytes?: number): boolean {
  return typeof sizeBytes === "number" && sizeBytes > CODE_DIFF_PREVIEW_MAX_BYTES;
}
