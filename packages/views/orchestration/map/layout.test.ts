// @vitest-environment node
import { describe, expect, it } from "vitest";
import { COL_WIDTH, GRAPH_PAD_X, layoutWorkflow } from "./layout";
import { buildWorkflow } from "./workflow";
import type { MappingIssue } from "./types";

function issue(partial: Partial<MappingIssue> & Pick<MappingIssue, "id">): MappingIssue {
  return {
    identifier: partial.identifier ?? `MARO-${partial.id}`,
    title: partial.title ?? "task",
    status: partial.status ?? "in_progress",
    ...partial,
  };
}

describe("layoutWorkflow", () => {
  it("snaps X to mapping columns so phases align across lanes", () => {
    const root = issue({ id: "root", identifier: "MARO-1" });
    const child = issue({
      id: "c",
      identifier: "MARO-2",
      parent_issue_id: "root",
      stage: 1,
      status: "todo",
    });
    const doc = buildWorkflow([root, child]);
    const positions = layoutWorkflow(doc);
    for (const node of doc.nodes) {
      const pos = positions.get(node.id);
      expect(pos).toBeDefined();
      expect(pos!.x).toBe(GRAPH_PAD_X + node.col * COL_WIDTH);
    }
  });
});
