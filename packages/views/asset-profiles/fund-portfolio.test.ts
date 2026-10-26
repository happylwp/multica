// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFundPortfolio, portfolioTotals } from "./fund-portfolio";

const fund = {
  code: "161716",
  name: "招商双债增强",
  market_value: 41175.31,
  cost_amount: 39571,
  cum_pnl: 1604.3,
};

describe("parseFundPortfolio", () => {
  it("accepts a full portfolio document and strips unknown fields", () => {
    const parsed = parseFundPortfolio({
      funds: [fund, { ...fund, code: "000307", cum_pnl: -608.71 }],
      totals: { market_value: 100, cost_amount: 90, cum_pnl: 10, pnl_pct: 11.1 },
      structure_pct: { gold: 12 },
      plans: [{ day: 15, code: "000307", amount: 1800 }],
      rules: { gold_ceiling: "20%" },
      extra_field: true,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.funds).toHaveLength(2);
    expect(parsed?.rules?.gold_ceiling).toBe("20%");
    expect(parsed).not.toHaveProperty("extra_field");
  });

  it("fills missing optional fund fields with defaults", () => {
    const parsed = parseFundPortfolio({ funds: [{ code: "1", name: "n" }] });

    expect(parsed?.funds[0]?.type).toBe("");
    expect(parsed?.funds[0]?.market_value).toBe(0);
    expect(parsed?.structure_pct).toEqual({});
    expect(parsed?.plans).toEqual([]);
  });

  it("rejects documents that are not fund portfolios", () => {
    expect(parseFundPortfolio({ hello: "world" })).toBeNull();
    expect(parseFundPortfolio({ funds: [] })).toBeNull();
    expect(parseFundPortfolio("not an object")).toBeNull();
    expect(parseFundPortfolio(null)).toBeNull();
  });

  it("recovers when optional sections have the wrong type", () => {
    const parsed = parseFundPortfolio({
      funds: [fund],
      structure_pct: "oops",
      plans: 3,
    });

    expect(parsed?.structure_pct).toEqual({});
    expect(parsed?.plans).toEqual([]);
  });
});

describe("portfolioTotals", () => {
  it("prefers stored totals", () => {
    const parsed = parseFundPortfolio({
      funds: [fund],
      totals: { market_value: 1, cost_amount: 2, cum_pnl: 3, pnl_pct: 4 },
    });

    expect(portfolioTotals(parsed!)).toEqual({
      market_value: 1,
      cost_amount: 2,
      cum_pnl: 3,
      pnl_pct: 4,
    });
  });

  it("recomputes missing totals from the funds", () => {
    const parsed = parseFundPortfolio({ funds: [fund] });
    const totals = portfolioTotals(parsed!);

    expect(totals.market_value).toBeCloseTo(41175.31);
    expect(totals.cost_amount).toBe(39571);
    expect(totals.cum_pnl).toBeCloseTo(1604.3);
    expect(totals.pnl_pct).toBeCloseTo((1604.3 / 39571) * 100, 5);
  });
});
