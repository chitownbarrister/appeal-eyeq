// Exact decimal arithmetic for tax math. No floating point anywhere:
// values are parsed from decimal strings into BigInt with a known scale,
// multiplied exactly, and rounded once, half-up, to the cent.
//
// Conventions (match the database column types):
//   money / AV     2 decimals        e.g. "70000.00"
//   equalizer      up to 4 decimals  e.g. "3.0355"
//   tax rate       percent, up to 6  e.g. "7.943607" means 7.943607%
//   fee percent    up to 2 decimals  e.g. "40", "33.33"

export type DecimalInput = string | number;

interface Scaled {
  value: bigint; // the number times 10^scale
  scale: number;
}

function parse(input: DecimalInput): Scaled {
  const raw = typeof input === "number" ? numberToString(input) : String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Not a decimal number: "${raw}"`);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, frac = ""] = unsigned.split(".");
  const value = BigInt(whole + frac) * (negative ? -1n : 1n);
  return { value, scale: frac.length };
}

function numberToString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  // Integers and short decimals only; anything else should arrive as a string.
  const s = String(n);
  if (s.includes("e")) throw new Error(`Pass very large or small numbers as strings: ${n}`);
  return s;
}

/** Divide and round half-up (away from zero on .5). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** Cents (BigInt) to a "1234.56" string. */
export function centsToString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Parse a money string ("1736.12") to cents, requiring at most 2 decimals. */
export function toCents(input: DecimalInput): bigint {
  const { value, scale } = parse(input);
  if (scale > 2) {
    return divRoundHalfUp(value, 10n ** BigInt(scale - 2));
  }
  return value * 10n ** BigInt(2 - scale);
}

/** Multiply any number of decimals exactly, divide by `divisor`, round to cents. */
function productToCents(factors: DecimalInput[], divisor: bigint = 1n): bigint {
  let value = 1n;
  let scale = 0;
  for (const f of factors) {
    const p = parse(f);
    value *= p.value;
    scale += p.scale;
  }
  // value / 10^scale / divisor = dollars; we want cents (x100).
  return divRoundHalfUp(value * 100n, 10n ** BigInt(scale) * divisor);
}

/** Net tax = AV x equalizer x rate%, rounded to the cent. */
export function netTax(av: DecimalInput, equalizer: DecimalInput, ratePercent: DecimalInput): string {
  return centsToString(productToCents([av, equalizer, ratePercent], 100n));
}

/** Equalized value (EAV) = AV x equalizer, rounded to the cent. */
export function equalizedValue(av: DecimalInput, equalizer: DecimalInput): string {
  return centsToString(productToCents([av, equalizer]));
}

/**
 * Savings for one level: net tax on the AV going into the level minus net
 * tax on the resolved AV. Each net tax is rounded to the cent first, the way
 * a tax bill would show it, then subtracted.
 */
export function levelSavings(
  avIntoLevel: DecimalInput,
  resolvedAv: DecimalInput,
  equalizer: DecimalInput,
  ratePercent: DecimalInput,
): string {
  const before = toCents(netTax(avIntoLevel, equalizer, ratePercent));
  const after = toCents(netTax(resolvedAv, equalizer, ratePercent));
  return centsToString(before - after);
}

/** Fee = savings (or refund) x fee%, rounded to the cent. */
export function feeAmount(base: DecimalInput, feePercent: DecimalInput): string {
  return centsToString(productToCents([toCentsString(base), feePercent], 100n));
}

function toCentsString(input: DecimalInput): string {
  return centsToString(toCents(input));
}

/** Add money strings exactly. */
export function sumMoney(values: DecimalInput[]): string {
  return centsToString(values.reduce<bigint>((acc, v) => acc + toCents(v), 0n));
}

/** Display: "$1,736.12" (always 2 decimals). */
export function formatMoney(input: DecimalInput | null | undefined): string {
  if (input === null || input === undefined || input === "") return "";
  const s = centsToString(toCents(input));
  const negative = s.startsWith("-");
  const [whole, frac] = (negative ? s.slice(1) : s).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${frac}`;
}
