-- metatidy（Rust 后端）初始 schema —— 面向 PostgreSQL
--
-- 设计说明：
-- - tracks 是唯一的热表：浏览/搜索/排序全部只查它，永不因为列表去读音频文件
-- - tags_loaded 区分「已读标签」与「只从路径建索引（快速扫描）」
-- - FTS 用 pg_trgm + GIN，中文子串匹配也能走索引
-- - jobs / move_plans 放 Postgres，实时进度另有一份在 Redis 里（避免高频写库）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS tracks (
    id                BIGSERIAL PRIMARY KEY,
    path              TEXT        NOT NULL UNIQUE,
    dir               TEXT        NOT NULL DEFAULT '',
    filename          TEXT        NOT NULL DEFAULT '',
    ext               TEXT        NOT NULL DEFAULT '',
    mtime             DOUBLE PRECISION NOT NULL DEFAULT 0,
    size              BIGINT      NOT NULL DEFAULT 0,

    title             TEXT        NOT NULL DEFAULT '',
    artist            TEXT        NOT NULL DEFAULT '',
    album             TEXT        NOT NULL DEFAULT '',
    albumartist       TEXT        NOT NULL DEFAULT '',
    genre             TEXT        NOT NULL DEFAULT '',
    year              TEXT        NOT NULL DEFAULT '',
    track             TEXT        NOT NULL DEFAULT '',
    disc              TEXT        NOT NULL DEFAULT '',
    language          TEXT        NOT NULL DEFAULT '',
    composer          TEXT        NOT NULL DEFAULT '',
    lyricist          TEXT        NOT NULL DEFAULT '',
    copyright         TEXT        NOT NULL DEFAULT '',
    albumtype         TEXT        NOT NULL DEFAULT '',
    comment           TEXT        NOT NULL DEFAULT '',
    mb_artist_id      TEXT        NOT NULL DEFAULT '',
    release_group_id  TEXT        NOT NULL DEFAULT '',

    has_cover         BOOLEAN     NOT NULL DEFAULT FALSE,
    has_lyrics        BOOLEAN     NOT NULL DEFAULT FALSE,
    duration          DOUBLE PRECISION NOT NULL DEFAULT 0,

    tags_loaded       BOOLEAN     NOT NULL DEFAULT FALSE,
    path_derived      BOOLEAN     NOT NULL DEFAULT FALSE,
    indexed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at         TIMESTAMPTZ,
    scraped_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist   ON tracks (artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album    ON tracks (album);
CREATE INDEX IF NOT EXISTS idx_tracks_dir      ON tracks (dir);
CREATE INDEX IF NOT EXISTS idx_tracks_language ON tracks (language);
CREATE INDEX IF NOT EXISTS idx_tracks_titletrg ON tracks USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tracks_artisttrg ON tracks USING gin (artist gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tracks_albumtrg ON tracks USING gin (album gin_trgm_ops);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_artist (
    from_name TEXT PRIMARY KEY,
    to_name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_album (
    from_name TEXT PRIMARY KEY,
    to_name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id         UUID PRIMARY KEY,
    kind       TEXT        NOT NULL,
    state      TEXT        NOT NULL,
    total      BIGINT      NOT NULL DEFAULT 0,
    done       BIGINT      NOT NULL DEFAULT 0,
    message    TEXT        NOT NULL DEFAULT '',
    error      TEXT        NOT NULL DEFAULT '',
    result     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_plans (
    token      TEXT PRIMARY KEY,
    payload    JSONB       NOT NULL,
    executed   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
