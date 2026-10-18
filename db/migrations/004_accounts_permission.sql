-- ============================================================
-- 004 New permission: accounts.edit (clients and their contacts).
--
-- Every existing firm gets it for both roles, allowed, matching the
-- "same rights for Attorney and Analyst" default. New firms get it from
-- the permission list in shared/domain.ts.
--
-- role_permissions is behind the tenant lock, so each firm's rows are
-- written under a 'system' context for that firm, then the context is
-- cleared. Safe to run twice (ON CONFLICT DO NOTHING).
-- ============================================================

DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    INSERT INTO role_permissions (firm_id, role, permission, allowed)
    SELECT f.id, r, 'accounts.edit', true
      FROM unnest(ARRAY['attorney', 'analyst']) AS r
    ON CONFLICT (firm_id, role, permission) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
