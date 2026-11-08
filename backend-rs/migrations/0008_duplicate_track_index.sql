-- Bounded lookup keys support long text tags without exceeding a B-tree tuple.
-- The API always also compares the original normalized strings, so collisions
-- cannot merge groups. Only tracks with actual, non-path-derived tags qualify.
CREATE INDEX IF NOT EXISTS idx_tracks_duplicate_group_hash
    ON tracks (
        md5(lower(BTRIM(artist))),
        md5(lower(BTRIM(title))),
        id
    )
    WHERE tags_loaded AND NOT path_derived
      AND BTRIM(artist) <> '' AND BTRIM(title) <> '';
