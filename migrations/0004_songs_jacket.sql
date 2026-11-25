-- Jacket availability flag: 1 when the song's jacket image is in Workers KV
-- (synced from the master delivery's "jacket" boolean by the daily sync).
ALTER TABLE songs ADD COLUMN has_jacket INTEGER NOT NULL DEFAULT 0;
