-- ============================================================
-- 003 Core firm data: fee defaults, accounts (clients), contacts,
-- properties (the matter), parcels, appeals, activities.
--
-- Every table: firm_id NOT NULL + index + row-level security + audit.
-- Relationships use composite foreign keys on (firm_id, id), so the
-- database itself refuses to link a property to another firm's client
-- or assign another firm's user, even if application code tried.
-- Money is NUMERIC(14,2); equalizers NUMERIC(8,4); rates are percents
-- in NUMERIC(10,6), e.g. 7.943607.
-- ============================================================

CREATE TABLE IF NOT EXISTS fee_defaults (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  level TEXT NOT NULL CHECK (level IN ('assessor', 'bor', 'ptab', 'circuit')),
  percent NUMERIC(5, 2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  basis TEXT NOT NULL CHECK (basis IN ('first_year_savings', 'refund')),
  UNIQUE (firm_id, level)
);
CREATE INDEX IF NOT EXISTS idx_fee_defaults_firm ON fee_defaults (firm_id);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual', 'entity')),
  account_number TEXT,
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, zip TEXT,
  phone TEXT,
  email TEXT,
  account_rep_user_id INTEGER,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  fee_type TEXT NOT NULL DEFAULT 'contingency' CHECK (fee_type IN ('contingency', 'flat')),
  fee_percent_first_year NUMERIC(5, 2), -- NULL means use the firm default
  fee_percent_refund NUMERIC(5, 2),     -- NULL means use the firm default
  fee_cap NUMERIC(14, 2),
  flat_fee NUMERIC(14, 2),
  fee_memo TEXT,
  no_fee BOOLEAN NOT NULL DEFAULT false,
  co_counsel TEXT,
  co_counsel_fee TEXT,
  owners_of_record TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_rep_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_firm ON accounts (firm_id);

CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  property_number TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'inactive', 'sold')),
  asset_type TEXT NOT NULL DEFAULT 'residential' CHECK (asset_type IN ('residential', 'commercial', 'industrial')),
  use_type TEXT,
  address1 TEXT, address2 TEXT, city TEXT, state TEXT NOT NULL DEFAULT 'IL', zip TEXT,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  township_id INTEGER REFERENCES townships(id),
  tax_code TEXT,
  tax_code_confirmed BOOLEAN NOT NULL DEFAULT false,
  level_of_assessment NUMERIC(5, 2), -- percent: 10, 25, 33.33
  attorney_user_id INTEGER,
  analyst_user_id INTEGER,
  no_fee BOOLEAN NOT NULL DEFAULT false,
  fee_percent_first_year NUMERIC(5, 2),
  fee_percent_refund NUMERIC(5, 2),
  purchase_date DATE,
  purchase_price NUMERIC(14, 2),
  year_built INTEGER,
  building_sqft INTEGER,
  units INTEGER,
  acreage NUMERIC(10, 4),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, attorney_user_id) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, analyst_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_properties_firm ON properties (firm_id);
CREATE INDEX IF NOT EXISTS idx_properties_account ON properties (firm_id, account_id);

CREATE TABLE IF NOT EXISTS parcels (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  pin TEXT NOT NULL,
  alternate_pin TEXT,
  owner_name TEXT,
  parcel_type TEXT NOT NULL DEFAULT 'real' CHECK (parcel_type IN ('real', 'personal')),
  class TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, pin),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_parcels_firm ON parcels (firm_id);
CREATE INDEX IF NOT EXISTS idx_parcels_property ON parcels (firm_id, property_id);

