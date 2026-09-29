import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { OrchestrationPage } from "./orchestration-page";

const { queryState, refetch } = vi.hoisted(() => {
  const refetch = vi.fn();
  return {
    refetch,
    queryState: {
      current: {
        data: [
          {
            id: "root",
            identifier: "MARO-1",
            title: "Parent",
            status: "in_progress",
            stage: null,
            parent_issue_id: null,
            labels: [],
            number: 1,
            last_activity_at: "2026-09-29T00:00:00Z",
          },
          {
            id: "child",
            identifier: "MARO-2",
            title: "Build",
            status: "todo",
            stage: 1,
            parent_issue_id: "root",
            labels: [],
            number: 2,
            last_activity_at: "2026-09-29T00:00:00Z",
          },
        ],
        isPending: false,
        isError: false,
        isFetching: false,
        refetch,
      },
    },
  };
});

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("../hooks/use-orchestration-issues", () => ({
  useOrchestrationIssues: () => queryState.current,
}));

vi.mock("./orchestration-canvas", () => ({
  OrchestrationCanvas: () => <div data-testid="orchestration-canvas" />,
}));

describe("OrchestrationPage", () => {
  beforeEach(() => {
    refetch.mockReset();
    queryState.current.isPending = false;
    queryState.current.isError = false;
  });

  it("renders the title, stats, filters, and canvas", () => {
    renderWithI18n(<OrchestrationPage />);
    expect(screen.getByRole("heading", { name: "Orchestration" })).toBeInTheDocument();
    expect(screen.getByTestId("orchestration-canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Focus active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waiting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blocked" })).toBeInTheDocument();
  });

  it("toggles the active-chain focus", async () => {
    const user = userEvent.setup();
    renderWithI18n(<OrchestrationPage />);
    const button = screen.getByRole("button", { name: "Focus active" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
