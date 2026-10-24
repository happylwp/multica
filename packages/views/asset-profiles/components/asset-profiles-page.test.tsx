// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";
import { AssetProfilesPage } from "./asset-profiles-page";

// The list page owns three seams: the query (mocked at the api layer so the
// Query runs for real), navigation (row links / paths), and the workspace
// context. Everything else — header, empty state, dialog — renders through
// the real tree.

const listAssetProfiles = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: { listAssetProfiles: (...a: unknown[]) => listAssetProfiles(...a) },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    assets: () => "/acme/assets",
    assetProfileDetail: (id: string) => `/acme/assets/${id}`,
  }),
}));

vi.mock("../../navigation", () => ({
  useRowLink: () => (href: string) => ({ onClick: () => href }),
}));

const TEST_RESOURCES = {
  en: { common: enCommon, assets: enAssets },
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssetProfilesPage", () => {
  it("renders one row per profile with name and description", async () => {
    listAssetProfiles.mockResolvedValue([
      {
        id: "ap-1",
        workspace_id: "ws-1",
        name: "Portfolio archive",
        description: "fund holdings",
        created_by: null,
        created_at: "2026-10-23T00:00:00Z",
        updated_at: "2026-10-23T00:00:00Z",
      },
      {
        id: "ap-2",
        workspace_id: "ws-1",
        name: "Insurance records",
        description: "",
        created_by: null,
        created_at: "2026-10-23T00:00:00Z",
        updated_at: "2026-10-24T00:00:00Z",
      },
    ]);

    render(
      <Wrapper>
        <AssetProfilesPage />
      </Wrapper>,
    );

    expect(await screen.findByText("Portfolio archive")).toBeTruthy();
    expect(screen.getByText("fund holdings")).toBeTruthy();
    expect(screen.getByText("Insurance records")).toBeTruthy();
    // Summary rows never carry the document — nothing to assert on data, but
    // the header count reflects the two profiles.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("shows the empty state when the workspace has no profiles", async () => {
    listAssetProfiles.mockResolvedValue([]);

    render(
      <Wrapper>
        <AssetProfilesPage />
      </Wrapper>,
    );

    expect(await screen.findByText("No asset profiles")).toBeTruthy();
    // Header action and empty-state action both carry the label.
    expect(screen.getAllByText("New asset profile").length).toBe(2);
  });

  it("opens the create dialog from the header action", async () => {
    listAssetProfiles.mockResolvedValue([]);
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AssetProfilesPage />
      </Wrapper>,
    );

    const actions = await screen.findAllByText("New asset profile");
    await user.click(actions[0]!);
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("JSON document")).toBeTruthy();
  });
});
