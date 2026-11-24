-- Phase 1.1: image hash for duplicate detection.
-- Apply BEFORE deploying the Phase 1.1 worker (its INSERT writes image_hash).
-- Existing rows keep NULL and simply never match a duplicate check.
ALTER TABLE scores ADD COLUMN image_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_scores_image_hash ON scores(image_hash);
