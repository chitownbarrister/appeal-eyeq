-- ============================================================
-- 007 Documents: Appeal EyeQ as the document system, Dropbox as storage.
--
-- 1. folder_template: each firm's property folder layout. Top folders
--    (Engagement Agreements, Property Documents, ... and the one Appeals
--    folder, which holds a folder per year with a folder per level), and
--    the names of the four level folders. Firm admins edit it.
-- 2. document_types: the labels that tell staff what is saved where
--    (Appraisal, CCAO Brief, Invoice, ...). Each points at the template
--    folder it belongs in, or at every level folder. A protected type can
--    only be deleted by roles allowed to delete protected files.
-- 3. documents: one row per file Appeal EyeQ has seen, keyed by Dropbox's
--    permanent file id (it survives renames and moves), holding the
--    document's profile: type, status, dates, author, tags, notes, year
--    and level, and who uploaded it.
-- 4. file_deletions: what was deleted (in the app, or noticed as deleted
--    outside it), with the Dropbox revisions needed to restore it.
-- 5. property_folders gains in_deadzone (closed matters moved aside) and
--    indexed_at (when the folder was last read in full).
-- 6. Two permissions: files.delete (every role) and files.delete_protected
--    (Attorney only to start). Firm admins can always delete protected files.
--
-- The default template and document types are written by the app (one
-- list in shared/documents.ts) for every firm whose document_defaults_at
-- is empty, right after migrations run, and for each new firm.
-- Firm tables carry firm_id, forced row-level security, audit and
-- composite foreign keys. Safe to run twice.
-- ============================================================

ALTER TABLE firms ADD COLUMN IF NOT EXISTS document_defaults_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- 1: folder template
CREATE TABLE IF NOT EXISTS folder_template (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'appeals', 'level')),
  level TEXT CHECK (level IN ('assessor', 'bor', 'ptab', 'circuit')),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  CHECK ((kind = 'level') = (level IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_folder_template_firm ON folder_template (firm_id);
CREATE UNIQUE INDEX IF NOT EXISTS folder_template_one_appeals ON folder_template (firm_id) WHERE kind = 'appeals';
CREATE UNIQUE INDEX IF NOT EXISTS folder_template_one_per_level ON folder_template (firm_id, level) WHERE kind = 'level';
CREATE UNIQUE INDEX IF NOT EXISTS folder_template_top_names ON folder_template (firm_id, lower(name)) WHERE kind <> 'level';
SELECT app_enable_firm_rls('folder_template'::regclass);
SELECT app_attach_audit('folder_template'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON folder_template;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON folder_template FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 2: document types
CREATE TABLE IF NOT EXISTS document_types (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  template_id INTEGER,                         -- the folder it's saved in (a top folder or one level)
  any_level BOOLEAN NOT NULL DEFAULT false,    -- or: belongs in every level folder
  protected BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, template_id) REFERENCES folder_template (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_document_types_firm ON document_types (firm_id);
CREATE UNIQUE INDEX IF NOT EXISTS document_types_names ON document_types (firm_id, lower(name));
SELECT app_enable_firm_rls('document_types'::regclass);
SELECT app_attach_audit('document_types'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON document_types;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON document_types FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 3: documents (profiles)
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'dropbox' CHECK (provider IN ('dropbox')),
  file_id TEXT NOT NULL,                      -- Dropbox's id for the file
  rev TEXT,
  path_display TEXT NOT NULL,                 -- where it was last seen
  name TEXT NOT NULL,
  size BIGINT,
  server_modified TIMESTAMPTZ,
  doc_type_id INTEGER,
  status TEXT CHECK (status IN ('draft', 'final', 'filed', 'superseded')),
  doc_date DATE,
  received_on DATE,
  filed_on DATE,
  author TEXT CHECK (author IS NULL OR length(author) <= 120),
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  assessment_year INTEGER CHECK (assessment_year IS NULL OR assessment_year BETWEEN 1990 AND 2100),
  level TEXT CHECK (level IN ('assessor', 'bor', 'ptab', 'circuit')),
  uploaded_by INTEGER,
  uploaded_at TIMESTAMPTZ,
  profiled_by INTEGER,
  profiled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, provider, file_id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, doc_type_id) REFERENCES document_types (firm_id, id),
  FOREIGN KEY (firm_id, uploaded_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, profiled_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_documents_firm ON documents (firm_id);
CREATE INDEX IF NOT EXISTS idx_documents_property ON documents (firm_id, property_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (firm_id, doc_type_id);
SELECT app_enable_firm_rls('documents'::regclass);
SELECT app_attach_audit('documents'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON documents;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 4: deletions, for Recently deleted and restore
CREATE TABLE IF NOT EXISTS file_deletions (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  path_display TEXT NOT NULL,
  name TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',          -- [{path, rev, fileId}] for every file removed
  was_protected BOOLEAN NOT NULL DEFAULT false,
  outside BOOLEAN NOT NULL DEFAULT false,     -- noticed missing, not deleted through Appeal EyeQ
  deleted_by INTEGER,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_by INTEGER,
  restored_at TIMESTAMPTZ,
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, deleted_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, restored_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_file_deletions_property ON file_deletions (firm_id, property_id, deleted_at DESC);
SELECT app_enable_firm_rls('file_deletions'::regclass);
SELECT app_attach_audit('file_deletions'::regclass);

-- ---------------------------------------------------------------- 5: property folders
ALTER TABLE property_folders ADD COLUMN IF NOT EXISTS in_deadzone BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property_folders ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- 6: permissions
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    INSERT INTO role_permissions (firm_id, role, permission, allowed)
    SELECT f.id, r, 'files.delete', true FROM unnest(ARRAY['attorney', 'analyst', 'operations']) AS r
    ON CONFLICT (firm_id, role, permission) DO NOTHING;
    INSERT INTO role_permissions (firm_id, role, permission, allowed)
    SELECT f.id, r, 'files.delete_protected', r = 'attorney' FROM unnest(ARRAY['attorney', 'analyst', 'operations']) AS r
    ON CONFLICT (firm_id, role, permission) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
