import { describe, expect, it } from "vitest";
import {
  equalizedValue,
  feeAmount,
  formatMoney,
  levelSavings,
  netTax,
  sumMoney,
  toCents,
} from "../../shared/money";

describe("1044 Tower Road penny test", () => {
  // 2025 Board of Review: AV 70,000 -> 62,800, equalizer 3.0355, rate 7.943607%
  it("matches the 2025 BOR reduction summary to the cent", () => {
    expect(equalizedValue("70000", "3.0355")).toBe("212485.00");
    expect(equalizedValue("62800", "3.0355")).toBe("190629.40");
    expect(netTax("70000", "3.0355", "7.943607")).toBe("16878.97");
    expect(netTax("62800", "3.0355", "7.943607")).toBe("15142.85");
    expect(levelSavings("70000", "62800", "3.0355", "7.943607")).toBe("1736.12");
  });

  it("charges the 40% first-year fee as $694.45", () => {
    expect(feeAmount("1736.12", "40")).toBe("694.45");
  });

  // 2024 Board of Review: AV 62,800 -> 60,410, equalizer 3.0163, rate 7.686%
  it("matches the 2024 BOR figures", () => {
    expect(netTax("62800", "3.0163", "7.686")).toBe("14559.10");
    expect(netTax("60410", "3.0163", "7.686")).toBe("14005.02");
    expect(levelSavings("62800", "60410", "3.0163", "7.686")).toBe("554.08");
  });

  it("totals $2,290.20 across both years", () => {
    expect(sumMoney(["1736.12", "554.08"])).toBe("2290.20");
    expect(formatMoney(sumMoney(["1736.12", "554.08"]))).toBe("$2,290.20");
  });
});

describe("level savings never bill the same reduction twice", () => {
  it("bills the BOR only on the AV below the Assessor result", () => {
    const eq = "3.0355";
    const rate = "7.943607";
    const assessor = levelSavings("100000", "90000", eq, rate);
    const bor = levelSavings("90000", "85000", eq, rate);
    const whole = levelSavings("100000", "85000", eq, rate);
    // Rounding happens per net-tax figure, so the parts add back to the whole.
    expect(sumMoney([assessor, bor])).toBe(whole);
  });
});

describe("rounding and parsing", () => {
  it("rounds half up to the cent", () => {
    expect(feeAmount("0.05", "50")).toBe("0.03"); // 0.025 -> 0.03
    expect(feeAmount("100000", "33.33")).toBe("33330.00");
  });

  it("refuses values that are not plain decimals", () => {
    expect(() => toCents("1,000.00")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });

  it("formats money with 2 decimals and grouping", () => {
    expect(formatMoney("274084.32")).toBe("$274,084.32");
    expect(formatMoney("0")).toBe("$0.00");
    expect(formatMoney("-12.5")).toBe("($12.50)");
  });
});
