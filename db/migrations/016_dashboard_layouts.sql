-- Delivery 10e: the customizable Dashboard. Each person's layout (which modules, in what order,
-- how wide and tall, and each module's settings) is saved to their account; a firm admin can
-- save a firm default that people start from (a starting point only: anyone can change their
-- own). user_id NULL is the firm default. Firm-scoped with forced row-level security, audited.
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  user_id INTEGER,
  layout JSONB NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, user_id) REFERENCES users (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, updated_by) REFERENCES users (firm_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layouts_user ON dashboard_layouts (firm_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layouts_firm_default ON dashboard_layouts (firm_id) WHERE user_id IS NULL;
SELECT app_enable_firm_rls('dashboard_layouts'::regclass);
SELECT app_attach_audit('dashboard_layouts'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON dashboard_layouts;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON dashboard_layouts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
