// After the super admin publishes an equalizer or tax rate, every firm's
// undecided appeals in that county pick it up: their estimates are
// recalculated with the latest published figures. Decided appeals, and
// appeals whose equalizer or rate someone entered by hand, keep their
// numbers; the property page flags them with a one-click apply instead.
//
// Each firm is updated in its own transaction under a 'system' context for
// that firm, so the tenant lock and the audit trail still apply.

import { query, withContext } from "./db.js";
import { referenceFor, differsFromReference } from "./reference-lookup.js";
import { computeAppealTax } from "../shared/valuation.js";

export interface RefreshResult { appealsUpdated: number; firmsUpdated: number }

export async function refreshUndecidedAppeals(countyIds: number[]): Promise<RefreshResult> {
  const ids = [...new Set(countyIds)];
  if (!ids.length) return { appealsUpdated: 0, firmsUpdated: 0 };
  const firms = (await query<{ id: number }>(`SELECT id FROM firms ORDER BY id`)).rows;
  let appealsUpdated = 0;
  let firmsUpdated = 0;
  for (const f of firms) {
    const n = await withContext({ actorKind: "system", userId: null, firmId: f.id }, async (c) => {
      const rows = (await c.query(
        `SELECT a.id, a.orig_av, a.target_av, a.resolved_av, a.equalizer, a.tax_rate_percent,
                p.county_id, p.township_id, p.tax_code
           FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
          WHERE a.firm_id = $1 AND p.county_id = ANY($2::int[])
            AND a.status IN ('open', 'waiting_decision')
            AND a.substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed')
            AND NOT a.calc_override
            AND COALESCE(a.equalizer_source, '') NOT LIKE 'Entered by %'
            AND COALESCE(a.tax_rate_source, '') NOT LIKE 'Entered by %'
          FOR UPDATE OF a`,
        [f.id, ids],
      )).rows;
      let changed = 0;
      for (const a of rows) {
        const ref = await referenceFor(c, a.county_id, a.township_id, a.tax_code);
        if (!ref.rate || !ref.equalizer || !differsFromReference(a, ref)) continue;
        const t = computeAppealTax({
          origAv: a.orig_av, targetAv: a.target_av, resolvedAv: a.resolved_av,
          equalizer: ref.equalizer.factor, taxRatePercent: ref.rate.ratePercent,
        });
        await c.query(
          `UPDATE appeals SET equalizer = $3, equalizer_source = $4, tax_rate_percent = $5, tax_rate_source = $6, tax_year = $7,
                  original_tax = $8, target_tax = $9, resolved_tax = $10, estimated_savings = $11, savings = $12
            WHERE firm_id = $1 AND id = $2`,
          [f.id, a.id, ref.equalizer.factor, ref.equalizer.source, ref.rate.ratePercent, ref.rate.source, ref.rate.taxYear,
           t.originalTax, t.targetTax, t.resolvedTax, t.estimatedSavings, t.savings],
        );
        changed++;
      }
      return changed;
    });
    appealsUpdated += n;
    if (n) firmsUpdated++;
  }
  return { appealsUpdated, firmsUpdated };
}
