"use client";

import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@multica/ui/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import type { WatchlistFund } from "../fund-portfolio";
import {
  PNL_NEGATIVE,
  PNL_POSITIVE,
  formatPct,
  pnlTextClass,
} from "./fund-format";

const emptyChartConfig = {} satisfies ChartConfig;

/**
 * Per-fund dialog for a watchlist member: the compounded return curve and
 * daily bars since the portfolio baseline, computed client-side from
 * watchlist_pnl (no extra fetch — watchlist funds need not be holdings).
 * `trigger` wraps the fund chip on the watchlist card.
 */
export function FundWatchlistFundDialog({
  wf,
  series,
  baseline,
  trigger,
}: {
  wf: WatchlistFund;
  series: { date: string; daily: number; cum: number }[];
  baseline: string;
  trigger: ReactNode;
}) {
  const { t } = useT("assets");
  const cum = series.at(-1)?.cum ?? 0;
  const dailyValues = series.map((s) => s.daily);
  const best = dailyValues.length > 0 ? Math.max(...dailyValues) : 0;
  const worst = dailyValues.length > 0 ? Math.min(...dailyValues) : 0;
  const avg =
    dailyValues.length > 0
      ? Math.round((dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length) * 100) / 100
      : 0;

  const stats: { key: "watchlist_fund_cum" | "watchlist_fund_best" | "watchlist_fund_worst" | "watchlist_fund_avg"; value: number }[] = [
    { key: "watchlist_fund_cum", value: cum },
    { key: "watchlist_fund_best", value: best },
    { key: "watchlist_fund_worst", value: worst },
    { key: "watchlist_fund_avg", value: avg },
  ];

  return (
    <Dialog>
      <DialogTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-2"
          />
        }
      >
        {trigger}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{wf.name || wf.code}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">{wf.code}</Badge>
            <span className="font-mono">{wf.weight}%</span>
            {t(($) => $.dashboard.watchlist_window, {
              days: series.length,
              since: baseline,
              cum: formatPct(cum),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="grid grid-cols-4 gap-2">
            {stats.map((s) => (
              <div key={s.key} className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-2">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.dashboard[s.key])}
                </span>
                <span className={`font-mono text-body font-medium tabular-nums ${pnlTextClass(s.value)}`}>
                  {formatPct(s.value)}
                </span>
              </div>
            ))}
          </section>

          <section>
            <h3 className="mb-2 text-caption font-medium text-muted-foreground">
              {t(($) => $.dashboard.watchlist_fund_trend)}
            </h3>
            <ChartContainer config={emptyChartConfig} className="aspect-[16/6] w-full">
              <AreaChart data={series} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id={`wlFundCum${wf.code}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
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
                        const point = item?.payload as (typeof series)[number] | undefined;
                        if (!point) return null;
                        return `${point.date.slice(5)}: ${formatPct(point.cum)}`;
                      }}
                    />
                  }
                />
                <ReferenceLine y={0} />
                <Area
                  type="monotone"
                  dataKey="cum"
                  stroke="var(--chart-1)"
                  strokeWidth={1.5}
                  fill={`url(#wlFundCum${wf.code})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          </section>

          <section>
            <h3 className="mb-2 text-caption font-medium text-muted-foreground">
              {t(($) => $.dashboard.watchlist_fund_daily)}
            </h3>
            <ChartContainer config={emptyChartConfig} className="aspect-[16/5] w-full">
              <BarChart data={series} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
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
                  cursor={{ fill: "var(--muted)" }}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      hideIndicator
                      formatter={(_value, _name, item) => {
                        const point = item?.payload as (typeof series)[number] | undefined;
                        if (!point) return null;
                        return `${point.date.slice(5)}: ${formatPct(point.daily)}`;
                      }}
                    />
                  }
                />
                <ReferenceLine y={0} />
                <Bar
                  dataKey="daily"
                  barSize={Math.min(20, Math.max(4, Math.floor(480 / Math.max(1, series.length))))}
                  radius={[2, 2, 0, 0]}
                >
                  {series.map((s) => (
                    <Cell key={s.date} fill={s.daily >= 0 ? PNL_POSITIVE : PNL_NEGATIVE} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
