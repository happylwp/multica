// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractEastMoneyGlobals, parseGoldQuote } from "./eastmoney";

describe("extractEastMoneyGlobals", () => {
  it("reads name, latest NAV and trailing returns from loaded globals", () => {
    const fund = extractEastMoneyGlobals(
      {
        fS_name: "招商双债增强债券(LOF)C",
        syl_1y: "-0.36",
        syl_3y: "0.22",
        syl_6y: "1.43",
        syl_1n: "2.9",
        Data_netWorthTrend: [
          { x: 1760000000000, y: 1.65 },
          { x: 1760100000000, y: 1.654 },
        ],
      },
      "161716",
    );

    expect(fund.code).toBe("161716");
    expect(fund.name).toBe("招商双债增强债券(LOF)C");
    expect(fund.nav).toBe(1.654);
    // Timestamps are UTC+8 in the source; the date shifts accordingly.
    expect(fund.navDate).toBe(new Date(1760100000000 + 8 * 3600 * 1000).toISOString().slice(0, 10));
    expect(fund.returns).toEqual({ m1: -0.36, m3: 0.22, m6: 1.43, y1: 2.9 });
  });

  it("degrades every field to null when the script is empty or malformed", () => {
    for (const globals of [{}, { fS_name: 3 }, { Data_netWorthTrend: "oops" }]) {
      const fund = extractEastMoneyGlobals(globals as Record<string, unknown>, "000000");
      expect(fund.name).toBeNull();
      expect(fund.nav).toBeNull();
      expect(fund.navDate).toBeNull();
      expect(fund.returns).toEqual({ m1: null, m3: null, m6: null, y1: null });
    }
  });

  it("treats non-finite return strings as null", () => {
    const fund = extractEastMoneyGlobals({ syl_1n: "" }, "000000");
    expect(fund.returns.y1).toBeNull();
  });
});

describe("parseGoldQuote", () => {
  it("maps push2 fields to a quote", () => {
    const q = parseGoldQuote({ f43: 4008.1, f58: "COMEX黄金", f60: 4038.4, f169: -30.3, f170: -0.75, f86: 1793090386 });
    expect(q).toEqual({
      name: "COMEX黄金",
      price: 4008.1,
      prevClose: 4038.4,
      change: -30.3,
      changePct: -0.75,
      time: 1793090386000,
    });
  });

  it("returns null without a usable price", () => {
    expect(parseGoldQuote(null)).toBeNull();
    expect(parseGoldQuote({})).toBeNull();
    expect(parseGoldQuote({ f43: "-" })).toBeNull();
  });

  it("defaults the optional fields when only the price exists", () => {
    expect(parseGoldQuote({ f43: 860.31 })).toEqual({
      name: "",
      price: 860.31,
      prevClose: 0,
      change: 0,
      changePct: 0,
      time: 0,
    });
  });
});
