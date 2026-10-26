// Front-end access to fund.eastmoney.com profile data.
//
// pingzhongdata/{code}.js is a plain `var` assignment script — the fund
// page itself loads it cross-origin, and a <script> tag keeps working for
// us without a server proxy (no CORS for classic scripts). The vars land on
// `window`, are read once, and are removed again.

export type EastMoneyFund = {
  code: string;
  name: string | null;
  nav: number | null;
  navDate: string | null;
  returns: { m1: number | null; m3: number | null; m6: number | null; y1: number | null };
};

const GLOBAL_KEYS = [
  "fS_name",
  "syl_1y",
  "syl_3y",
  "syl_6y",
  "syl_1n",
  "Data_netWorthTrend",
] as const;

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function beijingDate(ts: number): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Reads the globals a loaded pingzhongdata script leaves on `globals`
 * (`window` in the app, a plain object in tests).
 */
export function extractEastMoneyGlobals(
  globals: Record<string, unknown>,
  code: string,
): EastMoneyFund {
  const trend = globals.Data_netWorthTrend;
  const last = Array.isArray(trend) ? trend[trend.length - 1] : undefined;
  const point =
    last && typeof last === "object" && "x" in last && "y" in last
      ? (last as { x: number; y: number })
      : undefined;
  return {
    code,
    name: typeof globals.fS_name === "string" ? globals.fS_name : null,
    nav: point ? toNumber(point.y) : null,
    navDate: point && Number.isFinite(point.x) ? beijingDate(point.x) : null,
    returns: {
      m1: toNumber(globals.syl_1y),
      m3: toNumber(globals.syl_3y),
      m6: toNumber(globals.syl_6y),
      y1: toNumber(globals.syl_1n),
    },
  };
}

/** Loads the East Money fund script for `code` and returns its profile. */
export function fetchEastMoneyFund(code: string, timeoutMs = 8000): Promise<EastMoneyFund> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timer);
      script.remove();
      // Reflect.deleteProperty never throws: privacy extensions can leave
      // non-configurable trackers on window, and a throwing `delete` here
      // (outside any try/catch on the onerror/timeout paths) would surface
      // as an uncaught TypeError and leave this promise pending forever.
      for (const key of GLOBAL_KEYS) Reflect.deleteProperty(w, key);
    }
    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
    script.onload = () => {
      try {
        const result = extractEastMoneyGlobals(w, code);
        cleanup();
        if (result.name === null && result.nav === null) {
          reject(new Error("empty"));
        } else {
          resolve(result);
        }
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error("parse"));
      }
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("network"));
    };
    document.head.appendChild(script);
  });
}
