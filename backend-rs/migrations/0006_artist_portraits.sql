-- Cached preview bytes are independent of music tags. A sync token records the
-- exact source and target the user reviewed; only one upload may claim it.
CREATE TABLE IF NOT EXISTS artist_portraits (
    id UUID PRIMARY KEY,
    artist TEXT NOT NULL,
    source_page TEXT NOT NULL,
    source_image TEXT NOT NULL,
    jpeg_digest TEXT NOT NULL,
    preview_digest TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artist_portrait_fetches (
    cache_key TEXT PRIMARY KEY,
    portrait_id UUID REFERENCES artist_portraits(id),
    failure JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK ((portrait_id IS NOT NULL) <> (failure IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS artist_portrait_syncs (
    token UUID PRIMARY KEY,
    portrait_id UUID NOT NULL REFERENCES artist_portraits(id),
    target JSONB NOT NULL,
    destination TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','uploading','uploaded','uncertain','failed')),
    message TEXT NOT NULL DEFAULT '',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
