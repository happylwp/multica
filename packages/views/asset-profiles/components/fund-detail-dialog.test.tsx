// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";
import type { FundDetail, FundPosition } from "../fund-portfolio";
import { FundDetailDialog } from "./fund-detail-dialog";

// The dialog is uncontrolled: clicking the trigger card opens it, and the
// allocation buckets with disclosed holdings expand a detail panel.
const TEST_RESOURCES = { en: { common: enCommon, assets: enAssets } };

const FUND: FundPosition = {
  code: "161716",
  name: "Dual bond",
  type: "bond",
  shares: 24935.09,
  cost_price: 1.587,
  cost_amount: 39571,
  market_value: 41175.31,
  in_flight: 0,
  cum_pnl: 1604.3,
};

const DETAIL = {
  name: "招商双债增强债券(LOF)C",
  returns: { m1: -0.36, m3: 0.22, m6: 1.43, y1: 2.9 },
  fee: { source: 0.8, current: 0.08 },
  manager: null,
  allocation: { date: "2026-06-30", stock: 6.35, bond: 101, cash: 3.1, fund: null, other: 0, net_asset: 60.03 },
  positions: {
    stocks: [
      { code: "688019", name: "安集科技", pct: 1.32, sector: "电子", chg_type: "增持", chg: 0.32 },
      { code: "300483", name: "首华燃气", pct: 1.12, sector: "公用事业", chg_type: "减持", chg: -0.15 },
    ],
    bonds: [{ code: "242400033", name: "24广发银行永续债02", pct: 6.9 }],
    funds: [],
    etf: null,
  },
  scale: null,
  trend: [{ d: "10-23", v: 1.793 }],
  fetched_at: "2026-10-26",
} as unknown as FundDetail;

function renderDialog(detail: FundDetail = DETAIL) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <FundDetailDialog
        fund={FUND}
        detail={detail}
        dailyPnl={[]}
        weight={42.7}
        delay={0}
        trigger={<div>holding card</div>}
      />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("FundDetailDialog allocation buckets", () => {
  it("shows all five buckets including the fund bucket", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "holding card" }));

    expect(screen.getByText("Stock")).toBeTruthy();
    expect(screen.getByText("Bond")).toBeTruthy();
    expect(screen.getByText("Cash")).toBeTruthy();
    expect(screen.getByText("Funds")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.getByText("101.00%")).toBeTruthy(); // bond bucket weight
  });

  it("expands stock holdings when the stock bucket is clicked", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "holding card" }));
    const stockBucket = screen.getByText("Stock").closest("button")!;
    await user.click(stockBucket);

    expect(screen.getByText("Top 10 stock holdings")).toBeTruthy();
    expect(screen.getByText("安集科技")).toBeTruthy();
    expect(screen.getByText("增持")).toBeTruthy();
    // clicking again collapses
    await user.click(stockBucket);
    expect(screen.queryByText("Top 10 stock holdings")).toBeNull();
  });

  it("shows the target ETF under the fund bucket for feeder funds", async () => {
    const user = userEvent.setup();
    renderDialog({
      ...DETAIL,
      allocation: { date: "2026-06-30", stock: null, bond: 2.96, cash: 3.26, fund: 92.5, other: 1.28, net_asset: 256.84 },
      positions: { stocks: [], bonds: [], funds: [], etf: { code: "159934", name: "黄金ETF易方达" } },
    });

    await user.click(screen.getByRole("button", { name: "holding card" }));
    await user.click(screen.getByText("92.50%").closest("button")!);

    expect(screen.getByText("黄金ETF易方达")).toBeTruthy();
    expect(screen.getByText("Target ETF")).toBeTruthy();
  });
});
