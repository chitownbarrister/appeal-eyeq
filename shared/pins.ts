// Several PINs on one appeal: the values each PIN carries, the property total,
// fair market value, and how an agreed total is divided among the PINs.
// Exact decimal math on cents (BigInt); everything is to the penny.
//
// The firm's method (Dillon, Oct 20, 2026):
//  - Negotiation is on the total. Each PIN under appeal gets its share of the
//    agreed AV in proportion to its share of the original AV of the PINs under appeal.
//  - Within a PIN, land stays at its original value and the building takes the
//    change ("Way B"). A PIN with no building (or a cut bigger than its building)
//    takes the rest off its land.
//  - Leftover cents from dividing go to the PIN with the largest share, so the
//    PINs always add up exactly to the agreed total.
//  - FMV = AV ÷ level of assessment. 33.33% means one third exactly (FMV = AV × 3).

import { centsToString, toCents } from "./money.js";

export interface PinValue { land: string | null; impr: string | null; av: string | null }
export interface PinInput extends PinValue { key: string | number }
export interface PinResult { key: string | number; land: string | null; impr: string | null; av: string }

/** A PIN's AV for one stage: land + building when both are known, otherwise the AV given. */
export function pinAv(v: PinValue): string | null {
  if (v.land !== null && v.impr !== null && v.land !== "" && v.impr !== "") return centsToString(toCents(v.land) + toCents(v.impr));
  return v.av === null || v.av === "" ? null : centsToString(toCents(v.av));
}

const isThird = (ratio: string) => toCents(ratio) === 3333n;

function divHalfUp(n: bigint, d: bigint): bigint {
  const neg = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (a * 2n + b) / (2n * b);
  return neg ? -q : q;
}

/** Fair market value from AV, to the penny. */
export function fmvFromAv(av: string | null | undefined, ratioPercent: string | null | undefined): string | null {
  if (av === null || av === undefined || av === "" || !ratioPercent || toCents(ratioPercent) === 0n) return null;
  const cents = toCents(av);
  if (isThird(ratioPercent)) return centsToString(cents * 3n);
  return centsToString(divHalfUp(cents * 10000n, toCents(ratioPercent)));
}

/** AV from a fair market value (an offer quoted as a value), to the penny. */
export function avFromFmv(fmv: string, ratioPercent: string): string {
  const cents = toCents(fmv);
  if (isThird(ratioPercent)) return centsToString(divHalfUp(cents, 3n));
  return centsToString(divHalfUp(cents * toCents(ratioPercent), 10000n));
}

/**
 * Divides an agreed total AV among the PINs under appeal (Way B).
 * Each PIN's original AV sets its share. Returns one result per PIN, in order.
 */
export function splitAgreedTotal(pins: PinInput[], agreedTotal: string): PinResult[] {
  if (!pins.length) return [];
  const orig = pins.map((p) => {
    const av = pinAv(p);
    if (av === null) throw Object.assign(new Error("missing"), { status: 400, publicMessage: "Every PIN on the appeal needs its original AV before a total can be divided." });
    return toCents(av);
  });
  const sumOrig = orig.reduce((a, b) => a + b, 0n);
  const total = toCents(agreedTotal);
  let shares: bigint[];
  if (sumOrig === 0n) {
    shares = pins.map((_, i) => (i === 0 ? total : 0n));
  } else {
    shares = orig.map((o) => (total * o) / sumOrig); // rounded down
    const left = total - shares.reduce((a, b) => a + b, 0n);
    let biggest = 0;
    orig.forEach((o, i) => { if (o > orig[biggest]) biggest = i; });
    shares[biggest] += left;
  }
  return pins.map((p, i) => {
    const av = shares[i];
    if (p.land === null || p.land === "" || p.impr === null || p.impr === "") return { key: p.key, land: null, impr: null, av: centsToString(av) };
    const land = toCents(p.land);
    const impr = av - land;
    if (impr < 0n) return { key: p.key, land: centsToString(av), impr: "0.00", av: centsToString(av) };
    return { key: p.key, land: centsToString(land), impr: centsToString(impr), av: centsToString(av) };
  });
}

/** Sums AVs, treating a missing value as missing (null) rather than zero. */
export function sumAvs(values: (string | null)[]): string | null {
  if (values.some((v) => v === null)) return null;
  return centsToString(values.reduce((a, v) => a + toCents(v!), 0n));
}

/** "60.6%": share of the requested reduction (original − target) that was achieved (original − resolved). */
export function requestedAchieved(orig: string | null, target: string | null, resolved: string | null): string | null {
  if (orig === null || target === null || resolved === null) return null;
  const asked = toCents(orig) - toCents(target);
  if (asked <= 0n) return null;
  const got = toCents(orig) - toCents(resolved);
  const tenths = divHalfUp(got * 1000n, asked);
  const neg = tenths < 0n;
  const abs = neg ? -tenths : tenths;
  return `${neg ? "-" : ""}${abs / 10n}.${abs % 10n}%`;
}
