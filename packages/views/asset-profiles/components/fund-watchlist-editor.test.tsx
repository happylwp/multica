// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AssetProfile } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";

const mockUpdate = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useMutation: ({ mutationFn, onSuccess, onError }: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (r: unknown) => void;
    onError?: (e: Error) => void;
  }) => ({
    isPending: false,
    mutate: async () => {
      try {
        onSuccess?.(await mutationFn());
      } catch (err) {
        onError?.(err as Error);
      }
    },
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@multica/core/api", () => ({ api: { updateAssetProfile: mockUpdate } }));
vi.mock("../eastmoney", () => ({ fetchEastMoneyFund: mockFetch }));

import { FundWatchlistEditorDialog } from "./fund-watchlist-editor";

const TEST_RESOURCES = { en: { common: enCommon, assets: enAssets } };

const PROFILE = {
  id: "profile-1",
  name: "Archive",
  description: "",
  created_at: "",
  updated_at: "",
  data: {
    funds: [{ code: "161716", name: "Dual bond" }],
    watchlist: {
      name: "trial",
      funds: [{ code: "510300", name: "沪深300ETF", weight: 40, added_at: "2026-10-26" }],
      baseline: "2026-10-26",
    },
  },
} as unknown as AssetProfile;

function renderEditor(profile = PROFILE) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <FundWatchlistEditorDialog wsId="ws-1" profile={profile} onClose={vi.fn()} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FundWatchlistEditorDialog", () => {
  it("pulls a fund by code and prefills its name", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      code: "512890",
      name: "红利低波ETF",
      nav: 1.05,
      navDate: "2026-10-26",
      returns: { m1: null, m3: null, m6: null, y1: null },
    });
    renderEditor();

    await user.type(screen.getByLabelText("Fund code"), "512890");
    await user.click(screen.getByRole("button", { name: "Fetch" }));

    expect(await screen.findByDisplayValue("红利低波ETF")).toBeTruthy();
  });

  it("saves weights and keeps the existing baseline", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({});
    renderEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const payload = mockUpdate.mock.calls[0]![1];
    expect(payload.data.watchlist).toEqual({
      name: "trial",
      funds: [{ code: "510300", name: "沪深300ETF", weight: 40, added_at: "2026-10-26" }],
      baseline: "2026-10-26",
    });
    // the rest of the document is preserved
    expect(payload.data.funds).toHaveLength(1);
  });

  it("backfills a new watchlist to 30 days ago", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({});
    mockFetch.mockResolvedValue({ code: "512890", name: "红利低波ETF", nav: 1.05, navDate: "2026-10-26" });
    const fresh = { ...PROFILE, data: { funds: PROFILE.data.funds } } as unknown as AssetProfile;
    renderEditor(fresh);

    expect(
      screen.getByText(/backfills the last 30 days/),
    ).toBeTruthy();

    await user.type(screen.getByLabelText("Fund code"), "512890");
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await user.type(screen.getByLabelText("Weight %"), "40");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const payload = mockUpdate.mock.calls[0]![1];
    const expected = new Date(Date.now() - 30 * 86400000);
    const monthAgo =
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`;
    expect(payload.data.watchlist.baseline).toBe(monthAgo);
    expect(payload.data.watchlist.funds).toEqual([
      { code: "512890", name: "红利低波ETF", weight: 40, added_at: expect.any(String) },
    ]);
  });

  it("rejects a non-positive weight", async () => {
    const user = userEvent.setup();
    renderEditor();

    const weightInput = screen.getByLabelText("Weight %");
    await user.clear(weightInput);
    await user.type(weightInput, "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/weight must be a positive number/)).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
