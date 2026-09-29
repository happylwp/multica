// @vitest-environment node
import { describe, expect, it } from "vitest";
import { textUnits, truncateUnits } from "./text";

describe("textUnits", () => {
  it("counts ASCII as 1 and CJK as 2", () => {
    expect(textUnits("abc")).toBe(3);
    expect(textUnits("任务")).toBe(4);
    expect(textUnits("MARO-1 任务")).toBe(11);
  });

  it("treats a character followed by emoji variation selector as width 2", () => {
    expect(textUnits("A\uFE0F")).toBe(2);
  });
});

describe("truncateUnits", () => {
  it("returns the original when within budget", () => {
    expect(truncateUnits("hello", 10)).toBe("hello");
  });

  it("truncates CJK to nine-character-wide budget like generate.mjs", () => {
    const title = "实现：multica web 原生任务编排 DAG 视图";
    const out = truncateUnits(title, 18);
    expect(textUnits(out)).toBeLessThanOrEqual(18);
    expect(out.endsWith("…")).toBe(true);
  });
});
