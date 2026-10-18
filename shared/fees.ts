// Which fee percent applies to an appeal. Most specific wins:
// appeal -> property -> account -> firm default for that level.
// A "no fee" flag on the property or the account means nothing is billed
// (the fee is still shown, as waived).

import type { Level } from "./domain.js";
import { feeAmount } from "./money.js";

export type FeeBasis = "first_year_savings" | "refund";

export interface FeeSources {
  firmDefaults: { level: Level; percent: string; basis: FeeBasis }[];
  account?: { fee_percent_first_year: string | null; fee_percent_refund: string | null; no_fee: boolean } | null;
  property?: { fee_percent_first_year: string | null; fee_percent_refund: string | null; no_fee: boolean } | null;
  appeal?: { fee_percent: string | null } | null;
}

export interface EffectiveFee {
  percent: string;
  basis: FeeBasis;
  source: "appeal" | "property" | "account" | "firm";
  noFee: boolean;
}

export function isRefundLevel(level: Level): boolean {
  return level === "ptab" || level === "circuit";
}

export function effectiveFee(level: Level, s: FeeSources): EffectiveFee {
  const def = s.firmDefaults.find((d) => d.level === level);
  const basis: FeeBasis = def?.basis ?? (isRefundLevel(level) ? "refund" : "first_year_savings");
  const key = basis === "refund" ? "fee_percent_refund" : "fee_percent_first_year";
  const noFee = Boolean(s.property?.no_fee || s.account?.no_fee);
  if (s.appeal?.fee_percent != null) return { percent: s.appeal.fee_percent, basis, source: "appeal", noFee };
  if (s.property?.[key] != null) return { percent: s.property[key]!, basis, source: "property", noFee };
  if (s.account?.[key] != null) return { percent: s.account[key]!, basis, source: "account", noFee };
  return { percent: def?.percent ?? (isRefundLevel(level) ? "33.33" : "40.00"), basis, source: "firm", noFee };
}

/** Fee on first-year savings for Assessor/BOR. Refund-basis fees are computed from the refund check later. */
export function firstYearFee(savings: string | null, fee: EffectiveFee): string | null {
  if (savings === null || fee.basis !== "first_year_savings") return null;
  return feeAmount(savings, fee.percent);
}
