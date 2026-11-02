"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "@multica/ui/icons";
import { api } from "@multica/core/api";
import { assetProfileDetailOptions, workspaceKeys } from "@multica/core/workspace/queries";
import type { AssetProfile } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";
import type { WatchTrade, WatchlistFund } from "../fund-portfolio";
import { fetchEastMoneyFund } from "../eastmoney";

// Editable string-backed row; weight is parsed on save.
type DraftWatchFund = Omit<WatchlistFund, "weight"> & { weight: string };

function toDraft(f: WatchlistFund): DraftWatchFund {
  return { code: f.code, name: f.name, weight: String(f.weight ?? ""), added_at: f.added_at };
}

// String-backed trade row; numeric fields parse on save. Empty strings mean
// "not provided" (shares on buys, amount on share-based sells).
type DraftTrade = {
  id: string;
  code: string;
  date: string;
  side: "buy" | "sell";
  amount: string;
  shares: string;
  fee_pct: string;
  note?: string;
};

function toTradeDraft(t: WatchTrade): DraftTrade {
  return {
    id: t.id,
    code: t.code,
    date: t.date,
    side: t.side,
    amount: t.amount != null ? String(t.amount) : "",
    shares: t.shares != null ? String(t.shares) : "",
    fee_pct: String(t.fee_pct ?? 0),
    note: t.note,
  };
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
// New watchlists start ~1 year back so the first sync seeds a year of
// return history; the baseline contract itself stays immutable.
const yearAgo = () => iso(new Date(Date.now() - 365 * 86400000));

/**
 * Form-based maintenance for the watchlist — a virtual portfolio of funds
 * the user does not necessarily hold. Weights are percentages; the daily
 * sync rebuilds the weighted return series from `baseline`, which is set
 * when the watchlist is first saved and never moved afterwards (so trimming
 * the list doesn't rewrite history).
 */
export function FundWatchlistEditorDialog({
  wsId,
  profile,
  onClose,
}: {
  wsId: string;
  profile: AssetProfile;
  onClose: () => void;
}) {
  const { t } = useT("assets");
  const qc = useQueryClient();
  const existing = profile.data as {
    watchlist?: { name: string; funds: WatchlistFund[]; baseline: string; trades?: WatchTrade[] };
  } | null;

  const [name, setName] = useState(existing?.watchlist?.name ?? "");
  const [rows, setRows] = useState<DraftWatchFund[]>(
    (existing?.watchlist?.funds ?? []).map(toDraft),
  );
  const [trades, setTrades] = useState<DraftTrade[]>(
    (existing?.watchlist?.trades ?? []).map(toTradeDraft),
  );
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);

  function addTrade() {
    // New rows default to today + the first member + buy; the fund list may
    // still be empty on create, in which case the row waits for a pick.
    setTrades((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        code: rows[0]?.code ?? "",
        date: today(),
        side: "buy",
        amount: "",
        shares: "",
        fee_pct: "0",
      },
    ]);
  }

  async function addFund() {
    const code = newCode.trim();
    setFetchNote(null);
    if (!/^\d{6}$/.test(code)) {
      setFetchNote(t(($) => $.fund_editor.bad_code));
      return;
    }
    if (rows.some((r) => r.code === code)) {
      setFetchNote(t(($) => $.fund_editor.duplicate_code));
      return;
    }
    setFetching(true);
    try {
      const info = await fetchEastMoneyFund(code);
      setRows((prev) => [...prev, { code, name: info.name ?? code, weight: "", added_at: today() }]);
      setNewCode("");
      setFetchNote(info.nav != null ? `${info.name ?? code} · ${info.nav.toFixed(4)}` : (info.name ?? code));
    } catch {
      setFetchNote(t(($) => $.fund_editor.fetch_failed));
    } finally {
      setFetching(false);
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const funds: WatchlistFund[] = [];
      for (const r of rows) {
        const code = r.code.trim();
        const nm = r.name.trim();
        if (!code || !nm) throw new Error(t(($) => $.fund_editor.missing_identity));
        if (funds.some((f) => f.code === code)) {
          throw new Error(t(($) => $.fund_editor.duplicate_code));
        }
        const weight = Number(r.weight);
        if (!Number.isFinite(weight) || r.weight.trim() === "" || weight <= 0) {
          throw new Error(`${nm}: ${t(($) => $.watchlist_editor.bad_weight)}`);
        }
        funds.push({ code, name: nm, weight, added_at: r.added_at || today() });
      }
      if (funds.length === 0) throw new Error(t(($) => $.fund_editor.empty_funds));

      const parsedTrades: WatchTrade[] = [];
      for (const r of trades) {
        const amount = r.amount.trim() === "" ? undefined : Number(r.amount);
        const shares = r.shares.trim() === "" ? undefined : Number(r.shares);
        const feePct = Number(r.fee_pct);
        if (
          !funds.some((f) => f.code === r.code) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          (amount != null && (!Number.isFinite(amount) || amount <= 0)) ||
          (shares != null && (!Number.isFinite(shares) || shares <= 0)) ||
          !Number.isFinite(feePct) ||
          feePct < 0 ||
          (r.side === "buy" && amount == null) ||
          (r.side === "sell" && amount == null && shares == null)
        ) {
          throw new Error(t(($) => $.watchlist_editor.bad_trade));
        }
        parsedTrades.push({
          id: r.id || crypto.randomUUID(),
          code: r.code,
          date: r.date,
          side: r.side,
          amount,
          shares,
          fee_pct: feePct || 0,
          note: r.note,
        });
      }

      // Merge onto the freshest server document: cached page data can lag
      // server-generated sections (watchlist_pnl, daily_pnl, nav_snapshot)
      // that a blind spread of the stale document would clobber.
      const latest = await qc.fetchQuery({
        ...assetProfileDetailOptions(wsId, profile.id),
        staleTime: 0,
      });
      const doc = {
        ...(typeof latest.data === "object" && latest.data !== null ? latest.data : {}),
        watchlist: {
          name: name.trim(),
          funds,
          baseline: existing?.watchlist?.baseline ?? yearAgo(),
          // Always written: an emptied list must clear a stale trades array
          // on the server so the sync job drops back to weight mode.
          trades: parsedTrades,
        },
      };
      return api.updateAssetProfile(profile.id, { data: doc });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.assetProfiles(wsId) });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center border-b px-5 pt-4 pb-3">
          <DialogTitle className="truncate text-title-sm font-medium">
            {t(($) => $.watchlist_editor.title)}
          </DialogTitle>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          {/* New watchlists backfill ~1 year of NAVs; existing ones keep the
              immutable-baseline contract, so the hint only shows on create. */}
          <DialogDescription className={existing?.watchlist ? "sr-only" : undefined}>
            {existing?.watchlist
              ? t(($) => $.watchlist_editor.description)
              : t(($) => $.watchlist_editor.backfill_hint)}
          </DialogDescription>

          <div className="grid gap-1.5">
            <Label htmlFor="watchlist-name">{t(($) => $.watchlist_editor.name)}</Label>
            <Input
              id="watchlist-name"
              value={name}
              className="h-8"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="watchlist-code">{t(($) => $.fund_editor.code)}</Label>
              <Input
                id="watchlist-code"
                value={newCode}
                inputMode="numeric"
                placeholder="000000"
                className="w-28 font-mono"
                onChange={(e) => setNewCode(e.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fetching || newCode.trim() === ""}
              onClick={addFund}
            >
              <Search />
              {fetching ? t(($) => $.fund_editor.fetching) : t(($) => $.fund_editor.fetch)}
            </Button>
            <p className="text-caption text-muted-foreground">
              {fetchNote ?? t(($) => $.watchlist_editor.add_hint)}
            </p>
          </div>

          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.code} className="flex items-center gap-2 rounded-lg border p-2">
                <span className="font-mono text-caption text-muted-foreground">{row.code}</span>
                <Input
                  aria-label={t(($) => $.fund_editor.name)}
                  value={row.name}
                  required
                  className="h-8 min-w-0 flex-1"
                  onChange={(e) =>
                    setRows((prev) => prev.map((r) => (r.code === row.code ? { ...r, name: e.target.value } : r)))
                  }
                />
                <div className="grid w-24 gap-1">
                  <Label className="text-caption" htmlFor={`wl-${row.code}-weight`}>
                    {t(($) => $.watchlist_editor.weight)}
                  </Label>
                  <Input
                    id={`wl-${row.code}-weight`}
                    value={row.weight}
                    inputMode="decimal"
                    required
                    className="h-8 font-mono tabular-nums"
                    onChange={(e) =>
                      setRows((prev) => prev.map((r) => (r.code === row.code ? { ...r, weight: e.target.value } : r)))
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.fund_editor.remove)}
                  onClick={() => setRows((prev) => prev.filter((r) => r.code !== row.code))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t(($) => $.watchlist_editor.trades)}</Label>
              <Button type="button" variant="outline" size="sm" onClick={addTrade}>
                <Plus />
                {t(($) => $.watchlist_editor.trade_add)}
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.watchlist_editor.trades_hint)}
            </p>
            {trades.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                <Input
                  type="date"
                  aria-label={t(($) => $.watchlist_editor.trade_date)}
                  value={row.date}
                  required
                  className="h-8 w-32"
                  onChange={(e) =>
                    setTrades((prev) => prev.map((r) => (r.id === row.id ? { ...r, date: e.target.value } : r)))
                  }
                />
                <Select
                  items={Object.fromEntries(rows.map((r) => [r.code, r.name || r.code]))}
                  value={row.code}
                  onValueChange={(v) =>
                    setTrades((prev) => prev.map((r) => (r.id === row.id ? { ...r, code: v ?? "" } : r)))
                  }
                >
                  <SelectTrigger
                    aria-label={t(($) => $.watchlist_editor.trade_fund)}
                    className="h-8 w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {rows.map((r) => (
                      <SelectItem key={r.code} value={r.code}>
                        {r.name || r.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  items={{
                    buy: t(($) => $.watchlist_editor.side_buy),
                    sell: t(($) => $.watchlist_editor.side_sell),
                  }}
                  value={row.side}
                  onValueChange={(v) =>
                    setTrades((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, side: v === "sell" ? "sell" : "buy" } : r)),
                    )
                  }
                >
                  <SelectTrigger
                    aria-label={t(($) => $.watchlist_editor.trade_side)}
                    className="h-8 w-24"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">{t(($) => $.watchlist_editor.side_buy)}</SelectItem>
                    <SelectItem value="sell">{t(($) => $.watchlist_editor.side_sell)}</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label={t(($) => $.watchlist_editor.trade_amount)}
                  value={row.amount}
                  inputMode="decimal"
                  placeholder={row.side === "buy" ? undefined : t(($) => $.watchlist_editor.trade_optional)}
                  required={row.side === "buy"}
                  className="h-8 w-24 font-mono tabular-nums"
                  onChange={(e) =>
                    setTrades((prev) => prev.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r)))
                  }
                />
                <Input
                  aria-label={t(($) => $.watchlist_editor.trade_shares)}
                  value={row.shares}
                  inputMode="decimal"
                  placeholder={row.side === "sell" ? undefined : t(($) => $.watchlist_editor.trade_optional)}
                  className="h-8 w-24 font-mono tabular-nums"
                  onChange={(e) =>
                    setTrades((prev) => prev.map((r) => (r.id === row.id ? { ...r, shares: e.target.value } : r)))
                  }
                />
                <Input
                  aria-label={t(($) => $.watchlist_editor.trade_fee)}
                  value={row.fee_pct}
                  inputMode="decimal"
                  required
                  className="h-8 w-20 font-mono tabular-nums"
                  onChange={(e) =>
                    setTrades((prev) => prev.map((r) => (r.id === row.id ? { ...r, fee_pct: e.target.value } : r)))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.fund_editor.remove)}
                  onClick={() => setTrades((prev) => prev.filter((r) => r.id !== row.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          {error ? <p className="text-caption text-destructive">{error}</p> : null}
        </form>
        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t(($) => $.fund_editor.cancel)}
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
          >
            <Plus />
            {mutation.isPending ? t(($) => $.fund_editor.saving) : t(($) => $.fund_editor.save)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
