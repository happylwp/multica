// @vitest-environment node
import { describe, expect, it } from "vitest";
import { matchesStatusFilter, tagTone } from "./tag";

describe("tagTone", () => {
  it("splits waiting from true blocked", () => {
    expect(tagTone("waiting")).toBe("waiting");
    expect(tagTone("blocked·等")).toBe("waiting");
    expect(tagTone("backlog")).toBe("waiting");
    expect(tagTone("blocked")).toBe("blocked");
    expect(tagTone("待决策")).toBe("pending");
    expect(tagTone("done")).toBe("done");
    expect(tagTone("in_progress")).toBe("active");
  });
});

describe("matchesStatusFilter", () => {
  it("keeps waiting tags on the waiting filter and blocked on blocked", () => {
    expect(matchesStatusFilter("waiting", "waiting")).toBe(true);
    expect(matchesStatusFilter("waiting", "blocked")).toBe(false);
    expect(matchesStatusFilter("blocked", "blocked")).toBe(true);
    expect(matchesStatusFilter("blocked", "待决策")).toBe(true);
    expect(matchesStatusFilter("done", "folded")).toBe(true);
    expect(matchesStatusFilter("all", "anything")).toBe(true);
  });
});
