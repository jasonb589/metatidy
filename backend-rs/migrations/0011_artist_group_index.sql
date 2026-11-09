-- Keep long Unicode tag names out of a B-tree key. Equality also checks the
-- original normalized text, so hash collisions never merge artist identities.
CREATE INDEX IF NOT EXISTS idx_tracks_artist_group
    ON tracks (md5(BTRIM(artist))) WHERE BTRIM(artist) <> '';