CREATE TABLE IF NOT EXISTS appeals (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  parcel_id INTEGER, -- NULL means the appeal covers the whole property
  assessment_year INTEGER NOT NULL,
  -- The tax year whose equalizer and rate the savings are computed with
  -- (the most recently published one when the appeal was valued), which is
  -- the "Tax Year" column in the prior software.
  tax_year INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('assessor', 'bor', 'ptab', 'circuit')),
  substage TEXT NOT NULL DEFAULT 'under_review' CHECK (substage IN (
    'under_review', 'fairly_assessed', 'appeal_filed', 'hearing_scheduled',
    'decision_analysis', 'invoice_sent', 'pushed_next_level', 'closed'
  )),
  substage_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'waiting_decision', 'reduced', 'no_change', 'increased', 'withdrawn', 'dismissed'
  )),
  external_id TEXT,      -- appeal / filing ID from the tribunal or prior software
  petition_no TEXT,
  filed_on DATE,
  hearing_at TIMESTAMPTZ,
  decision_on DATE,
  representative_user_id INTEGER,
  -- assessed values; components are optional, totals are what the math uses
  orig_land_av NUMERIC(14, 2), orig_impr_av NUMERIC(14, 2), orig_personal_av NUMERIC(14, 2), orig_adjust_av NUMERIC(14, 2),
  orig_av NUMERIC(14, 2),
  target_land_av NUMERIC(14, 2), target_impr_av NUMERIC(14, 2), target_personal_av NUMERIC(14, 2), target_adjust_av NUMERIC(14, 2),
  target_av NUMERIC(14, 2),
  resolved_land_av NUMERIC(14, 2), resolved_impr_av NUMERIC(14, 2), resolved_personal_av NUMERIC(14, 2), resolved_adjust_av NUMERIC(14, 2),
  resolved_av NUMERIC(14, 2),
  assessment_ratio NUMERIC(5, 2), -- level of assessment used to show FMV (AV / ratio)
  -- the inputs the tax math used, and where they came from
  equalizer NUMERIC(8, 4),
  equalizer_source TEXT,
  tax_rate_percent NUMERIC(10, 6),
  tax_rate_source TEXT,
  original_tax NUMERIC(14, 2),
  target_tax NUMERIC(14, 2),
  resolved_tax NUMERIC(14, 2),
  estimated_savings NUMERIC(14, 2), -- original tax minus target tax, before a decision
  savings NUMERIC(14, 2),           -- achieved: original tax minus resolved tax
  calc_override BOOLEAN NOT NULL DEFAULT false, -- true: tax figures were entered or imported, not computed
  exclude_from_totals BOOLEAN NOT NULL DEFAULT false,
  fee_percent NUMERIC(5, 2), -- NULL means inherit (property, then account, then firm)
  next_action TEXT,
  next_action_on DATE,
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'import', 'sample')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, parcel_id) REFERENCES parcels (firm_id, id),
  FOREIGN KEY (firm_id, representative_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_appeals_firm ON appeals (firm_id);
CREATE INDEX IF NOT EXISTS idx_appeals_property ON appeals (firm_id, property_id, assessment_year);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER,
  property_id INTEGER,
  name TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('primary', 'billing', 'owner', 'other')),
  email TEXT, phone TEXT, mobile TEXT,
  address1 TEXT, city TEXT, state TEXT, zip TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  CHECK (account_id IS NOT NULL OR property_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contacts_firm ON contacts (firm_id);

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER,
  property_id INTEGER,
  appeal_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'call', 'email', 'task')),
  subject TEXT NOT NULL,
  body TEXT,
  due_on DATE,
  assigned_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_by_user_id INTEGER,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, assigned_user_id) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, created_by_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_activities_firm ON activities (firm_id);
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities (firm_id, status, due_on);

-- ---------------------------------------------------------------- locks, audit, timestamps
SELECT app_enable_firm_rls(t) FROM unnest(ARRAY[
  'fee_defaults', 'accounts', 'properties', 'parcels', 'appeals', 'contacts', 'activities'
]::regclass[]) AS t;

SELECT app_attach_audit(t) FROM unnest(ARRAY[
  'fee_defaults', 'accounts', 'properties', 'parcels', 'appeals', 'contacts', 'activities'
]::regclass[]) AS t;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'properties', 'parcels', 'appeals', 'contacts', 'activities'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at_trg ON %I', t);
    EXECUTE format('CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
  END LOOP;
END $$;
