"use client";

import { useQuery } from "@tanstack/react-query";
import { motion, MotionConfig } from "motion/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  CalendarDays,
  Coins,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  ScrollText,
  TrendingUp,
} from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@multica/ui/components/ui/chart";
import { useT } from "../../i18n";
import {
  portfolioTotals,
  watchlistFundSeries,
  type FundDailyPnl,
  type FundPortfolio,
  type WatchlistPnl,
} from "../fund-portfolio";
import { fetchGoldQuotes, type GoldQuote } from "../eastmoney";
import { AnimatedNumber } from "./animated-number";
import { FundDetailDialog } from "./fund-detail-dialog";
import { FundWatchlistFundDialog } from "./fund-watchlist-fund-dialog";

// CN market convention: red = gain, green = loss. Both stops stay readable
// in light and dark themes.
const PNL_POSITIVE = "#ef4444";
const PNL_NEGATIVE = "#10b981";
const STRUCTURE_COLORS: Record<string, string> = {
  gold: "#eab308",
  fixed_income: "var(--chart-2)",
  equity_dividend: "var(--chart-1)",
};

const STRUCTURE_LABELS: Record<
  string,
  "structure_gold" | "structure_fixed_income" | "structure_equity_dividend"
> = {
  gold: "structure_gold",
  fixed_income: "structure_fixed_income",
  equity_dividend: "structure_equity_dividend",
};

const emptyChartConfig = {} satisfies ChartConfig;

