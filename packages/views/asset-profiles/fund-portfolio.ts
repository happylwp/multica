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

export const fundPortfolioSchema = z.object({
  funds: z.array(fundSchema).min(1),
  totals: totalsSchema.optional(),
  structure_pct: z.record(z.string(), z.number()).catch({}),
  plans: z.array(planSchema).catch([]),
  rules: z.record(z.string(), z.string()).catch({}),
  note: z.string().optional(),
  data_source: z.string().optional(),
  updated_at: z.string().optional(),
});

export type FundPosition = z.infer<typeof fundSchema>;
export type FundPlan = z.infer<typeof planSchema>;
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
