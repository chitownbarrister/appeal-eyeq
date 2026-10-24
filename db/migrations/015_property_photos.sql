-- Delivery 10f: a photo for each property, shown as its avatar across the app and as a banner on
-- the property page. Two sizes are kept (large up to 1600 px wide, a 320 px square thumbnail);
-- the original upload isn't. Firm-scoped with forced row-level security. Not row-audited, because
-- it holds image bytes: the app writes a small audit row for each change instead. Safe to run twice.

CREATE TABLE IF NOT EXISTS property_photos (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  property_id INTEGER NOT NULL,
  large BYTEA NOT NULL,
  thumb BYTEA NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  source TEXT NOT NULL CHECK (source IN ('upload', 'dropbox', 'sample')),
  source_name TEXT CHECK (source_name IS NULL OR length(source_name) <= 255),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, property_id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, updated_by) REFERENCES users (firm_id, id)
);
SELECT app_enable_firm_rls('property_photos'::regclass);
