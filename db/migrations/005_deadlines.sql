-- ============================================================
-- 005 Deadlines: hearings, evidence due dates, filing deadlines and
-- other dated obligations on a property, shown in the property's summary
-- card and on the firm calendar.
--
-- Township filing windows are NOT copied in here. They stay in the global
-- filing_windows table and are matched to each property when read, so a
-- window the super admin corrects updates every firm at once.
--
-- Firm data: firm_id on every row, forced row-level security, composite
-- foreign keys to the firm's own properties/appeals/users, audit trigger.
-- Safe to run twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS deadlines (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  appeal_id INTEGER, -- the level this deadline belongs to, when known
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('hearing', 'evidence', 'filing', 'other')),
  title TEXT NOT NULL,
  due_on DATE NOT NULL,
  due_time TIME,     -- local Chicago time, for hearings
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at TIMESTAMPTZ,
  -- manual: typed in. notice: taken from a hearing or decision notice.
  -- computed: worked out by a deadline rule (rules arrive in a later step).
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'notice', 'computed')),
  computed_on DATE,        -- what the rule produced, kept when someone overrides the date
  override_reason TEXT,    -- required when a computed date is changed by hand
  created_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, created_by_user_id) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_deadlines_firm ON deadlines (firm_id);
CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines (firm_id, status, due_on);
CREATE INDEX IF NOT EXISTS idx_deadlines_property ON deadlines (firm_id, property_id);

-- app_enable_firm_rls and app_attach_audit drop and recreate their own
-- policies and trigger, so running this twice is harmless.
SELECT app_enable_firm_rls('deadlines'::regclass);
SELECT app_attach_audit('deadlines'::regclass);

DROP TRIGGER IF EXISTS touch_updated_at_trg ON deadlines;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON deadlines FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Hearings now live in deadlines. Carry over any hearing already typed on
-- an appeal (one row per appeal, skipped if it was carried over before).
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    INSERT INTO deadlines (firm_id, property_id, appeal_id, kind, title, due_on, due_time, source, status)
    SELECT a.firm_id, a.property_id, a.id, 'hearing',
           CASE a.level WHEN 'assessor' THEN 'Assessor hearing' WHEN 'bor' THEN 'BOR hearing'
                        WHEN 'ptab' THEN 'PTAB hearing' ELSE 'Circuit Court hearing' END,
           (a.hearing_at AT TIME ZONE 'America/Chicago')::date,
           (a.hearing_at AT TIME ZONE 'America/Chicago')::time,
           'manual',
           CASE WHEN a.hearing_at < now() THEN 'done' ELSE 'open' END
      FROM appeals a
     WHERE a.firm_id = f.id AND a.hearing_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM deadlines d WHERE d.firm_id = a.firm_id AND d.appeal_id = a.id AND d.kind = 'hearing');
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
