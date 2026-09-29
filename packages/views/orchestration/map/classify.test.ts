import { describe, expect, it } from "vitest";
import { classifyIssue, displayTag, inferStage } from "./classify";
import type { OrchestrationIssue } from "./types";

function issue(partial: Partial<OrchestrationIssue> & Pick<OrchestrationIssue, "id">): OrchestrationIssue {
  return {
    identifier: partial.identifier ?? `MARO-${partial.id}`,
    title: partial.title ?? partial.id,
    status: partial.status ?? "todo",
    ...partial,
  };
}

describe("inferStage", () => {
  it("prefers the stage field, then stage labels, then status", () => {
    expect(inferStage(issue({ id: "1", stage: 3, status: "todo" }))).toBe(3);
    expect(inferStage(issue({ id: "2", labels: ["review"], status: "todo" }))).toBe(2);
    expect(inferStage(issue({ id: "3", status: "in_review" }))).toBe(2);
    expect(inferStage(issue({ id: "4", status: "done" }))).toBe(5);
    expect(inferStage(issue({ id: "5", status: "backlog" }))).toBe(0);
    expect(inferStage(issue({ id: "6", status: "todo" }))).toBe(1);
  });
});

describe("classifyIssue / displayTag", () => {
  const impl = issue({ id: "impl", stage: 1, status: "in_progress" });
  const reviewDone = issue({ id: "rd", stage: 2, status: "done" });

  it("marks a backlog child waiting when a prior stage is still open", () => {
    const test = issue({ id: "t", stage: 3, status: "backlog", title: "后置测试" });
    const cls = classifyIssue(test, [impl, test]);
    expect(cls.waitingOnPrior).toBe(true);
    expect(cls.trueBlocked).toBe(false);
    expect(displayTag(test, cls)).toBe("waiting");
  });

  it("marks blocked·等 when blocked but prior stages are incomplete", () => {
    const blocked = issue({ id: "b", stage: 2, status: "blocked" });
    const cls = classifyIssue(blocked, [impl, blocked]);
    expect(cls.waitingOnPrior).toBe(true);
    expect(cls.trueBlocked).toBe(false);
    expect(displayTag(blocked, cls)).toBe("blocked·等");
  });

  it("marks true blocked when prior stages are closed", () => {
    const implDone = issue({ id: "id", stage: 1, status: "done" });
    const blocked = issue({ id: "b", stage: 2, status: "blocked" });
    const cls = classifyIssue(blocked, [implDone, reviewDone, blocked]);
    expect(cls.waitingOnPrior).toBe(false);
    expect(cls.trueBlocked).toBe(true);
    expect(displayTag(blocked, cls)).toBe("blocked");
  });

  it("pending-decision wins over blocked", () => {
    const pending = issue({
      id: "p",
      stage: 2,
      status: "blocked",
      labels: [{ name: "pending-decision" }],
    });
    const cls = classifyIssue(pending, [pending]);
    expect(cls.pending).toBe(true);
    expect(displayTag(pending, cls)).toBe("待决策");
  });

  it("only treats 返工 in the title as rework", () => {
    expect(classifyIssue(issue({ id: "r", title: "审查返工" })).rework).toBe(true);
    expect(classifyIssue(issue({ id: "f", title: "修复审查" })).rework).toBe(false);
  });
});
