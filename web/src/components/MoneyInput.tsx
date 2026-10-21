// A number box for dollar figures: type plain digits (or paste "$61,875" or "(1,250)"),
// and once the cursor leaves the box it shows in accounting format. The value passed
// up is always a plain decimal string ("61875", "-1250.5") or null when empty.

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { formatMoney, formatValue } from "../format";

/** "$61,875" / "(1,250.00)" / " 61875 " → "61875" / "-1250.00"; "" → null. Anything unreadable comes back as typed. */
export function plainNumber(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const body = t.replace(/[()$,\s-]/g, "");
  if (!/^\d*\.?\d*$/.test(body) || body === "" || body === ".") return t;
  return `${neg ? "-" : ""}${body}`;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  /** Money (taxes, refunds): always 2 decimals. Otherwise a value (AV, FMV): whole dollars unless the person shows cents. */
  money?: boolean;
};

export function MoneyInput({ value, onChange, money, className, onFocus, onBlur, ...rest }: Props) {
  const show = (v: string | null | undefined) => {
    if (v === null || v === undefined || v === "") return "";
    if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
    return money ? formatMoney(v) : formatValue(v);
  };
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(show(value));
  useEffect(() => { if (!focused) setText(show(value)); }, [value, focused]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = text.trim() !== "" && !/^-?\d+(\.\d{0,2})?$/.test(plainNumber(text) ?? "");
  return (
    <input
      {...rest}
      className={`in num${className ? ` ${className}` : ""}`}
      inputMode="decimal"
      aria-invalid={bad || undefined}
      value={text}
      onFocus={(e) => { setFocused(true); setText(value ? value.replace(/\.00$/, "") : ""); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); setText(show(plainNumber(text))); onBlur?.(e); }}
      onChange={(e) => { setText(e.target.value); onChange(plainNumber(e.target.value)); }}
    />
  );
}

/**
 * The same format-on-blur for editors that keep what was typed as a draft string (the
 * Values tab): the draft stays exactly as typed, and only the display changes when the
 * cursor leaves. Anything that isn't a readable figure is shown as typed.
 */
export function AmountInput({ value, onChange, money, className, onFocus, onBlur, ...rest }:
  Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onChange: (value: string) => void; money?: boolean }) {
  const [focused, setFocused] = useState(false);
  const plain = plainNumber(value);
  const readable = plain !== null && /^-?\d{1,12}(\.\d{1,2})?$/.test(plain);
  const display = focused || !readable ? value : money ? formatMoney(plain) : formatValue(plain);
  return (
    <input
      {...rest}
      className={className ?? "in num"}
      inputMode="decimal"
      value={display}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