function formatCNY(v: number, decimals = 2) {
  const digits =
    decimals === 0
      ? { maximumFractionDigits: 0, minimumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const formatted = v.toLocaleString(undefined, digits);
  return `¥${formatted}`;
}

function formatPnL(v: number) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${formatCNY(v)}`;
}

function formatPct(v: number) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.35, ease: "easeOut" as const },
});

// One gold quote line: label + price with unit + colored change. Hidden
// when that leg failed to load — the card shows whatever arrived.
function GoldRow({
  label,
  unit,
  quote,
  digits,
}: {
  label: string;
  unit: string;
  quote: GoldQuote | null;
  digits: number;
}) {
  if (!quote) return null;
  const up = quote.change >= 0;
  const tone = up ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono text-caption tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="font-medium">
          {quote.price.toFixed(digits)} {unit}
        </span>
        <span className={tone}>
          {up ? "+" : ""}
          {quote.change.toFixed(digits)} ({up ? "+" : ""}
          {quote.changePct}%)
        </span>
      </span>
    </div>
  );
}

/**
 * Visual dashboard for fund-portfolio documents. Sections enter with a
 * staggered rise; charts use their built-in draw animations. All motion
 * respects the OS reduced-motion preference via MotionConfig.
 */
export function FundPortfolioDashboard({
  portfolio,
}: {
  portfolio: FundPortfolio;
}) {
  const { t } = useT("assets");
  const totals = portfolioTotals(portfolio);

  const donutData = portfolio.funds.map((f, i) => ({
    code: f.code,
    name: f.name,
    value: f.market_value,
    fill: `var(--chart-${(i % 5) + 1})`,
    weight: totals.market_value > 0 ? (f.market_value / totals.market_value) * 100 : 0,
  }));

  const pnlData = portfolio.funds.map((f) => ({
    code: f.code,
    name: f.name,
    pnl: f.cum_pnl,
    fill: f.cum_pnl >= 0 ? PNL_POSITIVE : PNL_NEGATIVE,
  }));

  const structureEntries = Object.entries(portfolio.structure_pct);
  const plans = portfolio.plans;
  const rules = Object.entries(portfolio.rules);

  // Daily P&L arrives oldest-first from the nav-sync job; cap the chart at
  // the most recent 30 trading days.
  const nameByCode = new Map(portfolio.funds.map((f) => [f.code, f.name]));
  const dailyPnlWindow = portfolio.daily_pnl.slice(-30);
  const dailyPnlSum = dailyPnlWindow.reduce((acc, d) => acc + d.total, 0);
  const watchlist = portfolio.watchlist;
  const watchlistPnl = portfolio.watchlist_pnl;
  const watchlistLast = watchlistPnl.length > 0 ? watchlistPnl[watchlistPnl.length - 1] : null;
  const watchlistCum = watchlistLast?.cum_pct ?? 0;
  // Per-fund cumulative return and full daily series since baseline
  // (compounded from daily pcts); the series feeds the per-fund dialogs.
  const watchlistSeriesByCode = new Map<string, { date: string; daily: number; cum: number }[]>();
  const watchlistCumByCode = new Map<string, number>();
  if (watchlist) {
    for (const wf of watchlist.funds) {
      const series = watchlistFundSeries(watchlistPnl, wf.code);
      watchlistSeriesByCode.set(wf.code, series);
      watchlistCumByCode.set(wf.code, series.at(-1)?.cum ?? 0);
    }
  }
  // Config vs series drift: funds added/removed since the last NAV sync
  // leave the curve on the old composition — flag it instead of showing
  // stale data as if current.
  const watchlistStale =
    watchlist != null &&
    (() => {
      const pnlCodes = new Set<string>();
      for (const d of watchlistPnl) {
        for (const c of Object.keys(d.per_fund_pct)) pnlCodes.add(c);
      }
      const configCodes = new Set(watchlist.funds.map((wf) => wf.code));
      return (
        [...configCodes].some((c) => !pnlCodes.has(c)) ||
        [...pnlCodes].some((c) => !configCodes.has(c))
      );
    })();

  // Live gold reference (COMEX futures + SGE AU9999) next to the gold
  // holding; refetches on window focus, 30s staleness keeps it near-live.
  const gold = useQuery({
    queryKey: ["goldQuotes"],
    queryFn: fetchGoldQuotes,
    staleTime: 30_000,
    retry: 1,
  });
  const goldEtfNav = portfolio.fund_details["000307"]?.trend.at(-1);
  const goldUpdated = [gold.data?.comex, gold.data?.sge].find((q) => q && q.time > 0);

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-4">
        <p className="text-caption text-muted-foreground">
          {t(($) => $.dashboard.fund_count, { n: portfolio.funds.length })}
          {portfolio.updated_at ? ` · ${portfolio.updated_at}` : ""}
        </p>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <motion.div {...rise(0)}>
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardDescription>{t(($) => $.dashboard.market_value)}</CardDescription>
                <CardTitle>
                  <AnimatedNumber value={totals.market_value} format={(v) => formatCNY(v, 0)} />
                </CardTitle>
              </CardHeader>
            </Card>
          </motion.div>
          <motion.div {...rise(0.07)}>
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardDescription>{t(($) => $.dashboard.cost_amount)}</CardDescription>
                <CardTitle>
                  <AnimatedNumber value={totals.cost_amount} format={(v) => formatCNY(v, 0)} />
                </CardTitle>
              </CardHeader>
            </Card>
          </motion.div>
          <motion.div {...rise(0.14)}>
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardDescription>{t(($) => $.dashboard.cum_pnl)}</CardDescription>
                <CardTitle
                  className={
                    totals.cum_pnl >= 0
                      ? "text-red-500 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  <AnimatedNumber value={totals.cum_pnl} format={formatPnL} />
                </CardTitle>
              </CardHeader>
            </Card>
          </motion.div>
          <motion.div {...rise(0.21)}>
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardDescription>{t(($) => $.dashboard.pnl_pct)}</CardDescription>
                <CardTitle
                  className={
                    totals.pnl_pct >= 0
                      ? "text-red-500 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  <AnimatedNumber value={totals.pnl_pct} format={formatPct} />
                </CardTitle>
              </CardHeader>
            </Card>
          </motion.div>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <motion.div {...rise(0.28)} className="lg:col-span-3">
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <PieChartIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  {t(($) => $.dashboard.allocation)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-4 sm:flex-row">
                <div className="relative mx-auto shrink-0">
                  <ChartContainer
                    config={emptyChartConfig}
                    className="mx-auto aspect-square max-h-[240px] w-[240px]"
                  >
                    <PieChart>
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            hideLabel
                            formatter={(value, _name, item) => {
                              const row = item?.payload as (typeof donutData)[number] | undefined;
                              const weight = row ? ` · ${row.weight.toFixed(1)}%` : "";
                              return `${row?.name ?? ""}: ${formatCNY(Number(value))}${weight}`;
                            }}
                          />
                        }
                      />
                      <Pie
                        data={donutData}
                        dataKey="value"
                        nameKey="code"
                        innerRadius="62%"
                        outerRadius="92%"
                        paddingAngle={2}
                        strokeWidth={0}
                      >
                        {donutData.map((d) => (
                          <Cell key={d.code} fill={d.fill} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ChartContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.dashboard.market_value)}
                    </span>
                    <span className="font-heading text-title-sm font-medium">
                      {formatCNY(totals.market_value, 0)}
                    </span>
                  </div>
                </div>
                <ul className="flex w-full min-w-0 flex-col gap-1.5">
                  {donutData.map((d) => (
                    <li key={d.code} className="flex items-center gap-2 text-caption">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: d.fill }}
                      />
                      <span className="min-w-0 flex-1 truncate" title={d.name}>
                        {d.name}
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                        {d.weight.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div {...rise(0.35)} className="lg:col-span-2">
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardTitle>{t(($) => $.dashboard.pnl_chart)}</CardTitle>
              </CardHeader>
              <CardContent>
                <ChartContainer config={emptyChartConfig} className="aspect-[4/3] w-full">
                  <BarChart
                    data={pnlData}
                    layout="vertical"
                    margin={{ left: 0, right: 12, top: 4, bottom: 0 }}
                  >
                    <CartesianGrid horizontal={false} />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => formatPnL(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="code"
                      tickLine={false}
                      axisLine={false}
                      width={44}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          hideLabel
                          formatter={(value, _name, item) => {
                            const row = item?.payload as (typeof pnlData)[number] | undefined;
                            return `${row?.name ?? ""}: ${formatPnL(Number(value))}`;
                          }}
                        />
                      }
                    />
                    <ReferenceLine x={0} />
                    <Bar dataKey="pnl" barSize={12} radius={[0, 3, 3, 0]}>
                      {pnlData.map((d) => (
                        <Cell key={d.code} fill={d.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {structureEntries.length > 0 ? (
          <motion.div {...rise(0.42)}>
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t(($) => $.dashboard.structure)}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                {structureEntries.map(([key, pct], i) => {
                  const labelKey = STRUCTURE_LABELS[key];
                  return (
                  <div key={key} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-caption text-muted-foreground">
                        {labelKey ? t(($) => $.dashboard[labelKey]) : key}
                      </span>
                      <span className="font-mono text-body font-medium tabular-nums">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(pct, 100)}%` }}
                        transition={{ delay: 0.5 + i * 0.1, duration: 0.6, ease: "easeOut" }}
                        className="h-full rounded-full"
                        style={{ backgroundColor: STRUCTURE_COLORS[key] ?? `var(--chart-${(i % 5) + 1})` }}
                      />
                    </div>
                  </div>
                  );
                })}
              </CardContent>
            </Card>
          </motion.div>
        ) : null}

        {dailyPnlWindow.length > 0 ? (
          <motion.div {...rise(0.46)}>
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <TrendingUp aria-hidden="true" className="size-4 text-muted-foreground" />
                  {t(($) => $.dashboard.daily_pnl)}
                </CardTitle>
                <CardDescription
                  className={
                    dailyPnlSum >= 0
                      ? "text-red-500 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {t(($) => $.dashboard.daily_pnl_window, {
                    days: dailyPnlWindow.length,
                    sum: formatPnL(dailyPnlSum),
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={emptyChartConfig} className="aspect-[16/7] w-full">
                  <BarChart
                    data={dailyPnlWindow}
                    margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={16}
                      tickFormatter={(v: string) => v.slice(5)}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tickFormatter={(v: number) => formatPnL(v)}
                    />
                    <ChartTooltip
                      cursor={{ fill: "var(--muted)" }}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          hideIndicator
                          formatter={(_value, _name, item) => {
                            const row = item?.payload as FundDailyPnl | undefined;
                            if (!row) return null;
                            const details = Object.entries(row.per_fund)
                              .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                              .slice(0, 5);
                            return (
                              <div className="flex min-w-44 flex-col gap-0.5">
                                <span className="font-mono text-caption font-medium tabular-nums">
                                  {row.date} · {formatPnL(row.total)}
                                </span>
                                {details.map(([code, v]) => {
                                  const pct = row.per_fund_pct[code];
                                  return (
                                    <span
                                      key={code}
                                      className="flex items-baseline justify-between gap-3 font-mono text-caption tabular-nums"
                                    >
                                      <span className="min-w-0 truncate">
                                        {nameByCode.get(code) ?? code}
                                      </span>
                                      <span
                                        className={
                                          v >= 0
                                            ? "text-red-500 dark:text-red-400"
                                            : "text-emerald-600 dark:text-emerald-400"
                                        }
                                      >
                                        {formatPnL(v)}
                                        {pct != null ? ` (${pct >= 0 ? "+" : ""}${pct}%)` : ""}
                                      </span>
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          }}
                        />
                      }
                    />
                    <ReferenceLine y={0} />
                    <Bar
                      dataKey="total"
                      barSize={Math.min(20, Math.max(4, Math.floor(560 / dailyPnlWindow.length)))}
                      radius={[2, 2, 0, 0]}
                    >
                      {dailyPnlWindow.map((d) => (
                        <Cell key={d.date} fill={d.total >= 0 ? PNL_POSITIVE : PNL_NEGATIVE} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          </motion.div>
        ) : null}

        {watchlist && watchlist.funds.length > 0 && watchlistPnl.length > 0 ? (
          <motion.div {...rise(0.15)}>
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <LineChartIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  {t(($) => $.dashboard.watchlist)}
                  <span className="font-normal text-muted-foreground">
                    {watchlist.name || t(($) => $.dashboard.watchlist_unnamed)}
                  </span>
                  {watchlistStale ? (
                    <Badge
                      variant="outline"
                      className="font-normal text-amber-600 dark:text-amber-400"
                    >
                      {t(($) => $.dashboard.watchlist_pending_sync)}
                    </Badge>
                  ) : null}
                </CardTitle>
                <CardDescription
                  className={
                    watchlistCum >= 0
                      ? "text-red-500 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {t(($) => $.dashboard.watchlist_window, {
                    days: watchlistPnl.length,
                    since: watchlist.baseline,
                    cum: `${watchlistCum >= 0 ? "+" : ""}${watchlistCum}%`,
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={emptyChartConfig} className="aspect-[16/7] w-full">
                  <AreaChart
                    data={watchlistPnl}
                    margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="watchlistCum" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={16}
                      tickFormatter={(v: string) => v.slice(5)}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <ChartTooltip
                      cursor={{ stroke: "var(--muted-foreground)" }}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          hideIndicator
                          formatter={(_value, _name, item) => {
                            const row = item?.payload as WatchlistPnl | undefined;
                            if (!row) return null;
                            const detail = watchlist.funds
                              .map((wf) => {
                                const pct = row.per_fund_pct[wf.code];
                                return pct == null ? null : { wf, pct };
                              })
                              .filter((x): x is { wf: (typeof watchlist.funds)[number]; pct: number } => x != null)
                              .sort((a, b) => b.pct - a.pct);
                            return (
                              <div className="flex min-w-44 flex-col gap-0.5">
                                <span className="font-mono text-caption font-medium tabular-nums">
                                  {`${row.date} · ${row.weighted_pct >= 0 ? "+" : ""}${row.weighted_pct}% · ${t(($) => $.dashboard.watchlist_cum, {
                                    cum: `${row.cum_pct >= 0 ? "+" : ""}${row.cum_pct}%`,
                                  })}`}
                                </span>
                                {detail.map(({ wf, pct }) => (
                                  <span
                                    key={wf.code}
                                    className="flex items-baseline justify-between gap-3 font-mono text-caption tabular-nums"
                                  >
                                    <span className="min-w-0 truncate">{wf.name || wf.code}</span>
                                    <span className={pct >= 0 ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
                                      {pct >= 0 ? "+" : ""}{pct}%
                                    </span>
                                  </span>
                                ))}
                              </div>
                            );
                          }}
                        />
                      }
                    />
                    <ReferenceLine y={0} />
                    <Area
                      type="monotone"
                      dataKey="cum_pct"
                      stroke="var(--chart-2)"
                      strokeWidth={1.5}
                      fill="url(#watchlistCum)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ChartContainer>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {watchlist.funds.map((wf) => {
                    const series = watchlistSeriesByCode.get(wf.code) ?? [];
                    const cum = watchlistCumByCode.get(wf.code) ?? 0;
                    const chip = (
                      <span className="flex items-baseline gap-1.5 font-mono text-caption tabular-nums">
                        <span className="font-mono text-muted-foreground">{wf.weight}%</span>
                        <span className="max-w-40 truncate">{wf.name || wf.code}</span>
                        <span className={cum >= 0 ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
                          {cum >= 0 ? "+" : ""}
                          {cum}%
                        </span>
                      </span>
                    );
                    // Funds without a synced series yet (added since the last
                    // NAV sync) stay inert until the next rebuild.
                    return series.length > 0 ? (
                      <FundWatchlistFundDialog
                        key={wf.code}
                        wf={wf}
                        series={series}
                        baseline={watchlist.baseline}
                        trigger={chip}
                      />
                    ) : (
                      <span key={wf.code}>{chip}</span>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ) : null}

        {gold.data?.comex || gold.data?.sge ? (
          <motion.div {...rise(0.54)}>
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <Coins aria-hidden="true" className="size-4 text-muted-foreground" />
                  {t(($) => $.dashboard.gold_ref)}
                </CardTitle>
                {goldUpdated ? (
                  <CardDescription>
                    {t(($) => $.dashboard.gold_updated, {
                      time: new Date(goldUpdated.time).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-1.5">
                <GoldRow
                  label={t(($) => $.dashboard.gold_comex)}
                  unit={t(($) => $.dashboard.gold_unit_usd)}
                  quote={gold.data.comex}
                  digits={1}
                />
                <GoldRow
                  label={t(($) => $.dashboard.gold_sge)}
                  unit={t(($) => $.dashboard.gold_unit_cny)}
                  quote={gold.data.sge}
                  digits={2}
                />
                {goldEtfNav ? (
                  <div className="flex items-baseline justify-between gap-3 border-t pt-1.5 font-mono text-caption tabular-nums">
                    <span className="text-muted-foreground">
                      {t(($) => $.dashboard.gold_etf)}
                    </span>
                    <span>
                      {t(($) => $.dashboard.gold_etf_nav, {
                        nav: goldEtfNav.v.toFixed(4),
                        date: goldEtfNav.d,
                      })}
                    </span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </motion.div>
        ) : null}

        <div>
          <h2 className="mb-2 text-title-sm font-medium">
            {t(($) => $.dashboard.funds)}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {portfolio.funds.map((f, i) => {
              const weight =
                totals.market_value > 0 ? (f.market_value / totals.market_value) * 100 : 0;
              const fundDaily = portfolio.daily_pnl.flatMap((d) => {
                const value = d.per_fund[f.code];
                if (value == null) return [];
                return [{ date: d.date, value, pct: d.per_fund_pct[f.code] }];
              });
              return (
                <FundDetailDialog
                  key={f.code}
                  fund={f}
                  detail={portfolio.fund_details[f.code]}
                  dailyPnl={fundDaily}
                  weight={weight}
                  delay={0.1 + i * 0.05}
                  trigger={
                    <Card size="sm" className="h-full">
                    <CardHeader>
                      <CardTitle className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate" title={f.name}>
                          {f.name}
                        </span>
                      </CardTitle>
                      <CardDescription className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="font-mono">{f.code}</Badge>
                        {f.type ? <span className="truncate">{f.type}</span> : null}
                        {f.in_flight > 0 ? (
                          <Badge variant="outline">
                            {t(($) => $.dashboard.in_flight)} {formatCNY(f.in_flight, 0)}
                          </Badge>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-caption text-muted-foreground">
                          {t(($) => $.dashboard.market_value)}
                        </span>
                        <span className="font-mono text-body font-medium tabular-nums">
                          {formatCNY(f.market_value)}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-caption text-muted-foreground">
                          {t(($) => $.dashboard.cum_pnl)}
                        </span>
                        <span
                          className={`font-mono text-body font-medium tabular-nums ${
                            f.cum_pnl >= 0
                              ? "text-red-500 dark:text-red-400"
                              : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {formatPnL(f.cum_pnl)}
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min(weight, 100)}%` }}
                          transition={{ delay: 0.3 + i * 0.05, duration: 0.5, ease: "easeOut" }}
                          className="h-full rounded-full bg-primary/60"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
                        <span>
                          {t(($) => $.dashboard.weight)} {weight.toFixed(1)}%
                        </span>
                        <span className="font-mono tabular-nums">
                          {t(($) => $.dashboard.cost_price)} {f.cost_price.toFixed(4)}
                        </span>
                      </div>
                      {f.note ? (
                        <p className="text-caption text-muted-foreground">{f.note}</p>
                      ) : null}
                    </CardContent>
                  </Card>
                  }
                />
              );
            })}
          </div>
        </div>

        {plans.length > 0 || rules.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {plans.length > 0 ? (
              <motion.div {...rise(0.2)}>
                <Card size="sm" className="h-full">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" />
                      {t(($) => $.dashboard.plans)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    {plans.map((plan) => (
                      <div
                        key={`${plan.day}-${plan.code}`}
                        className="flex flex-wrap items-baseline gap-2"
                      >
                        <Badge variant="secondary" className="font-mono">
                          {t(($) => $.dashboard.plan_monthly, { day: plan.day })}
                        </Badge>
                        <Badge variant="outline" className="font-mono">{plan.code}</Badge>
                        <span className="font-mono text-body font-medium tabular-nums">
                          {formatCNY(plan.amount, 0)}
                        </span>
                        {plan.note ? (
                          <span className="text-caption text-muted-foreground">{plan.note}</span>
                        ) : null}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </motion.div>
            ) : null}
            {rules.length > 0 ? (
              <motion.div {...rise(0.27)}>
                <Card size="sm" className="h-full">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <ScrollText aria-hidden="true" className="size-4 text-muted-foreground" />
                      {t(($) => $.dashboard.rules)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="flex flex-col gap-2">
                      {rules.map(([key, rule]) => (
                        <li key={key} className="flex flex-col gap-0.5">
                          <span className="font-mono text-caption text-muted-foreground">{key}</span>
                          <span className="text-body">{rule}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </motion.div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MotionConfig>
  );
}
