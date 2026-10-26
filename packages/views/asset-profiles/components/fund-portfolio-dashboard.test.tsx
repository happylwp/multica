// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAssets from "../../locales/en/assets.json";
import { parseFundPortfolio } from "../fund-portfolio";
import { FundPortfolioDashboard } from "./fund-portfolio-dashboard";

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
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <FundPortfolioDashboard portfolio={portfolio} />
    </I18nProvider>,
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
});
