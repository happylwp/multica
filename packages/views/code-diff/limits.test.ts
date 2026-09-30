// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CODE_DIFF_PREVIEW_MAX_BYTES,
  isCodeDiffFilename,
  isCodeDiffOverLimit,
} from "./limits";

describe("isCodeDiffFilename", () => {
  it("accepts .diff and .patch regardless of case or path", () => {
    expect(isCodeDiffFilename("changes.diff")).toBe(true);
    expect(isCodeDiffFilename("changes.patch")).toBe(true);
    expect(isCodeDiffFilename("dir/Foo.DIFF")).toBe(true);
    expect(isCodeDiffFilename("notes.md")).toBe(false);
    expect(isCodeDiffFilename("archive.zip")).toBe(false);
    expect(isCodeDiffFilename("diff")).toBe(false);
  });
});

describe("isCodeDiffOverLimit", () => {
  it("treats missing size as within limit", () => {
    expect(isCodeDiffOverLimit(undefined)).toBe(false);
    expect(isCodeDiffOverLimit(CODE_DIFF_PREVIEW_MAX_BYTES)).toBe(false);
    expect(isCodeDiffOverLimit(CODE_DIFF_PREVIEW_MAX_BYTES + 1)).toBe(true);
  });
});
