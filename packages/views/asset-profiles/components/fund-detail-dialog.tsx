"use client";

import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
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
import { Star, TrendingUp } from "lucide-react";
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
import type { FundDetail, FundPosition } from "../fund-portfolio";
import {
  PNL_NEGATIVE,
  PNL_POSITIVE,
  formatCNY,
  formatPct,
  formatPnL,
  pnlTextClass,
} from "./fund-format";

const emptyChartConfig = {} satisfies ChartConfig;

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.35, ease: "easeOut" as const },
});

type DailyPnlPoint = { date: string; value: number; pct?: number };

// One disclosed holding row, whichever bucket it comes from; only stock
// rows carry the sector and quarter-over-quarter change annotations.
type HoldingRow = {
  code: string | null;
  name: string | null;
  pct: number | null;
  sector?: string | null;
  chg_type?: string | null;
};

/**
 * Per-fund detail dialog. `trigger` wraps each holding card on the
 * dashboard; the dialog layers the East Money profile snapshot (identity,
 * trailing returns, manager, scale, allocation, 90-day NAV trend) over the
 * user's own position and its daily P&L history.
 */
export function FundDetailDialog({
  fund,
  detail,
  dailyPnl,
  weight,
  delay,
  trigger,
}: {
  fund: FundPosition;
  detail?: FundDetail;
  dailyPnl: DailyPnlPoint[];
  weight: number;
  delay: number;
  trigger: ReactNode;
}) {
  const { t } = useT("assets");
  // Allocation buckets that disclose holdings: clicking one expands the
  // detail panel below (cash/other disclose nothing and stay inert).
  const [allocTab, setAllocTab] = useState<"stock" | "bond" | "fund" | null>(null);
  const positions = detail?.positions ?? null;
  const stockCount = positions?.stocks.length ?? 0;
  const bondCount = positions?.bonds.length ?? 0;
  const fundCount = positions?.funds.length ?? 0;
  const hasEtf = positions?.etf != null;

  const returns: { key: "m1" | "m3" | "m6" | "y1"; label: string; value: number | null }[] = [
    { key: "m1", label: t(($) => $.fund_detail.m1), value: detail?.returns.m1 ?? null },
    { key: "m3", label: t(($) => $.fund_detail.m3), value: detail?.returns.m3 ?? null },
    { key: "m6", label: t(($) => $.fund_detail.m6), value: detail?.returns.m6 ?? null },
    { key: "y1", label: t(($) => $.fund_detail.y1), value: detail?.returns.y1 ?? null },
  ];
  const allocations = [
    { label: t(($) => $.fund_detail.alloc_stock), value: detail?.allocation?.stock ?? null, tab: "stock" as const },
    { label: t(($) => $.fund_detail.alloc_bond), value: detail?.allocation?.bond ?? null, tab: "bond" as const },
    { label: t(($) => $.fund_detail.alloc_cash), value: detail?.allocation?.cash ?? null, tab: null },
    { label: t(($) => $.fund_detail.alloc_fund), value: detail?.allocation?.fund ?? null, tab: "fund" as const },
    { label: t(($) => $.fund_detail.alloc_rest), value: detail?.allocation?.other ?? null, tab: null },
  ];
  const tabDetailCount: Record<"stock" | "bond" | "fund", number> = {
    stock: stockCount,
    bond: bondCount,
    fund: fundCount + (hasEtf ? 1 : 0),
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          <motion.div
            {...rise(delay)}
            role="button"
            tabIndex={0}
            className="h-full cursor-pointer transition-transform hover:-translate-y-0.5"
          />
        }
      >
        {trigger}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{detail?.name ?? fund.name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">{fund.code}</Badge>
            {fund.type ? <span>{fund.type}</span> : null}
            {detail?.fetched_at ? (
              <span className="text-caption">
                {t(($) => $.fund_detail.source_note, { date: detail.fetched_at })}
              </span>
            ) : (
              <span className="text-caption">{t(($) => $.fund_detail.no_detail)}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {returns.some((r) => r.value !== null) ? (
            <section className="grid grid-cols-4 gap-2">
              {returns.map((r) => (
                <div key={r.key} className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-2">
                  <span className="text-caption text-muted-foreground">{r.label}</span>
                  <span
                    className={`font-mono text-body font-medium tabular-nums ${
                      r.value === null ? "text-muted-foreground" : pnlTextClass(r.value)
                    }`}
                  >
                    {r.value === null ? "—" : formatPct(r.value)}
                  </span>
                </div>
              ))}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-caption font-medium text-muted-foreground">
              {t(($) => $.fund_detail.my_position)}
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
              <div className="flex flex-col">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.dashboard.market_value)}
                </span>
                <span className="font-mono text-body font-medium tabular-nums">
                  {formatCNY(fund.market_value)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.dashboard.cum_pnl)}
                </span>
                <span className={`font-mono text-body font-medium tabular-nums ${pnlTextClass(fund.cum_pnl)}`}>
                  {formatPnL(fund.cum_pnl)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.dashboard.weight)}
                </span>
                <span className="font-mono text-body font-medium tabular-nums">
                  {weight.toFixed(1)}%
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.fund_detail.shares)}
                </span>
                <span className="font-mono text-body font-medium tabular-nums">
                  {fund.shares.toLocaleString()}
                </span>
              </div>
            </div>
            {dailyPnl.length > 0 ? (
              <div className="mt-3">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.fund_detail.daily_detail, { n: dailyPnl.length })}
                </span>
                <ChartContainer config={emptyChartConfig} className="aspect-[16/5] w-full">
                  <BarChart data={dailyPnl} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
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
                      tickFormatter={(v: number) => formatPnL(v)}
                    />
                    <ChartTooltip
                      cursor={{ fill: "var(--muted)" }}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          hideIndicator
                          formatter={(_value, _name, item) => {
                            const point = item?.payload as DailyPnlPoint | undefined;
                            if (!point) return null;
                            return `${point.date.slice(5)}: ${formatPnL(point.value)}${
                              point.pct != null ? ` (${point.pct >= 0 ? "+" : ""}${point.pct}%)` : ""
                            }`;
                          }}
                        />
                      }
                    />
                    <ReferenceLine y={0} />
                    <Bar dataKey="value" barSize={Math.min(20, Math.max(4, Math.floor(480 / dailyPnl.length)))} radius={[2, 2, 0, 0]}>
                      {dailyPnl.map((d) => (
                        <Cell key={d.date} fill={d.value >= 0 ? PNL_POSITIVE : PNL_NEGATIVE} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </div>
            ) : null}
          </section>

          {detail && detail.trend.length > 1 ? (
            <section>
              <h3 className="mb-2 text-caption font-medium text-muted-foreground">
                {t(($) => $.fund_detail.trend)}
              </h3>
              <ChartContainer config={emptyChartConfig} className="aspect-[16/6] w-full">
                <AreaChart data={detail.trend} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`fundTrend${fund.code}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="d"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => v.toFixed(3)}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        hideLabel
                        hideIndicator
                        formatter={(value, _name, item) =>
                          `${(item?.payload as (typeof detail.trend)[number])?.d ?? ""}: ${Number(value).toFixed(4)}`
                        }
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="var(--chart-1)"
                    strokeWidth={1.5}
                    fill={`url(#fundTrend${fund.code})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ChartContainer>
            </section>
          ) : null}

          {detail ? (
            <section>
              <h3 className="mb-2 text-caption font-medium text-muted-foreground">
                {t(($) => $.fund_detail.profile)}
              </h3>
              <div className="space-y-1.5">
                {detail.manager?.name ? (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.fund_detail.manager)}
                    </span>
                    <span className="text-body font-medium">{detail.manager.name}</span>
                    {detail.manager.star ? (
                      <span className="inline-flex items-center gap-0.5 text-caption text-amber-500">
                        <Star aria-hidden="true" className="size-3 fill-current" />
                        {detail.manager.star}
                      </span>
                    ) : null}
                    {detail.manager.workTime ? (
                      <span className="text-caption text-muted-foreground">
                        {t(($) => $.fund_detail.work_time, { time: detail.manager.workTime })}
                      </span>
                    ) : null}
                    {detail.manager.fundSize ? (
                      <span className="font-mono text-caption tabular-nums text-muted-foreground">
                        {detail.manager.fundSize}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {detail.scale?.value != null ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.fund_detail.scale)}
                    </span>
                    <span className="font-mono text-body tabular-nums">
                      {detail.scale.value} {t(($) => $.fund_detail.scale_unit)}
                    </span>
                    {detail.scale.date ? (
                      <span className="text-caption text-muted-foreground">{detail.scale.date}</span>
                    ) : null}
                  </div>
                ) : null}
                {detail.fee.current != null ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.fund_detail.fee)}
                    </span>
                    <span className="font-mono text-body tabular-nums">
                      {detail.fee.source != null && detail.fee.source !== detail.fee.current
                        ? `${detail.fee.source}% → ${detail.fee.current}%`
                        : `${detail.fee.current}%`}
                    </span>
                  </div>
                ) : null}
                {allocations.some((a) => a.value != null) ? (
                  <div className="flex flex-col gap-1 pt-1">
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.fund_detail.allocation)}
                      {detail.allocation?.date ? ` · ${detail.allocation.date}` : ""}
                    </span>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
                      {allocations.map((a) => {
                        const clickable = a.tab != null && tabDetailCount[a.tab] > 0;
                        const selected = a.tab != null && allocTab === a.tab;
                        const Tag = clickable ? "button" : "div";
                        return (
                          <Tag
                            key={a.label}
                            {...(clickable
                              ? { type: "button" as const, onClick: () => setAllocTab(selected ? null : a.tab) }
                              : {})}
                            className={`flex items-center justify-between gap-1 rounded-md px-2 py-1 text-left ${
                              selected ? "bg-primary/10 ring-1 ring-primary/30" : "bg-muted/50"
                            } ${clickable ? "cursor-pointer transition-colors hover:bg-muted" : ""}`}
                          >
                            <span className="text-caption">{a.label}</span>
                            <span className="font-mono text-caption tabular-nums">
                              {a.value == null ? "—" : `${a.value.toFixed(2)}%`}
                            </span>
                          </Tag>
                        );
                      })}
                    </div>
                    {allocTab != null ? (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="rounded-md border p-2"
                      >
                        <span className="text-caption font-medium text-muted-foreground">
                          {allocTab === "stock"
                            ? t(($) => $.fund_detail.positions_stock)
                            : allocTab === "bond"
                              ? t(($) => $.fund_detail.positions_bond)
                              : t(($) => $.fund_detail.positions_fund)}
                        </span>
                        <div className="mt-1 space-y-1">
                          {allocTab === "fund" && positions?.etf ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-baseline gap-1.5 truncate">
                                <span className="text-body">{positions.etf.name ?? positions.etf.code}</span>
                                <span className="font-mono text-caption text-muted-foreground">{positions.etf.code}</span>
                              </span>
                              <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                                {t(($) => $.fund_detail.target_etf)}
                              </span>
                            </div>
                          ) : null}
                          {(
                            [
                              { list: positions?.stocks ?? [], key: "stock" },
                              { list: positions?.bonds ?? [], key: "bond" },
                              { list: positions?.funds ?? [], key: "fund" },
                            ] as { key: string; list: HoldingRow[] }[]
                          )
                            .find((x) => x.key === allocTab)
                            ?.list.map((item) => {
                            const sector = item.sector ?? null;
                            const chgType = item.chg_type ?? null;
                            return (
                              <div key={`${item.code}-${item.name}`} className="flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-baseline gap-1.5">
                                  <span className="truncate text-body">{item.name ?? item.code}</span>
                                  <span className="shrink-0 font-mono text-caption text-muted-foreground">{item.code}</span>
                                  {sector ? (
                                    <span className="shrink-0 text-caption text-muted-foreground">{sector}</span>
                                  ) : null}
                                  {chgType ? (
                                    <Badge
                                      variant="outline"
                                      className={`h-4 shrink-0 px-1 text-[10px] ${
                                        chgType === "减持" ? "text-emerald-600" : "text-red-500"
                                      }`}
                                    >
                                      {chgType}
                                    </Badge>
                                  ) : null}
                                </span>
                                <span className="shrink-0 font-mono text-caption tabular-nums">
                                  {item.pct == null ? "—" : `${item.pct.toFixed(2)}%`}
                                </span>
                              </div>
                            );
                          })}
                          {allocTab != null && tabDetailCount[allocTab] === 0 ? (
                            <p className="text-caption text-muted-foreground">
                              {t(($) => $.fund_detail.no_positions)}
                            </p>
                          ) : null}
                        </div>
                      </motion.div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {!detail ? (
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <TrendingUp aria-hidden="true" className="size-3.5" />
              {t(($) => $.fund_detail.no_detail)}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
