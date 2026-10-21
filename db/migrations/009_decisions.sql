-- ============================================================
-- 009 Decisions: decision letters read from scans, the review queue,
--     refunds awaited at PTAB and Circuit Court, and a per-user choice
--     to show cents on assessed and market values.
--
-- 1. decision_uploads: one row per file uploaded (a PDF that may hold a
--    stack of letters, or one photo or scan). decision_upload_files holds
--    the file itself until every letter in it is applied and filed in
--    Dropbox (or dismissed), so listing uploads never loads the bytes.
-- 2. decision_letters: one row per letter found in an upload (its pages),
--    with the text read from it, the fields the parser found (which a
--    reviewer can correct), the property and appeal it matched, the
--    cross-checks, and what applying it changed (so it can be undone).
-- 3. appeals gains refund_status ('awaiting' | 'received'), the refund
--    expected and the refund received, for PTAB and Circuit Court results
--    (Delivery 9 turns a received refund into a trust deposit).
-- 4. users gains show_value_cents.
--
-- Firm tables carry firm_id, forced row-level security, audit and
-- composite foreign keys. The file table has no audit trigger, so file
-- bytes never reach the audit log. Safe to run twice.
-- ============================================================

-- ---------------------------------------------------------------- 1: uploads
CREATE TABLE IF NOT EXISTS decision_uploads (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER,                          -- set when uploaded from a property page
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'reading', 'done', 'failed')),
  page_count INTEGER,
  pages_read INTEGER NOT NULL DEFAULT 0,
  error TEXT CHECK (error IS NULL OR length(error) <= 500),
  uploaded_by INTEGER,
  finished_at TIMESTAMPTZ,
  file_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, uploaded_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_decision_uploads_firm ON decision_uploads (firm_id);
CREATE INDEX IF NOT EXISTS idx_decision_uploads_status ON decision_uploads (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_decision_uploads_sha ON decision_uploads (firm_id, sha256);
SELECT app_enable_firm_rls('decision_uploads'::regclass);
SELECT app_attach_audit('decision_uploads'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON decision_uploads;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON decision_uploads FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS decision_upload_files (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  upload_id INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, upload_id),
  FOREIGN KEY (firm_id, upload_id) REFERENCES decision_uploads (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_decision_upload_files_firm ON decision_upload_files (firm_id);
SELECT app_enable_firm_rls('decision_upload_files'::regclass);
-- deliberately no audit trigger: the audit log never holds file bytes

-- ---------------------------------------------------------------- 2: letters
CREATE TABLE IF NOT EXISTS decision_letters (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  upload_id INTEGER NOT NULL,
  page_from INTEGER NOT NULL CHECK (page_from >= 1),
  page_to INTEGER NOT NULL CHECK (page_to >= page_from),
  kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('assessor', 'bor', 'ptab', 'circuit', 'unknown')),
  text_source TEXT NOT NULL CHECK (text_source IN ('text', 'ocr')),
  confidence NUMERIC(5, 2),                     -- OCR's own confidence, 0 to 100 (NULL for a text layer)
  raw_text TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '{}',           -- what the parser found, as corrected by a reviewer
  parsed_fields JSONB NOT NULL DEFAULT '{}',    -- what the parser found, untouched
  corrected_by INTEGER,
  corrected_at TIMESTAMPTZ,
  property_id INTEGER,                          -- the match (the app clears these before an appeal or property is deleted)
  appeal_id INTEGER,
  appeal_chosen BOOLEAN NOT NULL DEFAULT false, -- a reviewer picked the appeal by hand
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'clean', 'applied', 'dismissed')),
  checks JSONB NOT NULL DEFAULT '[]',           -- [{key, level: ok|note|review|block, text}]
  applied_by INTEGER,
  applied_at TIMESTAMPTZ,
  before_apply JSONB,                           -- the appeal and PIN values applying replaced, for Undo
  document_id INTEGER,                          -- the Decision Letter document once filed in Dropbox
  filed_path TEXT,
  file_error TEXT CHECK (file_error IS NULL OR length(file_error) <= 500),
  dismissed_by INTEGER,
  dismissed_at TIMESTAMPTZ,
  dismissed_reason TEXT CHECK (dismissed_reason IS NULL OR length(dismissed_reason) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, upload_id) REFERENCES decision_uploads (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id),
  FOREIGN KEY (firm_id, document_id) REFERENCES documents (firm_id, id),
  FOREIGN KEY (firm_id, corrected_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, applied_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, dismissed_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_decision_letters_firm ON decision_letters (firm_id);
CREATE INDEX IF NOT EXISTS idx_decision_letters_status ON decision_letters (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_decision_letters_upload ON decision_letters (firm_id, upload_id);
CREATE INDEX IF NOT EXISTS idx_decision_letters_appeal ON decision_letters (firm_id, appeal_id);
SELECT app_enable_firm_rls('decision_letters'::regclass);
SELECT app_attach_audit('decision_letters'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON decision_letters;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON decision_letters FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 3: refunds
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS refund_status TEXT;
ALTER TABLE appeals DROP CONSTRAINT IF EXISTS appeals_refund_status_check;
ALTER TABLE appeals ADD CONSTRAINT appeals_refund_status_check CHECK (refund_status IS NULL OR refund_status IN ('awaiting', 'received'));
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS refund_expected NUMERIC(14, 2);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS refund_received NUMERIC(14, 2);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS refund_received_on DATE;
CREATE INDEX IF NOT EXISTS idx_appeals_refund ON appeals (firm_id, refund_status) WHERE refund_status IS NOT NULL;

-- ---------------------------------------------------------------- 4: display preference
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_value_cents BOOLEAN NOT NULL DEFAULT false;
