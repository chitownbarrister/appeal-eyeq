-- ============================================================
-- 008 Several PINs per appeal, the offer trail, rollover targets and
--     locked stipulations.
--
-- 1. appeal_pins: one row per PIN (parcel) of the property on each appeal,
--    with land, building and AV for original, target and resolved, and
--    whether that PIN is on this appeal. A PIN not on the appeal keeps its
--    original value in the property total. The appeal's own columns keep
--    the property totals (sum of the PINs), so every existing total,
--    forecast and dashboard figure reads the same as before.
--    Existing appeals: every property in the data so far has one parcel per
--    appeal's values, so a one-parcel property's values are copied onto its
--    PIN. A property with several parcels gets empty PIN rows to fill in;
--    its appeal totals stay as they were until then.
-- 2. appeal_offers: every offer and counteroffer (firm, assessor, Board of
--    Review, State's Attorney, intervenor) and the agreed figure, each with
--    its total and the per-PIN split.
-- 3. appeals.target_source ('manual' | 'rollover') and the PTAB appeal a
--    rollover came from; appeals.stipulation_locked_at/by freeze the
--    resolved per-PIN figures once a stipulation is agreed.
--
-- Firm tables carry firm_id, forced row-level security, audit and composite
-- foreign keys. Firm data is written per firm under a 'system' context.
-- Safe to run twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS appeal_pins (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  appeal_id INTEGER NOT NULL,
  parcel_id INTEGER NOT NULL,
  on_appeal BOOLEAN NOT NULL DEFAULT true,
  orig_land_av NUMERIC(14, 2), orig_impr_av NUMERIC(14, 2), orig_av NUMERIC(14, 2),
  target_land_av NUMERIC(14, 2), target_impr_av NUMERIC(14, 2), target_av NUMERIC(14, 2),
  resolved_land_av NUMERIC(14, 2), resolved_impr_av NUMERIC(14, 2), resolved_av NUMERIC(14, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, appeal_id, parcel_id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, parcel_id) REFERENCES parcels (firm_id, id) ON DELETE CASCADE  -- the parcel route refuses a PIN that still has values
);
CREATE INDEX IF NOT EXISTS idx_appeal_pins_firm ON appeal_pins (firm_id);
CREATE INDEX IF NOT EXISTS idx_appeal_pins_appeal ON appeal_pins (firm_id, appeal_id);
SELECT app_enable_firm_rls('appeal_pins'::regclass);
SELECT app_attach_audit('appeal_pins'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON appeal_pins;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON appeal_pins FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS appeal_offers (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  appeal_id INTEGER NOT NULL,
  offered_on DATE NOT NULL,
  party TEXT NOT NULL CHECK (party IN ('firm', 'assessor', 'board_of_review', 'states_attorney', 'intervenor', 'agreed')),
  total_av NUMERIC(14, 2) NOT NULL,
  pins JSONB NOT NULL DEFAULT '[]',   -- [{parcelId, land, impr, av}] for the PINs on the appeal
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_appeal_offers_appeal ON appeal_offers (firm_id, appeal_id, offered_on);
SELECT app_enable_firm_rls('appeal_offers'::regclass);
SELECT app_attach_audit('appeal_offers'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON appeal_offers;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON appeal_offers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE appeals ADD COLUMN IF NOT EXISTS target_source TEXT;
ALTER TABLE appeals DROP CONSTRAINT IF EXISTS appeals_target_source_check;
ALTER TABLE appeals ADD CONSTRAINT appeals_target_source_check CHECK (target_source IS NULL OR target_source IN ('manual', 'rollover'));
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS target_source_appeal_id INTEGER;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS stipulation_locked_at TIMESTAMPTZ;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS stipulation_locked_by INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_target_source_appeal_fk') THEN
    ALTER TABLE appeals ADD CONSTRAINT appeals_target_source_appeal_fk
      FOREIGN KEY (firm_id, target_source_appeal_id) REFERENCES appeals (firm_id, id);  -- the app clears this before deleting the source appeal
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_stipulation_locked_by_fk') THEN
    ALTER TABLE appeals ADD CONSTRAINT appeals_stipulation_locked_by_fk FOREIGN KEY (firm_id, stipulation_locked_by) REFERENCES users (firm_id, id);
  END IF;
END $$;

-- Existing appeals get a PIN row for each of their property's parcels.
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    INSERT INTO appeal_pins (firm_id, appeal_id, parcel_id, on_appeal,
                             orig_land_av, orig_impr_av, orig_av, target_land_av, target_impr_av, target_av,
                             resolved_land_av, resolved_impr_av, resolved_av)
    SELECT a.firm_id, a.id, pc.id,
           (a.parcel_id IS NULL OR a.parcel_id = pc.id),
           CASE WHEN one.n = 1 THEN a.orig_land_av END, CASE WHEN one.n = 1 THEN a.orig_impr_av END, CASE WHEN one.n = 1 THEN a.orig_av END,
           CASE WHEN one.n = 1 THEN a.target_land_av END, CASE WHEN one.n = 1 THEN a.target_impr_av END, CASE WHEN one.n = 1 THEN a.target_av END,
           CASE WHEN one.n = 1 THEN a.resolved_land_av END, CASE WHEN one.n = 1 THEN a.resolved_impr_av END, CASE WHEN one.n = 1 THEN a.resolved_av END
      FROM appeals a
      JOIN parcels pc ON pc.firm_id = a.firm_id AND pc.property_id = a.property_id
      JOIN LATERAL (SELECT count(*) AS n FROM parcels x WHERE x.firm_id = a.firm_id AND x.property_id = a.property_id) one ON true
     WHERE a.firm_id = f.id
    ON CONFLICT (firm_id, appeal_id, parcel_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
