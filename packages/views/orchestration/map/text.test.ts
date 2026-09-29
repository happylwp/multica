import { describe, expect, it } from "vitest";
import { textUnits, truncateUnits } from "./text";

describe("textUnits", () => {
  it("counts ASCII as 1 and CJK as 2", () => {
    expect(textUnits("ab")).toBe(2);
    expect(textUnits("编排全景")).toBe(8);
    expect(textUnits("MARO-1 任务")).toBe(11);
  });

  it("skips variation selectors and treats emoji-vs as wide", () => {
    expect(textUnits("A\uFE0F")).toBe(2);
    expect(textUnits("\uFE0F")).toBe(0);
  });
});

describe("truncateUnits", () => {
  it("keeps short titles and clips to 9 CJK-wide units", () => {
    expect(truncateUnits("短标题", 18)).toBe("短标题");
    expect(truncateUnits("这是一个超过九个汉字宽度的标题文字", 18)).toBe("这是一个超过九个…");
  });

  it("collapses whitespace before measuring", () => {
    expect(truncateUnits("  hello   world  ", 18)).toBe("hello world");
  });
});
