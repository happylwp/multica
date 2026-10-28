// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";
import { parseFundPortfolio } from "../fund-portfolio";
import { FundPortfolioDashboard } from "./fund-portfolio-dashboard";

const mockGold = vi.hoisted(() => vi.fn());
mockGold.mockResolvedValue({ comex: null, sge: null });
vi.mock("../eastmoney", () => ({ fetchGoldQuotes: mockGold }));

// The dashboard is a pure view over the parsed document — parsing matrices
// live in fund-portfolio.test.ts, so here we assert the wiring: KPI values
// land on their labels, holdings/plans/rules render, and unknown structure
// buckets degrade to the raw key.
const PORTFOLIO_DOC = {
  funds: [
    {
      code: "161716",
      name: "Dual bond",
      type: "bond",
      market_value: 41175.31,
      cost_amount: 39571,
      cum_pnl: 1604.3,
      cost_price: 1.587,
      shares: 24935.09,
    },
    {
      code: "000307",
      name: "Gold feeder",
      type: "gold",
      market_value: 15191.9,
      cost_amount: 15800.2,
      cum_pnl: -608.71,
      cost_price: 2.9995,
      shares: 5267.62,
    },
  ],
  totals: { market_value: 56367.21, cost_amount: 55371.2, cum_pnl: 995.59, pnl_pct: 1.8 },
  structure_pct: { gold: 27, fixed_income: 73 },
  plans: [{ day: 15, code: "000307", amount: 1800, note: "monthly gold" }],
  rules: { gold_ceiling: "20%" },
  updated_at: "2026-10-23",
};

const TEST_RESOURCES = {
  en: { common: enCommon, assets: enAssets },
};

function renderDashboard(doc: unknown) {
  const portfolio = parseFundPortfolio(doc)!;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <FundPortfolioDashboard portfolio={portfolio} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("FundPortfolioDashboard", () => {
  it("renders KPIs, holdings, plans, and rules from the document", () => {
    renderDashboard(PORTFOLIO_DOC);

    // KPI card and donut centre both render the market value.
    expect(screen.getAllByText("¥56,367").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("+¥995.59")).toBeTruthy();
    expect(screen.getByText("+1.80%")).toBeTruthy();

    // Fund names appear in the donut legend and the holding card; the code
    // badge identifies the holding card.
    expect(screen.getAllByText("Dual bond").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Gold feeder").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("161716")).toBeTruthy();

    // Plans and rules sections.
    expect(screen.getByText("monthly gold")).toBeTruthy();
    expect(screen.getByText("gold_ceiling")).toBeTruthy();
  });

  it("labels known structure buckets and falls back to the raw key", () => {
    renderDashboard({
      funds: [{ code: "1", name: "n" }],
      structure_pct: { gold: 30, crypto: 5 },
    });

    expect(screen.getByText("Gold")).toBeTruthy();
    expect(screen.getByText("crypto")).toBeTruthy();
  });

  it("renders the daily P&L chart with the window summary", () => {
    renderDashboard({
      ...PORTFOLIO_DOC,
      daily_pnl: [
        { date: "2026-10-22", per_fund: { "161716": 67.32 }, total: 67.32 },
        { date: "2026-10-23", per_fund: { "161716": -100 }, total: -100 },
      ],
    });

    expect(screen.getByText("Daily P&L")).toBeTruthy();
    expect(screen.getByText("Last 2 trading days · ¥-32.68")).toBeTruthy();
  });

  it("omits the daily P&L chart when the document has no history", () => {
    renderDashboard(PORTFOLIO_DOC);

    expect(screen.queryByText("Daily P&L")).toBeNull();
  });

  it("keeps holding cards clickable when profile snapshots are present", () => {
    renderDashboard({
      ...PORTFOLIO_DOC,
      fund_details: {
        "161716": {
          name: "招商双债增强债券(LOF)C",
          returns: { m1: -0.36, m3: 0.22, m6: 1.43, y1: 2.9 },
          fee: { source: 0.8, current: 0.08 },
          manager: { name: "刘万锋", star: 5, workTime: "11年", fundSize: "418.60亿" },
          allocation: { date: "2026-06-30", stock: 6.35, bond: 101, cash: 3.1 },
          scale: { date: "2026-06-30", value: 56.77 },
          trend: [{ d: "10-20", v: 1.79 }, { d: "10-23", v: 1.793 }],
          fetched_at: "2026-10-23",
        },
      },
    });

    // Holding card still renders inside the detail-dialog trigger.
    expect(screen.getAllByText("Dual bond").length).toBeGreaterThanOrEqual(2);
  });
});

describe("FundPortfolioDashboard watchlist", () => {
  it("renders the watchlist card with cumulative returns per fund", () => {
    renderDashboard({
      ...PORTFOLIO_DOC,
      watchlist: {
        name: "trial",
        funds: [
          { code: "510300", name: "沪深300ETF", weight: 60, added_at: "2026-10-20" },
          { code: "512890", name: "红利低波ETF", weight: 40, added_at: "2026-10-20" },
        ],
        baseline: "2026-10-20",
      },
      watchlist_pnl: [
        { date: "2026-10-23", per_fund_pct: { "510300": 1.44, "512890": 0.3 }, weighted_pct: 0.98, cum_pct: 0.98 },
        { date: "2026-10-26", per_fund_pct: { "510300": -0.03 }, weighted_pct: -0.03, cum_pct: 0.95 },
      ],
    });

    expect(screen.getByText("Watchlist")).toBeTruthy();
    expect(screen.getByText("trial")).toBeTruthy();
    expect(screen.getByText("Since 2026-10-20 · 2 days · cum +0.95%")).toBeTruthy();
    // per-fund compounded return since baseline (510300: 1.0144×0.9997−1 ≈ 1.41%)
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText("+1.41%")).toBeTruthy();
  });

  it("omits the watchlist card when there is no watchlist data", () => {
    renderDashboard(PORTFOLIO_DOC);

    expect(screen.queryByText("Watchlist")).toBeNull();
  });
});

describe("FundPortfolioDashboard gold reference", () => {
  it("renders live COMEX and SGE quotes with the gold holding's NAV", async () => {
    mockGold.mockResolvedValue({
      comex: {
        name: "COMEX黄金",
        price: 4008.1,
        prevClose: 4038.4,
        change: -30.3,
        changePct: -0.75,
        time: 1793090386000,
      },
      sge: {
        name: "黄金9999",
        price: 860.31,
        prevClose: 861.41,
        change: -1.1,
        changePct: -0.13,
        time: 1793087100000,
      },
    });
    renderDashboard({
      ...PORTFOLIO_DOC,
      fund_details: { "000307": { trend: [{ d: "10-26", v: 2.8305 }] } },
    });

    expect(await screen.findByText("4008.1 USD/oz")).toBeTruthy();
    expect(screen.getByText("860.31 CNY/g")).toBeTruthy();
    expect(screen.getByText("-30.3 (-0.75%)")).toBeTruthy();
    expect(screen.getByText(/Latest NAV 2.8305/)).toBeTruthy();
  });

  it("hides the card entirely when both quotes fail", async () => {
    mockGold.mockResolvedValue({ comex: null, sge: null });
    renderDashboard(PORTFOLIO_DOC);

    // give the query a tick to settle before asserting absence
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Gold reference")).toBeNull();
  });
});
