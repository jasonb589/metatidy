-- Persistent, ordered work sets. A deleted track leaves its saved snapshot in
-- the collection; only deleting the collection itself cascades to its members.
CREATE TABLE IF NOT EXISTS track_collections (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    revision UUID NOT NULL,
    create_fingerprint TEXT NOT NULL CHECK (char_length(create_fingerprint) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_track_collections_updated
    ON track_collections (updated_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS track_collection_members (
    collection_id UUID NOT NULL REFERENCES track_collections(id) ON DELETE CASCADE,
    track_id BIGINT NOT NULL CHECK (track_id BETWEEN 1 AND 9007199254740991),
    position BIGINT NOT NULL CHECK (position > 0),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (collection_id, track_id),
    -- Removing members compacts positions in one UPDATE. Delay uniqueness until
    -- commit so that its row visitation order cannot cause a false conflict.
    CONSTRAINT track_collection_members_position_key
        UNIQUE (collection_id, position) DEFERRABLE INITIALLY DEFERRED
);
