-- ============================================================
-- 001 Foundation: firms, users, sessions, support grants,
-- the tenant lock (row-level security), and the audit log.
--
-- How the tenant lock works:
-- Every request runs inside a transaction that sets three values:
--   app.actor_kind  'firm_user' | 'super_admin' | 'system'
--   app.user_id     the signed-in user
--   app.firm_id     the firm the request is acting for
-- app_current_firm() turns those into the one firm this transaction
-- may touch, and every firm-data table has policies that only allow
-- rows with that firm_id. The function re-checks the facts itself:
--   * a firm user only gets their own firm, so a server bug that sets
--     the wrong firm_id returns nothing;
--   * the super admin only gets a firm while that firm has an active,
--     unrevoked support grant;
--   * 'system' is used only by server-side jobs (sample seed, later
--     webhooks) and never by a user request.
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table owner
-- too, which is the role the app connects as.
-- ============================================================

CREATE TABLE IF NOT EXISTS firms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_sample BOOLEAN NOT NULL DEFAULT false,
  letterhead_name TEXT,
  letterhead_address TEXT,
  letterhead_phone TEXT,
  letterhead_website TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IN ('attorney', 'analyst')),
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_kind CHECK (
    (is_super_admin AND firm_id IS NULL AND role IS NULL)
    OR (NOT is_super_admin AND firm_id IS NOT NULL AND role IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_firm ON users (firm_id);
-- Lets other tables require "a user of the same firm" with a composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS users_firm_id_id ON users (firm_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  -- super admin only: the firm being viewed under a support grant
  acting_firm_id INTEGER REFERENCES firms(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- A firm lets the super admin in, for a limited time, and can revoke it.
CREATE TABLE IF NOT EXISTS support_grants (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  granted_by_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_grants_firm ON support_grants (firm_id);

-- ---------------------------------------------------------------- tenant lock
CREATE OR REPLACE FUNCTION app_current_firm() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE current_setting('app.actor_kind', true)
    WHEN 'firm_user' THEN (
      SELECT u.firm_id FROM users u
      WHERE u.id = NULLIF(current_setting('app.user_id', true), '')::int
        AND u.active
        AND NOT u.is_super_admin
        AND u.firm_id = NULLIF(current_setting('app.firm_id', true), '')::int
    )
    WHEN 'super_admin' THEN (
      SELECT g.firm_id FROM support_grants g
      JOIN users u ON u.id = NULLIF(current_setting('app.user_id', true), '')::int
                  AND u.is_super_admin AND u.active
      WHERE g.firm_id = NULLIF(current_setting('app.firm_id', true), '')::int
        AND g.revoked_at IS NULL
        AND g.expires_at > now()
      LIMIT 1
    )
    WHEN 'system' THEN NULLIF(current_setting('app.firm_id', true), '')::int
    ELSE NULL
  END
$$;

-- Turns the lock on for one firm-data table. append_only tables (logs)
-- get read and insert policies only, so rows can never be changed or
-- deleted through the app's connection.
CREATE OR REPLACE FUNCTION app_enable_firm_rls(t regclass, append_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS firm_select ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS firm_insert ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS firm_update ON %s', t);
  EXECUTE format('DROP POLICY IF EXISTS firm_delete ON %s', t);
  EXECUTE format('CREATE POLICY firm_select ON %s FOR SELECT USING (firm_id = (SELECT app_current_firm()))', t);
  EXECUTE format('CREATE POLICY firm_insert ON %s FOR INSERT WITH CHECK (firm_id = (SELECT app_current_firm()))', t);
  IF NOT append_only THEN
    EXECUTE format('CREATE POLICY firm_update ON %s FOR UPDATE USING (firm_id = (SELECT app_current_firm())) WITH CHECK (firm_id = (SELECT app_current_firm()))', t);
    EXECUTE format('CREATE POLICY firm_delete ON %s FOR DELETE USING (firm_id = (SELECT app_current_firm()))', t);
  END IF;
END $$;

-- ---------------------------------------------------------------- audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  actor_user_id INTEGER,
  actor_kind TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_firm_at ON audit_log (firm_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_row ON audit_log (firm_id, table_name, row_id);
SELECT app_enable_firm_rls('audit_log', true);

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r_firm INTEGER;
  r_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    r_firm := OLD.firm_id; r_id := OLD.id::text;
  ELSE
    r_firm := NEW.firm_id; r_id := NEW.id::text;
  END IF;
  INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after)
  VALUES (
    r_firm,
    NULLIF(current_setting('app.user_id', true), '')::int,
    COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'unknown'),
    TG_TABLE_NAME,
    r_id,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_attach_audit(t regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS audit_row_trg ON %s', t);
  EXECUTE format('CREATE TRIGGER audit_row_trg AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
END $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Every read the super admin makes inside a firm, visible to that firm.
CREATE TABLE IF NOT EXISTS support_access_log (
  id BIGSERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  grant_id INTEGER NOT NULL REFERENCES support_grants(id),
  super_admin_user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_access_log_firm_at ON support_access_log (firm_id, at DESC);
SELECT app_enable_firm_rls('support_access_log', true);

-- ---------------------------------------------------------------- permissions
-- Attorney and Analyst start with identical rights. Changing what a role
-- can do later is a data change here, not a code change.
CREATE TABLE IF NOT EXISTS role_permissions (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  role TEXT NOT NULL CHECK (role IN ('attorney', 'analyst')),
  permission TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (firm_id, role, permission)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_firm ON role_permissions (firm_id);
SELECT app_enable_firm_rls('role_permissions');
SELECT app_attach_audit('role_permissions');

SELECT app_attach_audit('support_grants');
