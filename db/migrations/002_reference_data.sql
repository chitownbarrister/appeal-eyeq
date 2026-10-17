-- ============================================================
-- 002 Global reference data: counties, townships, filing windows,
-- equalizers, tax rates.
--
-- These are the same for every firm, so they carry no firm_id and no
-- row-level security. Every firm can read them; only the super admin
-- can change them (enforced in the API). Every change is recorded in
-- reference_change_log, so a pushed update can always be traced.
-- ============================================================

CREATE TABLE IF NOT EXISTS counties (
  id SERIAL PRIMARY KEY,
  state TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (state, name)
);

CREATE TABLE IF NOT EXISTS townships (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  name TEXT NOT NULL,
  triad TEXT, -- Cook only: City, North, South
  UNIQUE (county_id, name)
);
CREATE INDEX IF NOT EXISTS idx_townships_county ON townships (county_id);

-- Levels used everywhere: assessor, bor (Board of Review), ptab, circuit.
CREATE TABLE IF NOT EXISTS filing_windows (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  township_id INTEGER REFERENCES townships(id), -- NULL means county-wide
  level TEXT NOT NULL CHECK (level IN ('assessor', 'bor', 'ptab', 'circuit')),
  assessment_year INTEGER NOT NULL,
  opens_on DATE NOT NULL,
  closes_on DATE NOT NULL,
  note TEXT,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (closes_on >= opens_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS filing_windows_unique
  ON filing_windows (county_id, COALESCE(township_id, 0), level, assessment_year);

-- Collar counties often set multipliers by township, so township is optional.
CREATE TABLE IF NOT EXISTS equalizers (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  township_id INTEGER REFERENCES townships(id), -- NULL means county-wide
  year INTEGER NOT NULL,
  factor NUMERIC(8, 4) NOT NULL CHECK (factor > 0),
  source TEXT,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS equalizers_unique
  ON equalizers (county_id, COALESCE(township_id, 0), year);

-- One composite rate per tax code (district) per tax year, as set by the
-- county clerk. Stored as a percent, e.g. 7.943607.
CREATE TABLE IF NOT EXISTS tax_rates (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  tax_code TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  rate_percent NUMERIC(10, 6) NOT NULL CHECK (rate_percent > 0),
  source TEXT,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (county_id, tax_code, tax_year)
);

CREATE TABLE IF NOT EXISTS reference_change_log (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  actor_user_id INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reference_change_log_at ON reference_change_log (at DESC);

CREATE OR REPLACE FUNCTION reference_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reference_change_log (table_name, row_id, action, before, after, actor_user_id)
  VALUES (
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    NULLIF(current_setting('app.user_id', true), '')::int
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS reference_audit_trg ON filing_windows;
CREATE TRIGGER reference_audit_trg AFTER INSERT OR UPDATE OR DELETE ON filing_windows
  FOR EACH ROW EXECUTE FUNCTION reference_audit_row();
DROP TRIGGER IF EXISTS reference_audit_trg ON equalizers;
CREATE TRIGGER reference_audit_trg AFTER INSERT OR UPDATE OR DELETE ON equalizers
  FOR EACH ROW EXECUTE FUNCTION reference_audit_row();
DROP TRIGGER IF EXISTS reference_audit_trg ON tax_rates;
CREATE TRIGGER reference_audit_trg AFTER INSERT OR UPDATE OR DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION reference_audit_row();

-- ---------------------------------------------------------------- real data
INSERT INTO counties (state, name) VALUES
  ('IL', 'Cook'), ('IL', 'DuPage'), ('IL', 'Kane'),
  ('IL', 'Lake'), ('IL', 'McHenry'), ('IL', 'Will')
ON CONFLICT (state, name) DO NOTHING;

-- All 38 Cook County townships, by reassessment triad.
INSERT INTO townships (county_id, name, triad)
SELECT c.id, t.name, t.triad
FROM counties c, (VALUES
  ('Hyde Park', 'City'), ('Jefferson', 'City'), ('Lake', 'City'), ('Lake View', 'City'),
  ('North Chicago', 'City'), ('Rogers Park', 'City'), ('South Chicago', 'City'), ('West Chicago', 'City'),
  ('Barrington', 'North'), ('Elk Grove', 'North'), ('Evanston', 'North'), ('Hanover', 'North'),
  ('Leyden', 'North'), ('Maine', 'North'), ('New Trier', 'North'), ('Niles', 'North'),
  ('Northfield', 'North'), ('Norwood Park', 'North'), ('Palatine', 'North'), ('Schaumburg', 'North'),
  ('Wheeling', 'North'),
  ('Berwyn', 'South'), ('Bloom', 'South'), ('Bremen', 'South'), ('Calumet', 'South'),
  ('Cicero', 'South'), ('Lemont', 'South'), ('Lyons', 'South'), ('Oak Park', 'South'),
  ('Orland', 'South'), ('Palos', 'South'), ('Proviso', 'South'), ('Rich', 'South'),
  ('River Forest', 'South'), ('Riverside', 'South'), ('Stickney', 'South'), ('Thornton', 'South'),
  ('Worth', 'South')
) AS t(name, triad)
WHERE c.state = 'IL' AND c.name = 'Cook'
ON CONFLICT (county_id, name) DO NOTHING;

-- Collar-county townships needed so far. The full lists are added through
-- the super admin reference screens.
INSERT INTO townships (county_id, name)
SELECT c.id, t.township
FROM counties c JOIN (VALUES
  ('Lake', 'Shields'), ('DuPage', 'Lisle'), ('McHenry', 'Algonquin'),
  ('Kane', 'St. Charles'), ('Kane', 'Geneva'), ('Will', 'Joliet')
) AS t(county, township) ON t.county = c.name AND c.state = 'IL'
ON CONFLICT (county_id, name) DO NOTHING;
