// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildChains,
  buildIndex,
  classifyIssue,
  displayTag,
  inferStage,
  walkToTop,
} from "./classify";
import type { MappingIssue } from "./types";

function issue(partial: Partial<MappingIssue> & Pick<MappingIssue, "id">): MappingIssue {
  return {
    identifier: partial.identifier ?? `MARO-${partial.id}`,
    title: partial.title ?? "task",
    status: partial.status ?? "todo",
    ...partial,
  };
}

describe("inferStage", () => {
  it("prefers integer stage, then labels, then status", () => {
    expect(inferStage(issue({ id: "a", stage: 3 }))).toBe(3);
    expect(inferStage(issue({ id: "b", labels: ["review"] }))).toBe(2);
    expect(inferStage(issue({ id: "c", status: "in_review" }))).toBe(2);
    expect(inferStage(issue({ id: "d", status: "done" }))).toBe(5);
    expect(inferStage(issue({ id: "e", status: "backlog" }))).toBe(0);
    expect(inferStage(issue({ id: "f", status: "in_progress" }))).toBe(1);
  });

  it("caps stage at 5", () => {
    expect(inferStage(issue({ id: "g", stage: 9 }))).toBe(5);
  });
});

describe("classifyIssue / displayTag", () => {
  const stage1 = issue({ id: "s1", stage: 1, status: "done", title: "build" });
  const waiting = issue({ id: "s2", stage: 2, status: "backlog", title: "review later" });
  const blockedWait = issue({ id: "s3", stage: 2, status: "blocked", title: "review blocked" });
  const trueBlocked = issue({ id: "s4", stage: 2, status: "blocked", title: "stuck" });
  const pending = issue({
    id: "s5",
    stage: 2,
    status: "blocked",
    title: "need decision",
    labels: [{ name: "pending-decision" }],
  });

  it("marks backlog behind an open prior stage as waiting", () => {
    const openPrior = issue({ id: "p1", stage: 1, status: "in_progress" });
    const cls = classifyIssue(waiting, [openPrior, waiting]);
    expect(cls.waitingOnPrior).toBe(true);
    expect(cls.trueBlocked).toBe(false);
    expect(displayTag(waiting, cls)).toBe("waiting");
  });

  it("marks blocked behind an open prior stage as blocked·等", () => {
    const openPrior = issue({ id: "p1", stage: 1, status: "in_progress" });
    const cls = classifyIssue(blockedWait, [openPrior, blockedWait]);
    expect(cls.waitingOnPrior).toBe(true);
    expect(cls.trueBlocked).toBe(false);
    expect(displayTag(blockedWait, cls)).toBe("blocked·等");
  });

  it("marks blocked with priors complete as true blocked", () => {
    const cls = classifyIssue(trueBlocked, [stage1, trueBlocked]);
    expect(cls.waitingOnPrior).toBe(false);
    expect(cls.trueBlocked).toBe(true);
    expect(displayTag(trueBlocked, cls)).toBe("blocked");
  });

  it("prefers 待决策 over blocked", () => {
    const cls = classifyIssue(pending, [stage1, pending]);
    expect(cls.pending).toBe(true);
    expect(cls.trueBlocked).toBe(false);
    expect(displayTag(pending, cls)).toBe("待决策");
  });
});

describe("walkToTop / buildChains", () => {
  it("groups descendants under the workspace root", () => {
    const root = issue({ id: "root", title: "parent", status: "in_progress" });
    const child = issue({ id: "c1", parent_issue_id: "root", stage: 1, status: "todo" });
    const grand = issue({ id: "c2", parent_issue_id: "c1", stage: 2, status: "backlog" });
    const { byId } = buildIndex([root, child, grand]);
    expect(walkToTop(grand, byId)).toEqual({ root, groupId: "root" });
    const chains = buildChains([root, child, grand], { byId });
    expect(chains).toHaveLength(1);
    expect(chains[0]!.root?.id).toBe("root");
    expect(chains[0]!.children.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(chains[0]!.kind).toBe("active");
    expect(chains[0]!.standalone).toBe(false);
  });

  it("keeps an orphan chain when the parent is missing", () => {
    const orphan = issue({ id: "o1", parent_issue_id: "missing", status: "todo" });
    const { byId } = buildIndex([orphan]);
    expect(walkToTop(orphan, byId)).toEqual({ root: null, groupId: "missing" });
    const chains = buildChains([orphan], { byId });
    expect(chains[0]!.root).toBeNull();
    expect(chains[0]!.children).toHaveLength(1);
  });

  it("marks a parentless issue with no children as standalone", () => {
    const lone = issue({ id: "s", status: "done" });
    const { byId } = buildIndex([lone]);
    const chains = buildChains([lone], { byId });
    expect(chains[0]!.standalone).toBe(true);
    expect(chains[0]!.kind).toBe("closed");
  });
});
