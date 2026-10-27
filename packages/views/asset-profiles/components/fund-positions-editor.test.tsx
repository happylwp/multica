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
const mockFetchQuery = vi.hoisted(() => vi.fn());

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
  queryOptions: (o: unknown) => o,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), fetchQuery: mockFetchQuery }),
}));
vi.mock("@multica/core/api", () => ({ api: { updateAssetProfile: mockUpdate } }));
vi.mock("../eastmoney", () => ({ fetchEastMoneyFund: mockFetch }));

import { FundPositionsEditorDialog } from "./fund-positions-editor";

const TEST_RESOURCES = { en: { common: enCommon, assets: enAssets } };

const PROFILE = {
  id: "profile-1",
  name: "Portfolio archive",
  description: "",
  created_at: "",
  updated_at: "",
  data: {
    funds: [
      {
        code: "161716",
        name: "Dual bond",
        type: "bond",
        shares: 1000,
        cost_price: 1.5,
        cost_amount: 1500,
        market_value: 1654,
        in_flight: 0,
        cum_pnl: 154,
      },
    ],
    totals: { market_value: 1654, cost_amount: 1500, cum_pnl: 154, pnl_pct: 10.27 },
  },
} as unknown as AssetProfile;

function renderEditor(profile = PROFILE) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <FundPositionsEditorDialog wsId="ws-1" profile={profile} onClose={vi.fn()} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FundPositionsEditorDialog", () => {
  it("renders one editable row per fund", () => {
    renderEditor();

    expect(screen.getByDisplayValue("Dual bond")).toBeTruthy();
    expect(screen.getByText("161716")).toBeTruthy();
  });

  it("rejects a non-6-digit code before hitting East Money", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("Fund code"), "1617");
    await user.click(screen.getByRole("button", { name: "Fetch" }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a 6-digit fund code")).toBeTruthy();
  });

  it("pulls a new fund from East Money and prefills name and market value", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      code: "000307",
      name: "易方达黄金ETF联接A",
      nav: 2.8305,
      navDate: "2026-10-23",
      returns: { m1: -7.55, m3: null, m6: null, y1: -8.66 },
    });
    renderEditor();

    await user.type(screen.getByLabelText("Fund code"), "000307");
    await user.click(screen.getByRole("button", { name: "Fetch" }));

    expect(await screen.findByDisplayValue("易方达黄金ETF联接A")).toBeTruthy();
    expect(screen.getByText("000307")).toBeTruthy();

    // market value auto-fills from shares × fetched NAV
    const sharesInputs = screen.getAllByLabelText("Shares");
    const newShares = sharesInputs.at(-1)!;
    await user.clear(newShares);
    await user.type(newShares, "1000");
    const mvInput = screen.getAllByLabelText("Market value").at(-1)!;
    expect(mvInput).toHaveValue("2830.50");
  });

  it("saves with recomputed totals and preserves the rest of the document", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({});
    // the server document carries server-generated sections newer than the
    // cached page data; the save must merge onto them, not clobber them
    const serverPnl = [{ date: "2026-10-26", per_fund: { "161716": 1.2 }, total: 1.2 }];
    mockFetchQuery.mockResolvedValue({ ...PROFILE, data: { ...PROFILE.data, daily_pnl: serverPnl } });
    renderEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, payload] = mockUpdate.mock.calls[0]!;
    expect(id).toBe("profile-1");
    // unchanged single fund; totals recomputed from the same numbers
    expect(payload.data.funds).toHaveLength(1);
    expect(payload.data.funds[0]).toMatchObject({ code: "161716", market_value: 1654 });
    expect(payload.data.totals).toEqual({
      market_value: 1654,
      cost_amount: 1500,
      cum_pnl: 154,
      pnl_pct: 10.27,
    });
    // server-generated section from the fresh document survives the save
    expect(payload.data.daily_pnl).toBe(serverPnl);
  });
});
