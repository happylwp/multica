// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFundPortfolio, portfolioTotals, watchlistFundSeries } from "./fund-portfolio";

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
      daily_pnl: [
        { date: "2026-10-22", per_fund: { "161716": 67.32 }, per_fund_pct: { "161716": 0.15 }, total: 67.32, source: "user_app" },
      ],
      extra_field: true,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.funds).toHaveLength(2);
    expect(parsed?.rules?.gold_ceiling).toBe("20%");
    expect(parsed?.daily_pnl).toEqual([
      { date: "2026-10-22", per_fund: { "161716": 67.32 }, per_fund_pct: { "161716": 0.15 }, total: 67.32, source: "user_app" },
    ]);
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
      daily_pnl: [{ date: "2026-10-22", total: "oops" }],
    });

    expect(parsed?.structure_pct).toEqual({});
    expect(parsed?.plans).toEqual([]);
    expect(parsed?.daily_pnl).toEqual([
      { date: "2026-10-22", per_fund: {}, per_fund_pct: {}, total: 0 },
    ]);
  });

  it("keeps a pending plan whose deduction day is not yet set", () => {
    const parsed = parseFundPortfolio({
      funds: [fund],
      plans: [
        { day: 15, code: "000307", amount: 900, effective_from: "2026-11" },
        { day: null, code: "022460", amount: 1800, status: "pending_activation" },
      ],
    });

    expect(parsed?.plans).toEqual([
      { day: 15, code: "000307", kind: "", amount: 900, effective_from: "2026-11" },
      { day: null, code: "022460", kind: "", amount: 1800, status: "pending_activation" },
    ]);
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

describe("watchlist", () => {
  it("parses the virtual portfolio and its weighted return series", () => {
    const p = parseFundPortfolio({
      funds: [{ code: "1", name: "n" }],
      watchlist: {
        name: "test",
        funds: [{ code: "510300", name: "沪深300ETF", weight: 40, added_at: "2026-10-26" }],
        baseline: "2026-10-26",
      },
      watchlist_pnl: [
        { date: "2026-10-27", per_fund_pct: { "510300": 0.5 }, weighted_pct: 0.5, cum_pct: 0.5 },
      ],
    })!;

    expect(p.watchlist?.funds[0]).toMatchObject({ code: "510300", weight: 40 });
    expect(p.watchlist_pnl[0]).toMatchObject({ weighted_pct: 0.5, cum_pct: 0.5 });
  });

  it("degrades a malformed watchlist to null with empty returns", () => {
    const p = parseFundPortfolio({
      funds: [{ code: "1", name: "n" }],
      watchlist: "oops",
      watchlist_pnl: [{ date: "d", per_fund_pct: { x: 1 }, weighted_pct: "x" }],
    })!;

    expect(p.watchlist).toBeNull();
    expect(p.watchlist_pnl[0]).toMatchObject({ weighted_pct: 0, cum_pct: 0 });
  });

  it("compounds a per-fund series and skips unpublished days", () => {
    const series = watchlistFundSeries(
      [
        { date: "2026-10-26", per_fund_pct: { "510300": 1.44, other: 2 }, weighted_pct: 1.5, cum_pct: 1.5 },
        { date: "2026-10-27", per_fund_pct: { other: 0.5 }, weighted_pct: 0.5, cum_pct: 2.0 },
        { date: "2026-10-28", per_fund_pct: { "510300": -1 }, weighted_pct: -1, cum_pct: 0.4 },
      ],
      "510300",
    );

    // 1.0144 × 0.99 − 1 ≈ 0.43%; the 10-27 entry (no 510300 NAV) is dropped.
    expect(series).toEqual([
      { date: "2026-10-26", daily: 1.44, cum: 1.44 },
      { date: "2026-10-28", daily: -1, cum: 0.43 },
    ]);
  });

  it("parses trades and the ledger simulation, defaulting absent fields", () => {
    const p = parseFundPortfolio({
      funds: [{ code: "1", name: "n" }],
      watchlist: {
        name: "test",
        funds: [{ code: "510300", name: "沪深300ETF", weight: 100, added_at: "2026-10-26" }],
        baseline: "2026-10-26",
        trades: [{ id: "t1", code: "510300", date: "2026-10-27", side: "buy", amount: 10000, fee_pct: 0.1 }],
      },
      watch_ledger: {
        daily: [{ date: "2026-10-27", mv: 9990, invested: 10000 }],
        summary: {
          start_date: "2026-10-27",
          end_date: "2026-10-27",
          trade_count: 1,
          irr_pct: null,
          per_fund: [{ code: "510300" }],
        },
      },
    })!;

    expect(p.watchlist?.trades[0]).toMatchObject({ side: "buy", amount: 10000, fee_pct: 0.1 });
    // Ledger rows fill defaults; a short XIRR span stays null.
    expect(p.watch_ledger?.daily[0]).toMatchObject({ daily_pnl: 0, pnl_pct: 0, ret_pct: 0 });
    expect(p.watch_ledger?.summary?.irr_pct).toBeNull();
    expect(p.watch_ledger?.summary?.per_fund[0]).toMatchObject({ shares: 0, weight: 0 });
  });

  it("keeps weight mode when no ledger has been synced", () => {
    const p = parseFundPortfolio({
      funds: [{ code: "1", name: "n" }],
      watchlist: { name: "test", funds: [{ code: "510300", name: "x", weight: 100, added_at: "" }], baseline: "b" },
      watch_ledger: "oops",
    })!;

    expect(p.watchlist?.trades).toEqual([]);
    expect(p.watch_ledger).toBeNull();
  });
});
