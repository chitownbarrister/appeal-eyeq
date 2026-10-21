// The decision letter parsers, run on the OCR text of real sample letters
// (Dillon's examples, Oct 20, 2026, with names changed and PINs redacted at source)
// and on clean text like an e-filed PDF's.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPage, findDate, findPins, parseAmount, parseLetter, splitIntoLetters } from "../../server/decisions/parse";

const fx = (name: string) => fs.readFileSync(path.join(__dirname, "../fixtures/decisions", `${name}.txt`), "utf8");

describe("reading amounts, PINs and dates", () => {
  it("reads amounts the way letters print them, including commas read as periods", () => {
    expect(parseAmount("$182.484")).toBe("182484.00");
    expect(parseAmount("$9.741.19")).toBe("9741.19");
    expect(parseAmount("$26.954.69")).toBe("26954.69");
    expect(parseAmount("2,632,691")).toBe("2632691.00");
    expect(parseAmount("$134,042.")).toBe("134042.00");
    expect(parseAmount("0")).toBe("0.00");
    expect(parseAmount("62,8OO")).toBe("62800.00");
    expect(parseAmount("1.5")).toBeNull();
    expect(parseAmount("12,34")).toBe("12.34");
    expect(parseAmount("")).toBeNull();
  });
  it("finds Cook, collar and Will PINs and tidies OCR slips", () => {
    expect(findPins("05-17-302-010-0000 © 2319354-001")).toEqual(["05-17-302-010-0000"]);
    expect(findPins("PIN 16-05-302-014 and 16 - 05 - 302 - 015")).toEqual(["16-05-302-014", "16-05-302-015"]);
    expect(findPins("30-07-14-301-012-0000 and 30-07-14-301-013")).toEqual(["30-07-14-301-012-0000", "30-07-14-301-013"]);
    expect(findPins("O5-17-3O2-01O-0000")).toEqual(["05-17-302-010-0000"]);
    expect(findPins("Docket 2024-012345.001-R-1, complaint 2319354-001")).toEqual([]);
  });
  it("finds the first date in either style", () => {
    expect(findDate("x 03/27/2023 y")).toBe("2023-03-27");
    expect(findDate("Date: October 9, 2026")).toBe("2026-10-09");
    expect(findDate("13/45/2026")).toBeNull();
  });
});

describe("the four letters, read from OCR", () => {
  it("PTAB stipulation: agreement of the parties, Lake County, land and building, and no docket means review", () => {
    const f = parseLetter(fx("ptab-stipulation"));
    expect(f.kind).toBe("ptab");
    expect(f.outcome).toBe("agreed");
    expect(f.county).toBe("Lake");
    expect(f.pins).toEqual([{ pin: null, origAv: null, land: "63251.00", impr: "133416.00", av: "196667.00" }]);
    expect(f.reference).toBeNull();
    expect(f.problems).toContain("No docket number on the letter.");
  });
  it("PTAB reduction after a hearing", () => {
    const f = parseLetter(fx("ptab-reduction"));
    expect(f.outcome).toBe("reduced");
    expect(f.county).toBe("Cook");
    expect(f.pins[0]).toMatchObject({ land: "54450.00", impr: "53251.00", av: "107701.00" });
  });
  it("PTAB no change", () => {
    const f = parseLetter(fx("ptab-no-change"));
    expect(f.outcome).toBe("no_change");
    expect(f.pins[0]).toMatchObject({ land: "16625.00", impr: "42375.00", av: "59000.00" });
  });
  it("Cook BOR reduction: year, date, PIN, complaint, original, final and change", () => {
    const f = parseLetter(fx("bor-reduction"));
    expect(f).toMatchObject({ kind: "bor", county: "Cook", year: 2022, letterDate: "2023-03-27", outcome: "reduced", reference: "2319354-001" });
    expect(f.pins).toEqual([{ pin: "05-17-302-010-0000", origAv: "82000.00", land: null, impr: null, av: "62800.00", change: "19200.00", complaintNo: "2319354-001" }]);
    expect(f.problems).toEqual([]);
  });
  it("Cook BOR no change, with the PIN redacted", () => {
    const f = parseLetter(fx("bor-no-change"));
    expect(f).toMatchObject({ kind: "bor", year: 2024, letterDate: "2025-04-23", outcome: "no_change" });
    expect(f.pins).toEqual([{ pin: null, origAv: "262000.00", land: null, impr: null, av: "262000.00", change: "0.00", complaintNo: null }]);
  });
  it("Cook Assessor reduction with two PINs on the back page", () => {
    const f = parseLetter(fx("assessor-reduction"));
    expect(f).toMatchObject({ kind: "assessor", county: "Cook", year: 2024, letterDate: "2024-12-27", outcome: "reduced" });
    expect(f.pins.map((p) => [p.className, p.priorAv, p.origAv, p.av])).toEqual([
      ["591", "2632691.00", "3640905.00", "2895445.00"],
      ["591", "4883545.00", "6751845.00", "5367419.00"],
    ]);
  });
  it("Cook Assessor no change", () => {
    const f = parseLetter(fx("assessor-no-change"));
    expect(f).toMatchObject({ kind: "assessor", year: 2024, letterDate: "2024-12-16", outcome: "no_change" });
    expect(f.pins.map((p) => [p.className, p.origAv, p.av])).toEqual([["212", "61001.00", "61001.00"]]);
  });
  it("Circuit Court agreed judgment: values, factor, rate and refund, with OCR's periods for commas", () => {
    const f = parseLetter(fx("circuit-reduction"));
    expect(f).toMatchObject({
      kind: "circuit", county: "Cook", year: 2021, outcome: "reduced",
      excessAv: "48442.00", refund: "9741.19", equalizer: "3.0027", taxRatePercent: "6.697",
    });
    expect(f.pins[0]).toMatchObject({ origAv: "182484.00", av: "134042.00" });
  });
});

