import { describe, expect, it } from "vitest";
import { isReassessed, reassessmentLabel } from "../../shared/reassessment";

describe("reassessment cycles", () => {
  it("follows Cook's three-year triad rotation", () => {
    expect(isReassessed("Cook", "City", 2024)).toBe(true);
    expect(isReassessed("Cook", "City", 2027)).toBe(true);
    expect(isReassessed("Cook", "North", 2025)).toBe(true);
    expect(isReassessed("Cook", "North", 2027)).toBe(false);
    expect(isReassessed("Cook", "South", 2026)).toBe(true);
    expect(isReassessed("Cook", "South", 2029)).toBe(true);
    expect(isReassessed("Cook", null, 2027)).toBe(false);
  });
  it("puts the other counties on the statewide four-year general assessment", () => {
    expect(isReassessed("DuPage", null, 2023)).toBe(true);
    expect(isReassessed("Will", null, 2027)).toBe(true);
    expect(isReassessed("Lake", null, 2026)).toBe(false);
    expect(isReassessed("Kane", null, 2031)).toBe(true);
  });
  it("describes the year in words", () => {
    expect(reassessmentLabel(2027)).toBe("the City of Chicago townships and the collar counties' general reassessment");
    expect(reassessmentLabel(2028)).toBe("Cook's North suburbs");
  });
});
