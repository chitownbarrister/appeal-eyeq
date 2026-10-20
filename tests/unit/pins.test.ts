import { describe, expect, it } from "vitest";
import { avFromFmv, fmvFromAv, pinAv, requestedAchieved, splitAgreedTotal, sumAvs } from "../../shared/pins";
import { cycleEnd, cycleStart, sameCycle } from "../../shared/reassessment";

describe("several PINs on one appeal", () => {
  it("adds land and building into AV, to the penny", () => {
    expect(pinAv({ land: "3048", impr: "37952", av: null })).toBe("41000.00");
    expect(pinAv({ land: null, impr: null, av: "41000" })).toBe("41000.00");
    expect(pinAv({ land: null, impr: null, av: null })).toBeNull();
  });

  it("works FMV and AV both ways, with one third exact for the collar counties", () => {
    expect(fmvFromAv("41000", "10")).toBe("410000.00");
    expect(fmvFromAv("106284", "25")).toBe("425136.00");
    expect(fmvFromAv("92467.08", "25")).toBe("369868.32");
    expect(fmvFromAv("100000", "33.33")).toBe("300000.00"); // not 300030.00
    expect(avFromFmv("365375", "10")).toBe("36537.50");
    expect(avFromFmv("300000", "33.33")).toBe("100000.00");
    expect(avFromFmv("100", "33.33")).toBe("33.33");
  });

  it("splits Dillon's three-PIN example the firm's way: land held, building takes the cut", () => {
    const pins = [
      { key: 1, land: "19270", impr: "81270", av: null },
      { key: 2, land: "1872", impr: "1000", av: null },
      { key: 3, land: "1872", impr: "1000", av: null },
    ];
    const r = splitAgreedTotal(pins, "92467.08");
    expect(r).toEqual([
      { key: 1, land: "19270.00", impr: "68199.80", av: "87469.80" },
      { key: 2, land: "1872.00", impr: "626.64", av: "2498.64" },
      { key: 3, land: "1872.00", impr: "626.64", av: "2498.64" },
    ]);
    expect(sumAvs(r.map((x) => x.av))).toBe("92467.08");
  });

  it("gives leftover cents to the largest PIN so the total is exact", () => {
    const r = splitAgreedTotal([{ key: "a", land: null, impr: null, av: "1" }, { key: "b", land: null, impr: null, av: "1" }, { key: "c", land: null, impr: null, av: "1" }], "1.00");
    expect(r.map((x) => x.av)).toEqual(["0.34", "0.33", "0.33"]);
  });

  it("takes a land-only PIN's share off its land, and a cut bigger than the building off the land too", () => {
    const r = splitAgreedTotal([{ key: "lot", land: "350000", impr: "0", av: null }, { key: "bldg", land: "50000", impr: "10000", av: null }], "205000");
    expect(r[0]).toEqual({ key: "lot", land: "175000.00", impr: "0.00", av: "175000.00" });
    expect(r[1]).toEqual({ key: "bldg", land: "30000.00", impr: "0.00", av: "30000.00" });
  });

  it("refuses to divide when a PIN has no original AV", () => {
    expect(() => splitAgreedTotal([{ key: 1, land: null, impr: null, av: null }], "10")).toThrow();
  });

  it("reports the share of the requested reduction achieved", () => {
    expect(requestedAchieved("2000000", "1670000", "1800000")).toBe("60.6%");
    expect(requestedAchieved("100", "100", "90")).toBeNull();
  });
});

describe("reassessment cycles", () => {
  it("knows Cook's triennial cycles and the collar counties' quadrennial ones", () => {
    expect(cycleStart("Cook", "North", 2026)).toBe(2025);
    expect(cycleEnd("Cook", "North", 2026)).toBe(2027);
    expect(sameCycle("Cook", "North", 2025, 2026)).toBe(true);
    expect(sameCycle("Cook", "North", 2024, 2025)).toBe(false); // Dillon's house: 2024 is the earlier cycle
    expect(cycleStart("Cook", "City", 2026)).toBe(2024);
    expect(cycleStart("Lake", null, 2026)).toBe(2023);
    expect(sameCycle("Lake", null, 2026, 2027)).toBe(false);
    expect(cycleStart("Cook", null, 2026)).toBeNull();
  });
});
