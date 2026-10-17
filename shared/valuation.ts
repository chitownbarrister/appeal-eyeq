import { centsToString, netTax, toCents } from "./money.js";

export interface AppealValueInputs {
  origAv: string | null;
  targetAv: string | null;
  resolvedAv: string | null;
  equalizer: string | null;
  taxRatePercent: string | null;
}

export interface AppealTaxFigures {
  originalTax: string | null;
  targetTax: string | null;
  resolvedTax: string | null;
  estimatedSavings: string | null;
  savings: string | null;
}

/**
 * Tax figures for one appeal from its AVs, equalizer and rate.
 * Net tax per AV is rounded to the cent first; savings are differences of
 * those rounded figures. Anything missing yields null rather than a guess.
 */
export function computeAppealTax(v: AppealValueInputs): AppealTaxFigures {
  const ready = v.equalizer !== null && v.taxRatePercent !== null;
  const tax = (av: string | null) => (ready && av !== null ? netTax(av, v.equalizer!, v.taxRatePercent!) : null);
  const originalTax = tax(v.origAv);
  const targetTax = tax(v.targetAv);
  const resolvedTax = tax(v.resolvedAv);
  const diff = (a: string | null, b: string | null) => (a !== null && b !== null ? centsToString(toCents(a) - toCents(b)) : null);
  return {
    originalTax,
    targetTax,
    resolvedTax,
    estimatedSavings: diff(originalTax, targetTax),
    savings: diff(originalTax, resolvedTax),
  };
}
