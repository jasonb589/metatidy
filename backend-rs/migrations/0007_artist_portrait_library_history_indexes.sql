-- Keep submitted syncs separate from previews invalidated by another claim.
-- Legacy creation time is only an approximation; the API retains the original
-- created_at/updated_at fields and does not present it as an exact submit time.
ALTER TABLE artist_portrait_syncs
    ADD COLUMN submitted_at TIMESTAMPTZ;

UPDATE artist_portrait_syncs
SET submitted_at = created_at
WHERE state IN ('uploading', 'uploaded', 'uncertain') OR result IS NOT NULL;

-- Deterministic newest-first portrait browsing, independent of source-cache TTL.
CREATE INDEX IF NOT EXISTS idx_artist_portraits_created
    ON artist_portraits (created_at DESC, id DESC);

-- The current destination's submitted history; unsubmitted previews are omitted.
CREATE INDEX IF NOT EXISTS idx_artist_portrait_syncs_history
    ON artist_portrait_syncs (destination, updated_at DESC, token DESC)
    WHERE submitted_at IS NOT NULL;

-- PostgreSQL does not automatically index the referencing side of a foreign key.
CREATE INDEX IF NOT EXISTS idx_artist_portrait_syncs_portrait
    ON artist_portrait_syncs (portrait_id);
