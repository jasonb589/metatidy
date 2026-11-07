-- Exact group lookups support arbitrarily long tag text without exceeding
-- PostgreSQL's B-tree tuple size. Every query also compares the original text,
-- so digest collisions can never merge different album groups.
CREATE INDEX IF NOT EXISTS idx_tracks_album_group_hash
    ON tracks (
        md5(BTRIM(album)),
        md5(COALESCE(NULLIF(BTRIM(albumartist), ''), BTRIM(artist))),
        id
    )
    WHERE BTRIM(album) <> '';
