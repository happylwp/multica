import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { CodeDiffEntryCard } from "./code-diff-entry-card";

describe("CodeDiffEntryCard", () => {
  it("shows the view-changes CTA and opens on click", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CodeDiffEntryCard filename="changes.diff" onOpen={onOpen} />);
    expect(screen.getByTestId("code-diff-entry")).toBeInTheDocument();
    expect(screen.getByText("changes.diff")).toBeInTheDocument();
    expect(screen.getByText("View code changes")).toBeInTheDocument();
    await user.click(screen.getByTestId("code-diff-entry"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the Chinese CTA", () => {
    renderWithI18n(<CodeDiffEntryCard filename="changes.diff" onOpen={() => {}} />, {
      locale: "zh-Hans",
    });
    expect(screen.getByText("查看代码变更")).toBeInTheDocument();
  });
});
