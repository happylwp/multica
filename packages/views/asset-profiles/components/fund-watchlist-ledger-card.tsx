"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
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
import { Coins, LineChart as LineChartIcon } from "@multica/ui/icons";
import { useT } from "../../i18n";
import type { WatchLedger } from "../fund-portfolio";
import { PNL_NEGATIVE, PNL_POSITIVE, formatCNY, formatPct, pnlTextClass } from "./fund-format";

const emptyChartConfig = {} satisfies ChartConfig;

/**
 * Ledger-mode watchlist card: replaces the fixed-weight return card once the
 * user has logged trades. Everything here comes from the sync job's
 * simulation (adjusted-NAV share accounting, amortized cost, XIRR) — the
 * card is a pure view over watch_ledger.
 */
export function FundWatchlistLedgerCard({
  ledger,
  name,
  stale,
}: {
  ledger: NonNullable<WatchLedger>;
  name: string;
  stale: boolean;
}) {
  const { t } = useT("assets");
  const summary = ledger.summary;
  if (!summary) return null;
  const s = summary;
  const cumPct = formatPct(s.pnl_pct);

  const kpis: {
    key:
      | "ledger_market_value"
      | "ledger_cum_pnl"
      | "ledger_invested"
      | "ledger_cost"
      | "ledger_realized"
      | "ledger_xirr"
      | "ledger_drawdown";
    value: string;
    tone?: string;
  }[] = [
    { key: "ledger_market_value", value: formatCNY(s.market_value) },
    { key: "ledger_cum_pnl", value: `${formatCNY(s.cum_pnl)} (${cumPct})`, tone: pnlTextClass(s.cum_pnl) },
    { key: "ledger_invested", value: formatCNY(s.total_bought) },
    { key: "ledger_cost", value: formatCNY(s.cost) },
    { key: "ledger_realized", value: formatCNY(s.realized_pnl), tone: pnlTextClass(s.realized_pnl) },
    {
      key: "ledger_xirr",
      value: s.irr_pct == null ? "—" : formatPct(s.irr_pct),
      tone: s.irr_pct == null ? undefined : pnlTextClass(s.irr_pct),
    },
    { key: "ledger_drawdown", value: `-${s.max_drawdown_pct.toFixed(2)}%` },
  ];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Coins aria-hidden="true" className="size-4 text-muted-foreground" />
          {t(($) => $.dashboard.ledger_title)}
          <span className="font-normal text-muted-foreground">{name}</span>
          {stale ? (
            <Badge variant="outline" className="font-normal text-amber-600 dark:text-amber-400">
              {t(($) => $.dashboard.watchlist_pending_sync)}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription className="font-mono">
          {t(($) => $.dashboard.ledger_window, {
            start: s.start_date,
            end: s.end_date,
            days: s.days,
            count: s.trade_count,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {kpis.map((k) => (
            <div key={k.key} className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-2">
              <span className="text-caption text-muted-foreground">{t(($) => $.dashboard[k.key])}</span>
              <span className={`font-mono text-body font-medium tabular-nums ${k.tone ?? ""}`}>
                {k.value}
              </span>
            </div>
          ))}
        </section>

        <section className="mt-4">
          <h3 className="mb-2 flex items-center gap-1 text-caption font-medium text-muted-foreground">
            <LineChartIcon aria-hidden="true" className="size-3.5" />
            {t(($) => $.dashboard.ledger_value_trend)}
          </h3>
          <ChartContainer config={emptyChartConfig} className="aspect-[16/7] w-full">
            <AreaChart data={ledger.daily} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="ledgerMv" x1="0" y1="0" x2="0" y2="1">
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
                width={56}
                tickFormatter={(v: number) => formatCNY(v, 0)}
              />
              <ChartTooltip
                cursor={{ stroke: "var(--muted-foreground)" }}
                content={
                  <ChartTooltipContent
                    hideLabel
                    hideIndicator
                    formatter={(_value, _name, item) => {
                      const point = ledger.daily.find((d) => d.date === item?.payload?.date);
                      if (!point) return null;
                      return `${point.date.slice(5)}: ${formatCNY(point.mv)} / ${formatCNY(point.invested)} · ${formatPct(point.pnl_pct)}`;
                    }}
                  />
                }
              />
              <ReferenceLine y={0} />
              <Area
                type="monotone"
                dataKey="mv"
                stroke="var(--chart-2)"
                strokeWidth={1.5}
                fill="url(#ledgerMv)"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="invested"
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-caption font-medium text-muted-foreground">
            {t(($) => $.dashboard.ledger_daily_pnl)}
          </h3>
          <ChartContainer config={emptyChartConfig} className="aspect-[16/5] w-full">
            <BarChart data={ledger.daily} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
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
                tickFormatter={(v: number) => `${v >= 0 ? "" : "-"}${Math.abs(Math.round(v))}`}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)" }}
                content={
                  <ChartTooltipContent
                    hideLabel
                    hideIndicator
                    formatter={(_value, _name, item) => {
                      const point = item?.payload as (typeof ledger.daily)[number] | undefined;
                      if (!point) return null;
                      const sign = point.daily_pnl > 0 ? "+" : "";
                      return `${point.date.slice(5)}: ${sign}${formatCNY(point.daily_pnl)}`;
                    }}
                  />
                }
              />
              <ReferenceLine y={0} />
              <Bar
                dataKey="daily_pnl"
                barSize={Math.min(20, Math.max(4, Math.floor(480 / Math.max(1, ledger.daily.length))))}
                radius={[2, 2, 0, 0]}
              >
                {ledger.daily.map((d) => (
                  <Cell key={d.date} fill={d.daily_pnl >= 0 ? PNL_POSITIVE : PNL_NEGATIVE} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </section>

        <section className="mt-4 space-y-1">
          {s.per_fund.map((f) => (
            <div key={f.code} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-caption tabular-nums">
              <span className="font-sans max-w-40 truncate">{f.name || f.code}</span>
              <span className="text-muted-foreground">{f.weight}%</span>
              <span className="text-muted-foreground">
                {t(($) => $.dashboard.ledger_shares)} {f.shares.toLocaleString()}
              </span>
              <span className="text-muted-foreground">{formatCNY(f.cost, 0)} → {formatCNY(f.market_value, 0)}</span>
              <span className={pnlTextClass(f.cum_pnl)}>
                {formatCNY(f.cum_pnl)} ({formatPct(f.pnl_pct)})
              </span>
              {f.realized_pnl !== 0 ? (
                <span className={pnlTextClass(f.realized_pnl)}>
                  {t(($) => $.dashboard.ledger_realized)} {formatCNY(f.realized_pnl)}
                </span>
              ) : null}
            </div>
          ))}
        </section>
      </CardContent>
    </Card>
  );
}
