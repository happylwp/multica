"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "@multica/ui/icons";
import { api } from "@multica/core/api";
import { assetProfileDetailOptions, workspaceKeys } from "@multica/core/workspace/queries";
import type { AssetProfile } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
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
import { useT } from "../../i18n";
import type { FundPosition } from "../fund-portfolio";
import { fetchEastMoneyFund } from "../eastmoney";

// Editable string-backed row: inputs are controlled text, parsed on save so
// the user can clear a field while typing without NaN churn.
type DraftFund = Omit<
  FundPosition,
  "note" | "shares" | "cost_price" | "cost_amount" | "market_value" | "in_flight"
> & {
  note: string;
  shares: string;
  cost_price: string;
  cost_amount: string;
  market_value: string;
  in_flight: string;
  /** market_value still follows shares × fetched NAV (unset once edited). */
  mvAuto: boolean;
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const parseNum = (s: string) => {
  const v = Number(s);
  return Number.isFinite(v) && s.trim() !== "" ? v : null;
};

function toDraft(f: FundPosition): DraftFund {
  return {
    ...f,
    note: f.note ?? "",
    shares: String(f.shares ?? ""),
    cost_price: String(f.cost_price ?? ""),
    cost_amount: String(f.cost_amount ?? ""),
    market_value: String(f.market_value ?? ""),
    in_flight: String(f.in_flight ?? ""),
    mvAuto: false,
  };
}

const emptyDraft = (): DraftFund => ({
  code: "",
  name: "",
  type: "",
  shares: "",
  cost_price: "",
  cost_amount: "",
  market_value: "",
  in_flight: "",
  cum_pnl: 0,
  note: "",
  mvAuto: true,
});

/**
 * Form-based maintenance for the funds array of a fund-portfolio document.
 * New funds can pull their name and latest NAV straight from East Money by
 * code; everything else (shares, costs, notes) is edited inline. Totals are
 * recomputed on save; structure percentages self-correct on the next daily
 * sync.
 */
export function FundPositionsEditorDialog({
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
  const portfolio = profile.data as { funds?: FundPosition[] } | null;

  const [rows, setRows] = useState<DraftFund[]>(
    (portfolio?.funds ?? []).map(toDraft),
  );
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [fetchedNav, setFetchedNav] = useState<{ code: string; nav: number } | null>(null);

  const patchRow = (code: string, patch: Partial<DraftFund>) =>
    setRows((prev) => prev.map((r) => (r.code === code ? { ...r, ...patch } : r)));

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
      const row = emptyDraft();
      row.code = code;
      row.name = info.name ?? code;
      setRows((prev) => [...prev, row]);
      setFetchedNav(info.nav != null ? { code, nav: info.nav } : null);
      setNewCode("");
      setFetchNote(
        info.nav != null
          ? `${info.name ?? code} · ${info.navDate ?? ""} ${info.nav.toFixed(4)}`
          : (info.name ?? code),
      );
    } catch {
      setFetchNote(t(($) => $.fund_editor.fetch_failed));
    } finally {
      setFetching(false);
    }
  }

  // Market value follows shares × fetched NAV until the user edits it.
  function onSharesChange(row: DraftFund, value: string) {
    patchRow(row.code, { shares: value });
    const nav = fetchedNav?.code === row.code ? fetchedNav.nav : null;
    const shares = Number(value);
    if (
      nav != null &&
      row.mvAuto &&
      Number.isFinite(shares) &&
      value.trim() !== ""
    ) {
      patchRow(row.code, { market_value: (shares * nav).toFixed(2) });
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const funds: FundPosition[] = [];
      for (const r of rows) {
        const code = r.code.trim();
        const name = r.name.trim();
        if (!code || !name) throw new Error(t(($) => $.fund_editor.missing_identity));
        if (funds.some((f) => f.code === code)) {
          throw new Error(t(($) => $.fund_editor.duplicate_code));
        }
        const shares = parseNum(r.shares);
        const market_value = parseNum(r.market_value);
        const cost_amount = parseNum(r.cost_amount);
        const cost_price = parseNum(r.cost_price);
        if (shares == null || market_value == null || cost_amount == null) {
          throw new Error(`${name}: ${t(($) => $.fund_editor.invalid_number)}`);
        }
        const cum_pnl = r.cum_pnl || round2(market_value - cost_amount);
        funds.push({
          code,
          name,
          type: r.type.trim(),
          shares,
          cost_price: cost_price ?? (shares > 0 ? round2(cost_amount / shares) : 0),
          cost_amount,
          market_value,
          in_flight: parseNum(r.in_flight) ?? 0,
          cum_pnl,
          ...(r.note.trim() ? { note: r.note.trim() } : {}),
        });
      }
      if (funds.length === 0) throw new Error(t(($) => $.fund_editor.empty_funds));

      const market_value = round2(funds.reduce((a, f) => a + f.market_value, 0));
      const cost_amount = round2(funds.reduce((a, f) => a + f.cost_amount, 0));
      const cum_pnl = round2(funds.reduce((a, f) => a + f.cum_pnl, 0));
      // Merge onto the freshest server document: cached page data can lag
      // server-generated sections (daily_pnl, watchlist_pnl, nav_snapshot)
      // that a blind spread of the stale document would clobber.
      const latest = await qc.fetchQuery({
        ...assetProfileDetailOptions(wsId, profile.id),
        staleTime: 0,
      });
      const doc = {
        ...(typeof latest.data === "object" && latest.data !== null ? latest.data : {}),
        funds,
        totals: {
          market_value,
          cost_amount,
          cum_pnl,
          pnl_pct: cost_amount > 0 ? round2((cum_pnl / cost_amount) * 100) : 0,
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
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center border-b px-5 pt-4 pb-3">
          <DialogTitle className="truncate text-title-sm font-medium">
            {t(($) => $.fund_editor.title)}
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
          <DialogDescription className="sr-only">
            {t(($) => $.fund_editor.description)}
          </DialogDescription>

          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="fund-editor-code">{t(($) => $.fund_editor.code)}</Label>
              <Input
                id="fund-editor-code"
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
              {fetchNote ?? t(($) => $.fund_editor.add_hint)}
            </p>
          </div>

          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.code} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono">
                    {row.code || t(($) => $.fund_editor.new_fund)}
                  </Badge>
                  <Input
                    aria-label={t(($) => $.fund_editor.name)}
                    value={row.name}
                    required
                    className="h-8 flex-1"
                    onChange={(e) => patchRow(row.code, { name: e.target.value })}
                  />
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
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["shares", "shares", true],
                      ["cost_price", "cost_price", false],
                      ["cost_amount", "cost_amount", true],
                      ["market_value", "market_value", true],
                      ["in_flight", "in_flight", false],
                      ["type", "type", false],
                    ] as const
                  ).map(([labelKey, field, required]) => (
                    <div key={field} className="grid gap-1">
                      <Label className="text-caption" htmlFor={`fe-${row.code}-${field}`}>
                        {t(($) => $.fund_editor[labelKey])}
                      </Label>
                      <Input
                        id={`fe-${row.code}-${field}`}
                        value={row[field]}
                        inputMode={field === "type" ? undefined : "decimal"}
                        required={required}
                        className="h-8 font-mono tabular-nums"
                        onChange={(e) => {
                          if (field === "shares") onSharesChange(row, e.target.value);
                          else if (field === "market_value")
                            patchRow(row.code, { market_value: e.target.value, mvAuto: false });
                          else patchRow(row.code, { [field]: e.target.value });
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-2 grid gap-1">
                  <Label className="text-caption" htmlFor={`fe-${row.code}-note`}>
                    {t(($) => $.fund_editor.note)}
                  </Label>
                  <Input
                    id={`fe-${row.code}-note`}
                    value={row.note}
                    className="h-8"
                    onChange={(e) => patchRow(row.code, { note: e.target.value })}
                  />
                </div>
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
