-- Delivery 10d: bulk import. One importer for whole-firm migrations, new clients and matters in
-- bulk, and bulk updates (appeal values and results, property details). An import is a batch:
-- its files (parsed into rows), how their columns map to fields, a preview of every row, and once
-- committed, a record of every row it created or changed, so the whole import can be undone.
-- A large commit or undo runs in the background (status committing / undoing) in one transaction.
-- Firm-scoped with forced row-level security. Safe to run twice.

CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('migration', 'new', 'update')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'previewed', 'committing', 'committed', 'undoing', 'undone')),
  error TEXT CHECK (error IS NULL OR length(error) <= 1000),
  options JSONB NOT NULL DEFAULT '{}',
  mapping JSONB NOT NULL DEFAULT '{}',
  summary JSONB,
  mapping_name TEXT CHECK (mapping_name IS NULL OR length(mapping_name) <= 120),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previewed_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  committed_by INTEGER,
  undone_at TIMESTAMPTZ,
  undone_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, committed_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, undone_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_import_batches_firm ON import_batches (firm_id, created_at DESC);
SELECT app_enable_firm_rls('import_batches'::regclass);
SELECT app_attach_audit('import_batches'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON import_batches;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Each uploaded file, already read into sheets of rows (strings). Kept out of the row audit (it's the client data itself).
CREATE TABLE IF NOT EXISTS import_files (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  batch_id INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  size INTEGER NOT NULL CHECK (size > 0),
  sheets JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, batch_id) REFERENCES import_batches (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_files_batch ON import_files (firm_id, batch_id);
SELECT app_enable_firm_rls('import_files'::regclass);

-- The preview: one line per record the import would create, change, leave alone, or can't take.
CREATE TABLE IF NOT EXISTS import_rows (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  batch_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  file_name TEXT,
  sheet TEXT,
  row_no INTEGER,
  entity TEXT NOT NULL CHECK (entity IN ('client', 'property', 'parcel', 'appeal', 'contact', 'activity')),
  action TEXT NOT NULL CHECK (action IN ('new', 'update', 'unchanged', 'problem')),
  label TEXT NOT NULL,
  message TEXT,
  changes JSONB,
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, batch_id) REFERENCES import_batches (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows (firm_id, batch_id, position);
SELECT app_enable_firm_rls('import_rows'::regclass);

-- What a committed import did, in order, so Undo can reverse it: rows it created (deleted on undo)
-- and rows it changed (put back, if nobody has changed them since).
CREATE TABLE IF NOT EXISTS import_effects (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  batch_id INTEGER NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('accounts', 'properties', 'parcels', 'appeals', 'appeal_pins', 'contacts', 'activities', 'invoices')),
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update')),
  before JSONB,
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, batch_id) REFERENCES import_batches (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_effects_batch ON import_effects (firm_id, batch_id, id);
SELECT app_enable_firm_rls('import_effects'::regclass);

-- Column mappings saved by name ("Prior software export") to reuse on the next import.
CREATE TABLE IF NOT EXISTS import_mappings (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  mapping JSONB NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS import_mappings_name ON import_mappings (firm_id, lower(name));
SELECT app_enable_firm_rls('import_mappings'::regclass);
SELECT app_attach_audit('import_mappings'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON import_mappings;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON import_mappings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Appeals brought in from earlier software can be marked as such (data_source already allows 'import').
