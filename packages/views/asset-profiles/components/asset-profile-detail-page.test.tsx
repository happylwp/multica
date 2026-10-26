// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";
import { AssetProfileDetailPage } from "./asset-profile-detail-page";

// The detail page owns one decision: whether the document parses as a fund
// portfolio (dashboard tab shown) or not (raw JSON only). The dashboard
// itself is covered in fund-portfolio-dashboard.test.tsx.
const getAssetProfile = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getAssetProfile: (...a: unknown[]) => getAssetProfile(...a),
    deleteAssetProfile: vi.fn(),
  },
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
  useNavigation: () => ({ push: vi.fn() }),
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

function mockProfile(data: unknown) {
  getAssetProfile.mockResolvedValue({
    id: "ap-1",
    workspace_id: "ws-1",
    name: "Portfolio archive",
    description: "",
    created_by: null,
    created_at: "2026-10-23T00:00:00Z",
    updated_at: "2026-10-23T00:00:00Z",
    data,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssetProfileDetailPage", () => {
  it("shows the dashboard tab by default for fund-portfolio documents", async () => {
    mockProfile({
      funds: [
        { code: "161716", name: "Dual bond", market_value: 41175.31, cum_pnl: 1604.3 },
      ],
    });

    render(
      <Wrapper>
        <AssetProfileDetailPage profileId="ap-1" />
      </Wrapper>,
    );

    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(await screen.findByText("Holdings")).toBeTruthy();
  });

  it("renders only the raw document for non-portfolio profiles", async () => {
    mockProfile({ kind: "insurance", rows: [1, 2] });

    render(
      <Wrapper>
        <AssetProfileDetailPage profileId="ap-1" />
      </Wrapper>,
    );

    expect(await screen.findByText("Raw document")).toBeTruthy();
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(screen.getByText(/"kind": "insurance"/)).toBeTruthy();
  });
});
