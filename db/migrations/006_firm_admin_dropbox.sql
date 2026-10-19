-- ============================================================
-- 006 Firm admins, the Operations role, one matter per PIN, and Dropbox.
--
-- 1. Firm admin: a switch on each user, separate from the role. Firm
--    admins manage users, roles and permissions, support access and
--    integrations (Dropbox). Each firm's first active attorney starts as
--    its firm admin. The old per-role permissions for those duties
--    (users.manage, support.grant, settings.edit) are retired.
-- 2. A third role, Operations, for non-attorney staff and outside
--    consultants. It starts with the same permissions as Analyst.
-- 3. PIN as the matter key: parcels get pin_key, the PIN reduced to its
--    digits (a Cook PIN's trailing -0000 dropped), unique within a firm,
--    so "05-17-302-010" and "05-17-302-010-0000" can't become two matters.
-- 4. Dropbox: the firm's connection (tokens encrypted by the app before
--    they're stored) and the Dropbox folder linked to each property.
--
-- Firm tables carry firm_id, forced row-level security and composite
-- foreign keys. Firm-scoped rows are written per firm under a 'system'
-- context. Safe to run twice.
-- ============================================================

-- ---------------------------------------------------------------- 1, 2: roles and firm admins
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('attorney', 'analyst', 'operations'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_firm_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('attorney', 'analyst', 'operations'));

-- Every firm gets one firm admin if it has none: its earliest active attorney (else earliest active user).
UPDATE users u SET is_firm_admin = true
  FROM (
    SELECT DISTINCT ON (firm_id) id FROM users
     WHERE firm_id IS NOT NULL AND active AND NOT is_super_admin
     ORDER BY firm_id, (role = 'attorney') DESC, id
  ) first_user
 WHERE u.id = first_user.id
   AND NOT EXISTS (SELECT 1 FROM users x WHERE x.firm_id = u.firm_id AND x.is_firm_admin);

DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    -- Operations starts with whatever Analyst has.
    INSERT INTO role_permissions (firm_id, role, permission, allowed)
    SELECT firm_id, 'operations', permission, allowed FROM role_permissions
     WHERE firm_id = f.id AND role = 'analyst'
    ON CONFLICT (firm_id, role, permission) DO NOTHING;
    -- These duties now belong to firm admins.
    DELETE FROM role_permissions WHERE firm_id = f.id AND permission IN ('users.manage', 'support.grant', 'settings.edit');
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;

-- ---------------------------------------------------------------- 3: one matter per PIN
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS pin_key TEXT GENERATED ALWAYS AS (
  CASE
    WHEN length(regexp_replace(pin, '\D', '', 'g')) = 14 AND right(regexp_replace(pin, '\D', '', 'g'), 4) = '0000'
      THEN left(regexp_replace(pin, '\D', '', 'g'), 10)
    ELSE regexp_replace(pin, '\D', '', 'g')
  END
) STORED;

-- The unique rule is added only if no firm already holds two parcels with the same PIN, so the
-- deploy never fails on existing data; the app refuses duplicates either way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'parcels_firm_pin_key') THEN
    IF NOT EXISTS (SELECT 1 FROM parcels WHERE pin_key <> '' GROUP BY firm_id, pin_key HAVING count(*) > 1) THEN
      CREATE UNIQUE INDEX parcels_firm_pin_key ON parcels (firm_id, pin_key) WHERE pin_key <> '';
    ELSE
      RAISE NOTICE 'parcels_firm_pin_key not created: duplicate PINs exist; the app still refuses new duplicates';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------- 4: Dropbox
CREATE TABLE IF NOT EXISTS firm_integrations (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  provider TEXT NOT NULL CHECK (provider IN ('dropbox')),
  account_id TEXT NOT NULL,
  account_email TEXT,
  account_name TEXT,
  account_type TEXT NOT NULL,          -- basic | pro | business, as Dropbox reports it
  team_name TEXT,
  root_namespace_id TEXT,              -- the team space root, when the account has one
  uses_team_space BOOLEAN NOT NULL DEFAULT false,
  root_folder TEXT NOT NULL DEFAULT '/Appeal EyeQ',
  refresh_token_enc TEXT NOT NULL,     -- AES-256-GCM, key held only in the app's environment
  access_token_enc TEXT,
  access_expires_at TIMESTAMPTZ,
  connected_by_user_id INTEGER,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, provider),
  FOREIGN KEY (firm_id, connected_by_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_firm_integrations_firm ON firm_integrations (firm_id);
SELECT app_enable_firm_rls('firm_integrations'::regclass);
-- No row audit trigger here: it would copy the (encrypted) tokens into the audit log.
-- Connect and disconnect are written to the audit log by the app instead.
DROP TRIGGER IF EXISTS touch_updated_at_trg ON firm_integrations;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON firm_integrations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS property_folders (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'dropbox' CHECK (provider IN ('dropbox')),
  folder_id TEXT NOT NULL,             -- Dropbox's id for the folder; it survives renames and moves
  path_display TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, property_id, provider),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_property_folders_firm ON property_folders (firm_id);
SELECT app_enable_firm_rls('property_folders'::regclass);
SELECT app_attach_audit('property_folders'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON property_folders;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON property_folders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
