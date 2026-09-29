import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { buildWorkflow } from "../map/workflow";
import type { OrchestrationIssue } from "../map/types";

const graph = buildWorkflow([
  {
    id: "p",
    identifier: "MARO-1",
    title: "父任务",
    status: "in_progress",
  } satisfies OrchestrationIssue,
  {
    id: "c",
    identifier: "MARO-2",
    title: "实现",
    status: "blocked",
    parent_issue_id: "p",
    stage: 1,
  } satisfies OrchestrationIssue,
]);

vi.mock("../hooks/use-orchestration-issues", () => ({
  useOrchestrationGraph: () => ({
    graph,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: unknown }) => (
    <div data-testid="orchestration-flow">{children as never}</div>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
  }),
}));

import { OrchestrationPage } from "./orchestration-page";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/orchestration",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.test${path}`,
};

describe("OrchestrationPage", () => {
  it("renders the nav title, waiting/blocked stats, and the canvas", () => {
    renderWithI18n(
      <NavigationProvider value={adapter}>
        <OrchestrationPage />
      </NavigationProvider>,
    );
    expect(screen.getByRole("heading", { name: "Orchestration" })).toBeInTheDocument();
    expect(screen.getByTestId("orchestration-flow")).toBeInTheDocument();
    expect(screen.getByText(/waiting 0/)).toBeInTheDocument();
  });

  it("toggles the active-chain focus switch", async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <NavigationProvider value={adapter}>
        <OrchestrationPage />
      </NavigationProvider>,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("data-unchecked");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("data-checked");
  });
});
