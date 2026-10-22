-- Delivery 10a: asset types with a roll-up and county rules, level of assessment from the
-- PIN's class code, calendar entries (meetings, calls, reminders), and invoice design
-- (logo, accent color, remittance details) with PDFs attached to an invoice.
-- Global reference tables carry no firm_id and are changed only by the super admin;
-- firm tables are firm-scoped with forced row-level security. Safe to run twice.

-- ---------------------------------------------------------------- 1: level of assessment by class code (global)
-- The longest matching prefix of a PIN's class code wins: Cook "3-14" or "314" matches "3".
-- An empty prefix covers every class in that county (the collar counties' statutory 33.33%).
CREATE TABLE IF NOT EXISTS class_assessment_levels (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL REFERENCES counties(id),
  class_prefix TEXT NOT NULL CHECK (class_prefix ~ '^[0-9A-Z]{0,4}$'),
  level_percent NUMERIC(5, 2) NOT NULL CHECK (level_percent > 0 AND level_percent <= 100),
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (county_id, class_prefix)
);
DROP TRIGGER IF EXISTS reference_audit_trg ON class_assessment_levels;
CREATE TRIGGER reference_audit_trg AFTER INSERT OR UPDATE OR DELETE ON class_assessment_levels
  FOR EACH ROW EXECUTE FUNCTION reference_audit_row();

-- Cook County Classification Ordinance: classes 2 and 3 (including apartments of 7+ units) at 10%,
-- commercial and industrial class 5 at 25%; the incentive classes at 10% in their first years.
INSERT INTO class_assessment_levels (county_id, class_prefix, level_percent, label)
SELECT c.id, v.prefix, v.pct, v.label
  FROM counties c, (VALUES
    ('1', 10.00, 'Vacant land'),
    ('2', 10.00, 'Residential, 6 units or fewer'),
    ('3', 10.00, 'Multi-family, 7 units or more'),
    ('4', 25.00, 'Not-for-profit'),
    ('5', 25.00, 'Commercial and industrial'),
    ('6', 10.00, 'Industrial incentive (first 10 years)'),
    ('7', 10.00, 'Commercial incentive (first 10 years)'),
    ('8', 10.00, 'Incentive in an area in need (first 10 years)'),
    ('9', 10.00, 'Affordable multi-family rental')
  ) AS v(prefix, pct, label)
 WHERE c.state = 'IL' AND c.name = 'Cook'
ON CONFLICT (county_id, class_prefix) DO NOTHING;

INSERT INTO class_assessment_levels (county_id, class_prefix, level_percent, label)
SELECT c.id, '', 33.33, 'All classes (statutory one-third)'
  FROM counties c WHERE c.state = 'IL' AND c.name <> 'Cook'
ON CONFLICT (county_id, class_prefix) DO NOTHING;

CREATE OR REPLACE FUNCTION app_class_level(p_county INTEGER, p_class TEXT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT l.level_percent FROM class_assessment_levels l
   WHERE l.county_id = p_county
     AND upper(regexp_replace(COALESCE(p_class, ''), '[^0-9A-Za-z]', '', 'g')) LIKE l.class_prefix || '%'
   ORDER BY length(l.class_prefix) DESC
   LIMIT 1
$$;

-- ---------------------------------------------------------------- 2: county rules (global): where Multi-family groups
CREATE TABLE IF NOT EXISTS county_rules (
  id SERIAL PRIMARY KEY,
  county_id INTEGER NOT NULL UNIQUE REFERENCES counties(id),
  -- Multi-family with this many units or fewer groups as Residential; more groups as Commercial.
  multifamily_residential_max_units INTEGER NOT NULL DEFAULT 6 CHECK (multifamily_residential_max_units BETWEEN 1 AND 10000),
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS reference_audit_trg ON county_rules;
CREATE TRIGGER reference_audit_trg AFTER INSERT OR UPDATE OR DELETE ON county_rules
  FOR EACH ROW EXECUTE FUNCTION reference_audit_row();
INSERT INTO county_rules (county_id, multifamily_residential_max_units)
SELECT id, 6 FROM counties
ON CONFLICT (county_id) DO NOTHING;

-- ---------------------------------------------------------------- 3: asset types, roll-up and override
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_asset_type_check;
ALTER TABLE properties ADD CONSTRAINT properties_asset_type_check CHECK (asset_type IN (
  'residential', 'commercial', 'industrial', 'medical', 'retail', 'hospitality', 'multifamily', 'flex', 'data_center'));
-- Multi-family only: group it as Residential or Commercial regardless of its unit count.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS asset_group_override TEXT;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_asset_group_override_check;
ALTER TABLE properties ADD CONSTRAINT properties_asset_group_override_check
  CHECK (asset_group_override IS NULL OR (asset_type = 'multifamily' AND asset_group_override IN ('residential', 'commercial')));
-- true: someone typed the level of assessment; false: it comes from the class code under the county's rules.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS loa_manual BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app_asset_group(p_type TEXT, p_units INTEGER, p_county INTEGER, p_override TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_type IN ('residential', 'commercial', 'industrial') THEN p_type
    WHEN p_type IN ('medical', 'retail', 'hospitality') THEN 'commercial'
    WHEN p_type IN ('flex', 'data_center') THEN 'industrial'
    WHEN p_type = 'multifamily' THEN COALESCE(p_override,
      CASE WHEN p_units IS NOT NULL AND p_units > COALESCE((SELECT r.multifamily_residential_max_units FROM county_rules r WHERE r.county_id = p_county), 6)
           THEN 'commercial' ELSE 'residential' END)
    ELSE 'commercial' END
$$;

-- Existing properties, firm by firm under the tenant lock: a level of assessment that differs from
-- what the old default gave was typed by someone, so it stays theirs; the rest now follow the class
-- code. A "Use" that names a specialty type becomes that type when it sits in the same group.
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);

    UPDATE properties p SET loa_manual = true
      FROM counties co
     WHERE p.firm_id = f.id AND co.id = p.county_id AND NOT p.loa_manual AND p.level_of_assessment IS NOT NULL
       AND p.level_of_assessment <> CASE WHEN co.name = 'Cook'
             THEN CASE WHEN app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) = 'residential' THEN 10.00 ELSE 25.00 END
             ELSE 33.33 END;

    UPDATE properties SET asset_type = 'medical'
     WHERE firm_id = f.id AND asset_type = 'commercial' AND use_type ~* '(medical|clinic|hospital|dental|surgery|physician)';
    UPDATE properties SET asset_type = 'retail'
     WHERE firm_id = f.id AND asset_type = 'commercial' AND use_type ~* '(retail|store|shop|shopping|strip (mall|center)|restaurant)';
    UPDATE properties SET asset_type = 'hospitality'
     WHERE firm_id = f.id AND asset_type = 'commercial' AND use_type ~* '(hotel|motel|hospitality|\minn\M)';
    UPDATE properties SET asset_type = 'data_center'
     WHERE firm_id = f.id AND asset_type = 'industrial' AND use_type ~* 'data ?cent';
    UPDATE properties SET asset_type = 'flex'
     WHERE firm_id = f.id AND asset_type = 'industrial' AND use_type ~* '\mflex\M';
    -- Multi-family keeps the group it had: when its units say otherwise (or are unknown), that group becomes the override.
    UPDATE properties SET asset_type = 'multifamily',
           asset_group_override = CASE WHEN app_asset_group('multifamily', units, county_id, NULL) = asset_type THEN NULL ELSE asset_type END
     WHERE firm_id = f.id AND asset_type IN ('residential', 'commercial')
       AND use_type ~* '(apartment|multi-?family|multifamily|\d+-unit|(two|three|four|six)-flat|\mflats?\M)';
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;

-- ---------------------------------------------------------------- 4: calendar entries are activities
-- Meetings, calls and reminders made on the calendar, tagged to a client, property and appeal,
-- or left untagged as a firm entry (or a private one only its maker sees).
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities ADD CONSTRAINT activities_kind_check CHECK (kind IN ('note', 'call', 'email', 'task', 'meeting', 'reminder'));
ALTER TABLE activities ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_location_check;
ALTER TABLE activities ADD CONSTRAINT activities_location_check CHECK (location IS NULL OR length(location) <= 200);
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_times_check;
ALTER TABLE activities ADD CONSTRAINT activities_times_check CHECK (end_time IS NULL OR (start_time IS NOT NULL AND end_time >= start_time));
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_private_check;
ALTER TABLE activities ADD CONSTRAINT activities_private_check
  CHECK (NOT is_private OR (account_id IS NULL AND property_id IS NULL AND appeal_id IS NULL));
CREATE INDEX IF NOT EXISTS idx_activities_calendar ON activities (firm_id, due_on) WHERE due_on IS NOT NULL;

-- ---------------------------------------------------------------- 5: invoice design
ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS accent_color TEXT;
ALTER TABLE billing_settings DROP CONSTRAINT IF EXISTS billing_settings_accent_color_check;
ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_accent_color_check CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-F]{6}$');
ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS remit_to TEXT;
ALTER TABLE billing_settings DROP CONSTRAINT IF EXISTS billing_settings_remit_to_check;
ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_remit_to_check CHECK (remit_to IS NULL OR length(remit_to) <= 300);

-- The letterhead logo. Kept out of the row-by-row audit (it's an image); changes are logged by the app.
CREATE TABLE IF NOT EXISTS firm_logos (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL UNIQUE REFERENCES firms(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, updated_by) REFERENCES users (firm_id, id)
);
SELECT app_enable_firm_rls('firm_logos'::regclass);

-- PDFs attached to one invoice: a copy taken when attached, so the client gets exactly what was
-- attached even if the file later changes in Dropbox. Not row-audited (file content); logged by the app.
CREATE TABLE IF NOT EXISTS invoice_attachments (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  invoice_id INTEGER NOT NULL,
  document_id INTEGER,                  -- the Files tab record it came from, when it came from one
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  content BYTEA NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_attachments_firm ON invoice_attachments (firm_id);
CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice ON invoice_attachments (firm_id, invoice_id);
SELECT app_enable_firm_rls('invoice_attachments'::regclass);
