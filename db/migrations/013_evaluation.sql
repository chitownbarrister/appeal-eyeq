-- Delivery 10b: what the property's Evaluation tab needs that wasn't stored yet. Land and
-- rentable square feet, and co-counsel on the property (Dillon, Oct 22: co-counsel is by
-- property, not by client). Co-counsel here is the firm's own note of the arrangement; the
-- shared arrangement between two firms on Appeal EyeQ comes in Delivery 15b. Safe to run twice.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS land_sqft INTEGER;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rentable_sqft INTEGER;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_land_sqft_check;
ALTER TABLE properties ADD CONSTRAINT properties_land_sqft_check CHECK (land_sqft IS NULL OR land_sqft >= 0);
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_rentable_sqft_check;
ALTER TABLE properties ADD CONSTRAINT properties_rentable_sqft_check CHECK (rentable_sqft IS NULL OR rentable_sqft >= 0);

-- The other firm, which side we're on, the other firm's share of the fee, and who bills the client.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS co_counsel_firm TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS co_counsel_role TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS co_counsel_percent NUMERIC(5, 2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS co_counsel_bills TEXT;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_co_counsel_check;
ALTER TABLE properties ADD CONSTRAINT properties_co_counsel_check CHECK (
  (co_counsel_firm IS NULL AND co_counsel_role IS NULL AND co_counsel_percent IS NULL AND co_counsel_bills IS NULL)
  OR (length(btrim(co_counsel_firm)) BETWEEN 1 AND 200
      AND co_counsel_role IN ('relationship', 'handling')
      AND (co_counsel_percent IS NULL OR (co_counsel_percent >= 0 AND co_counsel_percent <= 100))
      AND (co_counsel_bills IS NULL OR co_counsel_bills IN ('us', 'co_counsel')))
);
