import { z } from "zod";

// The fund-portfolio document is the one well-known asset-profile `data`
// shape (see the asset-mgmt workspace baseline, ASSE-3). The profile
// contract keeps `data` opaque, so detection stays best-effort: parse
// returns null for any other document and the detail page falls back to
// the raw JSON view. Unknown fields are stripped, not rejected — the
// document is maintained by hand and grows new annotations over time.
const fundSchema = z.object({
  code: z.string(),
  name: z.string(),
  // catch (not optional().catch()) so missing fields fall back to the
  // default instead of surfacing as undefined downstream.
  type: z.string().catch(""),
  shares: z.number().catch(0),
  cum_pnl: z.number().catch(0),
  in_flight: z.number().catch(0),
  cost_price: z.number().catch(0),
  cost_amount: z.number().catch(0),
  market_value: z.number().catch(0),
  note: z.string().optional(),
});

const planSchema = z.object({
  day: z.number(),
  code: z.string(),
  kind: z.string().catch(""),
  amount: z.number(),
  note: z.string().optional(),
});

const totalsSchema = z.object({
  market_value: z.number().optional(),
  cost_amount: z.number().optional(),
  cum_pnl: z.number().optional(),
  pnl_pct: z.number().optional(),
});

// One entry per trading day, appended by the daily nav-sync job. per_fund
// maps fund code to that day's realized gain/loss in CNY; per_fund_pct is
// the same day's cumulative-NAV return in percent (dividend-reinvested,
// matching the CNY figure).
const dailyPnlSchema = z.object({
  date: z.string(),
  per_fund: z.record(z.string(), z.number()).catch({}),
  per_fund_pct: z.record(z.string(), z.number()).catch({}),
  total: z.number().catch(0),
  source: z.string().optional(),
});

// Fund profile snapshot from fund.eastmoney.com, refreshed daily by the
// nav-sync job alongside the positions. Every field is nullable: East Money
// publishes profile vars per fund class and any one can be absent.
const nullableNumber = z.number().nullable().catch(null);
const fundDetailSchema = z.object({
  name: z.string().nullable().catch(null),
  returns: z
    .object({ m1: nullableNumber, m3: nullableNumber, m6: nullableNumber, y1: nullableNumber })
    .catch({ m1: null, m3: null, m6: null, y1: null }),
  fee: z.object({ source: nullableNumber, current: nullableNumber }).catch({ source: null, current: null }),
  manager: z
    .object({
      name: z.string().nullable().catch(null),
      star: nullableNumber,
      workTime: z.string().nullable().catch(null),
      fundSize: z.string().nullable().catch(null),
    })
    .nullable()
    .catch(null),
  allocation: z
    .object({
      date: z.string().nullable().catch(null),
      stock: nullableNumber,
      bond: nullableNumber,
      cash: nullableNumber,
      fund: nullableNumber,
      other: nullableNumber,
      net_asset: nullableNumber,
    })
    .nullable()
    .catch(null),
  // Holdings disclosed in the latest report (East Money mobile F10 API):
  // top-10 stocks, top bonds, FOF sub-funds, and the target ETF for feeder
  // funds. All three lists can be empty — bond funds disclose no stocks and
  // equity funds no sub-funds.
  positions: z
    .object({
      stocks: z
        .array(
          z.object({
            code: z.string().nullable().catch(null),
            name: z.string().nullable().catch(null),
            pct: nullableNumber,
            sector: z.string().nullable().catch(null),
            chg_type: z.string().nullable().catch(null),
            chg: nullableNumber,
          }),
        )
        .catch([]),
      bonds: z
        .array(z.object({ code: z.string().nullable().catch(null), name: z.string().nullable().catch(null), pct: nullableNumber }))
        .catch([]),
      funds: z
        .array(z.object({ code: z.string().nullable().catch(null), name: z.string().nullable().catch(null), pct: nullableNumber }))
        .catch([]),
      etf: z
        .object({ code: z.string().nullable().catch(null), name: z.string().nullable().catch(null) })
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
  scale: z.object({ date: z.string().nullable().catch(null), value: nullableNumber }).nullable().catch(null),
  trend: z.array(z.object({ d: z.string().catch(""), v: z.number().catch(0) })).catch([]),
  fetched_at: z.string().catch(""),
});

// Watchlist: a virtual portfolio independent of the real holdings. Weights
// are user-defined percentages; the daily sync rebuilds the weighted return
// series from `baseline` on every run.
const watchlistFundSchema = z.object({
  code: z.string(),
  name: z.string().catch(""),
  weight: z.number().catch(0),
  added_at: z.string().catch(""),
});

const watchlistSchema = z
  .object({
    name: z.string().catch(""),
    funds: z.array(watchlistFundSchema).catch([]),
    baseline: z.string().catch(""),
  })
  .nullable()
  .catch(null);

const watchlistPnlSchema = z.object({
  date: z.string(),
  per_fund_pct: z.record(z.string(), z.number()).catch({}),
  weighted_pct: z.number().catch(0),
  cum_pct: z.number().catch(0),
});

export const fundPortfolioSchema = z.object({
  funds: z.array(fundSchema).min(1),
  totals: totalsSchema.optional(),
  structure_pct: z.record(z.string(), z.number()).catch({}),
  plans: z.array(planSchema).catch([]),
  rules: z.record(z.string(), z.string()).catch({}),
  daily_pnl: z.array(dailyPnlSchema).catch([]),
  fund_details: z.record(z.string(), fundDetailSchema).catch({}),
  watchlist: watchlistSchema,
  watchlist_pnl: z.array(watchlistPnlSchema).catch([]),
  note: z.string().optional(),
  data_source: z.string().optional(),
  updated_at: z.string().optional(),
});

export type FundPosition = z.infer<typeof fundSchema>;
export type FundPlan = z.infer<typeof planSchema>;
export type FundDailyPnl = z.infer<typeof dailyPnlSchema>;
export type FundDetail = z.infer<typeof fundDetailSchema>;
export type WatchlistFund = z.infer<typeof watchlistFundSchema>;
export type WatchlistPnl = z.infer<typeof watchlistPnlSchema>;
export type FundPortfolio = z.infer<typeof fundPortfolioSchema>;

export function parseFundPortfolio(data: unknown): FundPortfolio | null {
  const result = fundPortfolioSchema.safeParse(data);
  return result.success ? result.data : null;
}

// Totals can lag the positions in a hand-edited document; recompute any
// missing field from the funds rather than showing blanks.
export function portfolioTotals(portfolio: FundPortfolio) {
  const sum = (pick: (f: FundPosition) => number) =>
    portfolio.funds.reduce((acc, f) => acc + pick(f), 0);
  const market_value =
    portfolio.totals?.market_value ?? sum((f) => f.market_value);
  const cost_amount = portfolio.totals?.cost_amount ?? sum((f) => f.cost_amount);
  const cum_pnl = portfolio.totals?.cum_pnl ?? sum((f) => f.cum_pnl);
  const pnl_pct =
    portfolio.totals?.pnl_pct ??
    (cost_amount > 0 ? (cum_pnl / cost_amount) * 100 : 0);
  return { market_value, cost_amount, cum_pnl, pnl_pct };
}
