// Decision letters for tests, laid out like the real ones: as an e-filed PDF with
// a text layer, or as a "scan" (the page drawn as a slightly tilted, speckled picture
// in an image-only PDF), which goes through OCR.
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

export type Page = string[];

export const letters = {
  bor(o: { pin: string; complaint: string; year: number; date: string; orig: string; final: string; county?: string }): Page {
    const change = (Number(o.orig.replace(/,/g, "")) - Number(o.final.replace(/,/g, ""))).toLocaleString("en-US");
    const reduced = o.orig !== o.final;
    return [
      `${(o.county ?? "Cook").toUpperCase()} COUNTY`, "BOARD OF REVIEW", "118 NORTH CLARK STREET", "",
      o.date, "BOR COMPLAINT TYPE: P", "",
      reduced
        ? "As a result of the review of your complaint, the Commissioners have directed the Assessor to reduce the assessed value of your property as shown below:"
        : "As a result of the review of your complaint, the Board of Review has determined that a change in your present assessment is not warranted.",
      "", `${o.year} Assessed Valuations`,
      "Property Number      Board Complaint      Assessor Original      Board of Review Final      Change",
      `${o.pin}      ${o.complaint}      ${o.orig}      ${o.final}      ${reduced ? change : "0"}`,
      "", `If you are dissatisfied with your ${o.year} real estate assessment, you have the following options:`,
      "1. You may appeal this decision to the Property Tax Appeal Board within 30 days.",
      "3. You may file a tax objection complaint in the Circuit Court of Cook County, Illinois.",
    ];
  },
  assessor(o: { year: number; date: string; township: string; appealNo: string; rows: { pin: string; cls: string; prior: string; proposed: string; current: string }[] }): Page[] {
    const reduced = o.rows.some((r) => r.proposed !== r.current);
    return [[
      "Cook County Assessor's Office", "118 North Clark Street - Chicago, IL 60602", "", o.date,
      `NICHOLS LAW      ${o.year} Assessment Appeal`, `100 N. SAMPLE ST.      Township: ${o.township}`, `CHICAGO, IL 60600      Appeal Number: ${o.appealNo}`,
      "Property Index Number(s): See back of page", "",
      reduced
        ? "Our office determined the assessed valuation of your property should be reduced for the following reasons:"
        : "The Assessor's Office analyzed your assessment appeal and determined the assessed valuation should remain as originally proposed for the following reasons:",
      "This is a result of a market analysis of your property as well as an analysis of comparable properties.",
    ], [
      "Cook County Assessor's Office", "118 North Clark Street - Chicago, IL 60602", "",
      `Property Index Number (PIN)      Class      ${o.year - 1} Prior      ${o.year} Proposed      ${o.year} Current`,
      "Assessed Value      Assessed Value      Assessed Value",
      ...o.rows.map((r) => `${r.pin}      ${r.cls}      ${r.prior}      ${r.proposed}      ${r.current}`),
    ]];
  },
  ptab(o: { docket: string | null; pin: string; county: string; outcome: "reduction" | "no_change" | "agreed"; land: string; impr: string; total: string }): Page {
    const body = o.outcome === "agreed"
      ? ["Prior to the hearing the parties reached an agreement as to the correct assessment of the subject property.",
        `The Property Tax Appeal Board further finds that the agreement of the parties is proper for this ${o.county} County appeal, and the correct assessed valuation of the property is:`]
      : [`Based on the facts and exhibits presented in this matter, the Property Tax Appeal Board hereby finds ${o.outcome === "reduction" ? "A Reduction" : "No Change"} in the assessment of the property as established by the ${o.county} County Board of Review is warranted. The correct assessed valuation of the property is:`];
    return [
      "FINAL ADMINISTRATIVE DECISION", "ILLINOIS PROPERTY TAX APPEAL BOARD", "",
      "APPELLANT: Sample Owner LLC", `DOCKET NO.: ${o.docket ?? ""}`, `PARCEL NO.: ${o.pin}`, "",
      `The parties of record before the Property Tax Appeal Board are Sample Owner LLC, the appellant, by attorney Dillon Nichols, of Nichols Law in Chicago; and the ${o.county} County Board of Review.`,
      ...body, "", `LAND: $${o.land}`, `IMPR.: $${o.impr}`, `TOTAL: $${o.total}`, "", "Subject only to the State multiplier as applicable.",
    ];
  },
  circuit(o: { county: string; objectionNo: string; year: number; orig: string; correct: string; excess: string; factor: string; rate: string; refund: string; pin?: string }): Page {
    return [
      `IN THE CIRCUIT COURT OF ${o.county.toUpperCase()} COUNTY, ILLINOIS`, "COUNTY DEPARTMENT, COUNTY DIVISION", "",
      `Sample Owner LLC, Plaintiff, vs. County Collector, Defendant.      Valuation Objection No. ${o.objectionNo} (${o.year})`, "",
      "AGREED JUDGMENT ORDER", ...(o.pin ? [`PIN: ${o.pin}`] : []),
      "both parties having agreed to settle this objection pursuant to 35 ILCS 200/23-30. Based upon the following:",
      `1. The ${o.year} assessed valuation of $${o.orig}, before equalization, is excessive. The correct ${o.year} assessed valuation, before equalization, is $${o.correct}.`,
      `2. Applying the applicable equalization factor of ${o.factor}% and the applicable tax rate of ${o.rate}% to the correct assessed valuation.`,
      `Applying the same equalization factor and tax rate to the excess assessed valuation in the amount of $${o.excess} results in an excess payment of taxes.`,
      `3. THE DEFENDANT IS HEREBY ORDERED TO refund to the Plaintiff the sum of $${o.refund}, plus statutory interest, constituting the excess amount of taxes paid under protest for the year ${o.year}.`,
    ];
  },
};

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).trim().length > max) { out.push(line); line = w; } else line = `${line} ${w}`.trim();
  }
  if (line || !out.length) out.push(line);
  return out;
}

/** An e-filed letter: real text on the page. */
export async function textPdf(pages: Page[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (const l of lines.flatMap((x) => wrap(x, 95))) {
      if (l) page.drawText(l, { x: 50, y, size: 10, font });
      y -= 15;
    }
  }
  return Buffer.from(await doc.save());
}

function drawPage(lines: string[], tilt: number, type: "png" | "jpeg" = "png"): Buffer {
  const W = 1700, H = 2200; // letter size at 200 dpi
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(tilt);
  ctx.translate(-W / 2, -H / 2);
  ctx.fillStyle = "#111";
  ctx.font = "30px sans-serif";
  let y = 150;
  for (const l of lines.flatMap((x) => wrap(x, 85))) { ctx.fillText(l, 130, y); y += 46; }
  // speckle, like a copier
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#999";
  for (let i = 0; i < 400; i++) ctx.fillRect(rnd() * W, rnd() * H, 1.5, 1.5);
  return type === "png" ? c.toBuffer("image/png") : c.toBuffer("image/jpeg", 85);
}

/** A scanned letter: the pages as pictures, nothing to read but the picture. */
export async function scannedPdf(pages: Page[], opts: { upsideDown?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const [i, lines] of pages.entries()) {
    const png = await doc.embedPng(drawPage(lines, (opts.upsideDown ? Math.PI : 0) + (i % 2 ? -0.006 : 0.008)));
    const page = doc.addPage([612, 792]);
    page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  }
  return Buffer.from(await doc.save());
}

/** One page as a phone photo would arrive: a JPEG. */
export function scannedJpeg(lines: string[]): Buffer {
  return drawPage(lines, 0.01, "jpeg");
}
