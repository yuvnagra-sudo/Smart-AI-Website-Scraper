-- Add `extractedData` JSON column to `enrichedFirms` so the generic agent pipeline
-- can store its full per-template field map (industry, business_model, etc.) without
-- losing data to the legacy VC-shaped columns.
ALTER TABLE `enrichedFirms` ADD COLUMN `extractedData` JSON NULL;
