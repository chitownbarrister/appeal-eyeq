// Level of assessment and asset grouping for a property.
//
// The level of assessment comes from the primary PIN's class code under the county's rules
// (global reference data the super admin keeps), unless someone typed one on the property.
// It never follows the asset type's roll-up: in Cook, an apartment building of 7 or more units
// groups with Commercial but is Class 3 and assessed at 10%, like residential.

import type pg from "pg";

export type LevelSource = "manual" | "class" | "county" | "default";

export interface PropertyLevel {
  percent: string | null;
  source: LevelSource;
  classCode: string | null;
  label: string | null;
  assetGroup: string;
}

/** Used when there's no class code (or none matches): Cook residential and multi-family 10%, other Cook 25%, elsewhere 33.33%. */
export function fallbackLevel(countyName: string, assetType: string, assetGroup: string): string {
  if (countyName !== "Cook") return "33.33";
  return assetType === "multifamily" || assetGroup === "residential" ? "10.00" : "25.00";
}

export async function propertyLevel(c: pg.PoolClient, firmId: number, propertyId: number): Promise<PropertyLevel | null> {
  const r = (await c.query(
    `SELECT p.loa_manual, p.level_of_assessment, p.asset_type, co.name AS county,
            app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) AS asset_group,
            x.class, cl.level_percent, cl.label, cl.class_prefix
       FROM properties p JOIN counties co ON co.id = p.county_id
       LEFT JOIN LATERAL (SELECT y.class FROM parcels y WHERE y.firm_id = p.firm_id AND y.property_id = p.id ORDER BY y.is_primary DESC, y.id LIMIT 1) x ON true
       LEFT JOIN LATERAL (
         SELECT l.level_percent, l.label, l.class_prefix FROM class_assessment_levels l
          WHERE l.county_id = p.county_id AND upper(regexp_replace(COALESCE(x.class, ''), '[^0-9A-Za-z]', '', 'g')) LIKE l.class_prefix || '%'
          ORDER BY length(l.class_prefix) DESC LIMIT 1) cl ON true
      WHERE p.firm_id = $1 AND p.id = $2`,
    [firmId, propertyId],
  )).rows[0];
  if (!r) return null;
  const classCode = r.class ?? null;
  if (r.loa_manual && r.level_of_assessment !== null) {
    return { percent: r.level_of_assessment, source: "manual", classCode, label: null, assetGroup: r.asset_group };
  }
  if (r.level_percent !== null && r.level_percent !== undefined) {
    return { percent: r.level_percent, source: r.class_prefix === "" ? "county" : "class", classCode, label: r.label, assetGroup: r.asset_group };
  }
  return { percent: fallbackLevel(r.county, r.asset_type, r.asset_group), source: "default", classCode, label: null, assetGroup: r.asset_group };
}
