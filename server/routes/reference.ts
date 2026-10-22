// Global reference data: readable by every signed-in user. Only the super
// admin can change it (routes/admin-reference.ts).

import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../auth.js";

export const referenceRouter = Router();
referenceRouter.use(requireAuth);

referenceRouter.get("/counties", async (_req, res) => {
  const counties = (await query(
    `SELECT c.id, c.state, c.name, COALESCE(r.multifamily_residential_max_units, 6) AS multifamily_max_units
       FROM counties c LEFT JOIN county_rules r ON r.county_id = c.id ORDER BY c.state, c.name`,
  )).rows;
  const townships = (await query(`SELECT id, county_id, name, triad FROM townships ORDER BY name`)).rows;
  res.json({ counties, townships });
});

/** Level of assessment by class code, per county (the longest matching prefix wins; blank covers every class). */
referenceRouter.get("/class-levels", async (_req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.county_id, c.name AS county, l.class_prefix, l.level_percent, l.label, l.updated_at
       FROM class_assessment_levels l JOIN counties c ON c.id = l.county_id
      ORDER BY c.name, l.class_prefix`,
  );
  res.json({ classLevels: rows });
});

referenceRouter.get("/windows", async (req, res) => {
  const year = Number(req.query.year) || null;
  const { rows } = await query(
    `SELECT w.id, w.county_id, w.township_id, c.name AS county, t.name AS township, w.level, w.assessment_year, w.opens_on, w.closes_on,
            w.note, w.is_sample, w.updated_at
       FROM filing_windows w JOIN counties c ON c.id = w.county_id LEFT JOIN townships t ON t.id = w.township_id
      WHERE ($1::int IS NULL OR w.assessment_year = $1)
      ORDER BY w.closes_on, c.name, t.name`,
    [year],
  );
  res.json({ windows: rows });
});

referenceRouter.get("/equalizers", async (_req, res) => {
  const { rows } = await query(
    `SELECT e.id, e.county_id, e.township_id, c.name AS county, t.name AS township, e.year, e.factor, e.source, e.is_sample, e.updated_at
       FROM equalizers e JOIN counties c ON c.id = e.county_id LEFT JOIN townships t ON t.id = e.township_id
      ORDER BY e.year DESC, c.name, t.name NULLS FIRST`,
  );
  res.json({ equalizers: rows });
});

referenceRouter.get("/tax-rates", async (req, res) => {
  const taxCode = typeof req.query.taxCode === "string" ? req.query.taxCode : null;
  const { rows } = await query(
    `SELECT r.id, r.county_id, c.name AS county, r.tax_code, r.tax_year, r.rate_percent, r.source, r.is_sample, r.updated_at
       FROM tax_rates r JOIN counties c ON c.id = r.county_id
      WHERE ($1::text IS NULL OR r.tax_code = $1)
      ORDER BY r.tax_year DESC, c.name, r.tax_code LIMIT 2000`,
    [taxCode],
  );
  res.json({ taxRates: rows });
});