describe("e-filed text and stacks of letters", () => {
  const ptab = [
    "FINAL ADMINISTRATIVE DECISION", "ILLINOIS PROPERTY TAX APPEAL BOARD",
    "APPELLANT: Sample Owner LLC", "DOCKET NO.: 2024-012345.001-C-1", "PARCEL NO.: 17-08-101-022-0000",
    "Based on the facts and exhibits presented in this matter, the Property Tax Appeal Board hereby finds A Reduction in the assessment of the property as established by the Cook County Board of Review is warranted.",
    "LAND: $103,125", "IMPR.: $240,000", "TOTAL: $343,125",
  ].join("\n");
  it("takes the year from the docket", () => {
    const f = parseLetter(ptab);
    expect(f).toMatchObject({ reference: "2024-012345.001-C-1", year: 2024, outcome: "reduced" });
    expect(f.pins).toEqual([{ pin: "17-08-101-022-0000", origAv: null, land: "103125.00", impr: "240000.00", av: "343125.00" }]);
    expect(f.problems).toEqual([]);
  });
  it("reads an OCR'd docket with letters for digits", () => {
    expect(parseLetter(ptab.replace("2024-012345.001-C-1", "2O24 - 0l2345 . 001 - C - 1")).reference).toBe("2024-012345.001-C-1");
  });
  it("splits a stack: an Assessor letter's back page stays with it, a blank back side is folded in", () => {
    const a = fx("assessor-no-change");
    const back = a.lastIndexOf("Cook County Assessor's Office");
    const pages = [fx("bor-reduction"), "", a.slice(0, back), a.slice(back), ptab, "Docket No: 2024-012345.001-C-1\npage 2 of the decision, findings and reasons"];
    expect(pages.map((p) => classifyPage(p).kind)).toEqual(["bor", "unknown", "assessor", "assessor", "ptab", "ptab"]);
    expect(splitIntoLetters(pages)).toEqual([
      { from: 1, to: 2, kind: "bor" },
      { from: 3, to: 4, kind: "assessor" },
      { from: 5, to: 6, kind: "ptab" },
    ]);
  });
  it("an unreadable page is its own letter of unknown kind", () => {
    const f = parseLetter("Some page nobody can classify, with enough words to not be blank.");
    expect(f.kind).toBe("unknown");
    expect(f.problems).toEqual(["Couldn't tell what kind of letter this is."]);
  });
});

describe("OCR slips seen on scans", () => {
  it("splits figures run together and reads a semicolon as a comma", () => {
    const f = parseLetter(["COOK COUNTY", "BOARD OF REVIEW", "1002/2026", "BOR COMPLAINT TYPE: P", "directed the Assessor to reduce the assessed value", "2026 Assessed Valuations",
      "05-17-302-010-0000 2634518-001. 70,000.63,000 7;000"].join("\n"));
    expect(f.letterDate).toBe("2026-10-02");
    expect(f.pins[0]).toMatchObject({ pin: "05-17-302-010-0000", origAv: "70000.00", av: "63000.00", change: "7000.00", complaintNo: "2634518-001" });
  });
});

describe("collar-county numbering", () => {
  it("doesn't read a Lake County complaint number as money", () => {
    const f = parseLetter(["LAKE COUNTY", "BOARD OF REVIEW", "10/01/2026", "BOR COMPLAINT TYPE: P", "directed the Assessor to reduce the assessed value", "2026 Assessed Valuations",
      "16-05-302-014      2026-00451      612,000      575,000      37,000"].join("\n"));
    expect(f).toMatchObject({ county: "Lake", reference: "2026-00451" });
    expect(f.pins[0]).toMatchObject({ pin: "16-05-302-014", origAv: "612000.00", av: "575000.00", change: "37000.00" });
  });
});
