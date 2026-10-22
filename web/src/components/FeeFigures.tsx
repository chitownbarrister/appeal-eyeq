// The fee terms as figures (Dillon, Oct 22: less text, more numbers): "Assessor/BOR 40% · PTAB/Court 33.33%",
// with No fee, Flat and Cap as small tags, and where each percent comes from on hover.

import type { EffectiveFee } from "../../../shared/fees";
import { formatMoney } from "../format";

const SOURCE: Record<EffectiveFee["source"], string> = {
  appeal: "set on the appeal", property: "set on this property", account: "the client's terms", firm: "the firm's default",
};

/** 40.00 → 40, 33.33 → 33.33, 12.50 → 12.5 */
export const pct = (v: string | number) => `${Number(v).toString()}%`;

export function FeeFigures({ firstYear, refund, noFee, flat, cap }: {
  firstYear: EffectiveFee; refund: EffectiveFee; noFee?: boolean; flat?: string | null; cap?: string | null;
}) {
  const tip = (label: string, f: EffectiveFee) =>
    `${label}: ${pct(f.percent)} of ${f.basis === "refund" ? "the refund" : "first-year savings"}, ${SOURCE[f.source]}`;
  return (
    <span className="fee-figs">
      {noFee && <span className="pill net">No fee</span>}
      {flat ? (
        <span className="ff" title="A flat fee instead of a percent">Flat <b className="num">{formatMoney(flat)}</b></span>
      ) : (
        <>
          <span className="ff" title={tip("Assessor and Board of Review", firstYear)}>Assessor/BOR <b className="num">{pct(firstYear.percent)}</b></span>
          <span className="sep" aria-hidden="true">·</span>
          <span className="ff" title={tip("PTAB and Circuit Court", refund)}>PTAB/Court <b className="num">{pct(refund.percent)}</b></span>
        </>
      )}
      {cap && <span className="pill grey" title="The most the fee can be">Cap {formatMoney(cap)}</span>}
    </span>
  );
}
