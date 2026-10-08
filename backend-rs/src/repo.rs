//! Postgres 访问层。
//!
//! 与 Python 版相比，这里没有「每线程一个连接 + 全局写锁」那套东西：
//! 连接池 + 真并发，写入不再需要串行化。
//!
//! 所有 SQL 都用运行时 `sqlx::query`（不用 `query!` 宏），
//! 这样**编译期不需要连数据库**，CI 里也不会因为拿不到 DATABASE_URL 而炸。

use anyhow::Context;
use sqlx::types::Json;
use sqlx::PgPool;
use std::collections::HashMap;

use crate::models::Track;

/// 供 SELECT * 复用的列清单（与 models::Track 字段一一对应）。
pub const TRACK_COLUMNS: &str = "id, path, dir, filename, ext, mtime, size, \
     title, artist, album, albumartist, genre, year, track, disc, language, \
     composer, lyricist, copyright, albumtype, comment, mb_artist_id, release_group_id, \
     has_cover, has_lyrics, duration, tags_loaded, path_derived, \
     indexed_at, edited_at, scraped_at";

/// 待写入索引的一条记录。
#[derive(Debug, Clone, Default)]
pub struct TrackUpsert {
    pub path: String,
    pub dir: String,
    pub filename: String,
    pub ext: String,
    pub mtime: f64,
    pub size: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub albumartist: String,
    pub genre: String,
    pub year: String,
    pub track: String,
    pub disc: String,
    pub language: String,
    pub composer: String,
    pub lyricist: String,
    pub copyright: String,
    pub albumtype: String,
    pub comment: String,
    pub mb_artist_id: String,
    pub release_group_id: String,
    pub has_cover: bool,
    pub has_lyrics: bool,
    pub duration: f64,
    pub tags_loaded: bool,
    pub path_derived: bool,
}

/// 插入或更新一条曲目索引。
pub async fn upsert_track(pool: &PgPool, t: &TrackUpsert) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO tracks (
            path, dir, filename, ext, mtime, size,
            title, artist, album, albumartist, genre, year, track, disc, language,
            composer, lyricist, copyright, albumtype, comment, mb_artist_id, release_group_id,
            has_cover, has_lyrics, duration, tags_loaded, path_derived, indexed_at
         ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22,
            $23, $24, $25, $26, $27, now()
         )
         ON CONFLICT (path) DO UPDATE SET
            dir = EXCLUDED.dir, filename = EXCLUDED.filename, ext = EXCLUDED.ext,
            mtime = EXCLUDED.mtime, size = EXCLUDED.size,
            title = EXCLUDED.title, artist = EXCLUDED.artist, album = EXCLUDED.album,
            albumartist = EXCLUDED.albumartist, genre = EXCLUDED.genre, year = EXCLUDED.year,
            track = EXCLUDED.track, disc = EXCLUDED.disc, language = EXCLUDED.language,
            composer = EXCLUDED.composer, lyricist = EXCLUDED.lyricist,
            copyright = EXCLUDED.copyright, albumtype = EXCLUDED.albumtype,
            comment = EXCLUDED.comment, mb_artist_id = EXCLUDED.mb_artist_id,
            release_group_id = EXCLUDED.release_group_id,
            has_cover = EXCLUDED.has_cover, has_lyrics = EXCLUDED.has_lyrics,
            duration = EXCLUDED.duration, tags_loaded = EXCLUDED.tags_loaded,
            path_derived = EXCLUDED.path_derived, indexed_at = now()",
    )
    .bind(&t.path)
    .bind(&t.dir)
    .bind(&t.filename)
    .bind(&t.ext)
    .bind(t.mtime)
    .bind(t.size)
    .bind(&t.title)
    .bind(&t.artist)
    .bind(&t.album)
    .bind(&t.albumartist)
    .bind(&t.genre)
    .bind(&t.year)
    .bind(&t.track)
    .bind(&t.disc)
    .bind(&t.language)
    .bind(&t.composer)
    .bind(&t.lyricist)
    .bind(&t.copyright)
    .bind(&t.albumtype)
    .bind(&t.comment)
    .bind(&t.mb_artist_id)
    .bind(&t.release_group_id)
    .bind(t.has_cover)
    .bind(t.has_lyrics)
    .bind(t.duration)
    .bind(t.tags_loaded)
    .bind(t.path_derived)
    .execute(pool)
    .await
    .with_context(|| format!("写入索引失败：{}", t.path))?;
    Ok(())
}

/// 已索引文件的 (path -> (mtime, size)) 快照，用于增量判断。
pub async fn existing_state(pool: &PgPool) -> anyhow::Result<HashMap<String, (f64, i64)>> {
    let rows: Vec<(String, f64, i64)> = sqlx::query_as("SELECT path, mtime, size FROM tracks")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(path, mtime, size)| (path, (mtime, size)))
        .collect())
}

/// 索引里全部路径。
pub async fn all_paths(pool: &PgPool) -> anyhow::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT path FROM tracks").fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// 删除一批索引（文件已从磁盘消失）。
pub async fn delete_paths(pool: &PgPool, paths: &[String]) -> anyhow::Result<u64> {
    if paths.is_empty() {
        return Ok(0);
    }
    let mut removed = 0u64;
    for chunk in paths.chunks(500) {
        let result = sqlx::query("DELETE FROM tracks WHERE path = ANY($1)")
            .bind(chunk)
            .execute(pool)
            .await?;
        removed += result.rows_affected();
    }
    Ok(removed)
}

pub async fn get_track(pool: &PgPool, id: i64) -> anyhow::Result<Option<Track>> {
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = $1");
    let row = sqlx::query_as::<_, Track>(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row)
}

pub async fn get_track_by_path(pool: &PgPool, path: &str) -> anyhow::Result<Option<Track>> {
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE path = $1");
    let row = sqlx::query_as::<_, Track>(&sql).bind(path).fetch_optional(pool).await?;
    Ok(row)
}

/// 只改索引里的部分字段（不碰音频文件），用于编辑落库、移动后同步路径。
pub async fn update_fields(
    pool: &PgPool,
    id: i64,
    fields: &HashMap<String, String>,
    touch_edited: bool,
) -> anyhow::Result<()> {
    let allowed = [
        "title", "artist", "album", "albumartist", "genre", "year", "track", "disc",
        "language", "composer", "lyricist", "copyright", "albumtype", "comment",
        "mb_artist_id", "release_group_id",
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    for key in allowed {
        if let Some(v) = fields.get(key) {
            values.push(v.clone());
            sets.push(format!("{key} = ${}", values.len()));
        }
    }
    if sets.is_empty() && !touch_edited {
        return Ok(());
    }
    if touch_edited {
        sets.push("edited_at = now()".to_string());
    }
    let sql = format!("UPDATE tracks SET {} WHERE id = ${}", sets.join(", "), values.len() + 1);
    let mut query = sqlx::query(&sql);
    for v in &values {
        query = query.bind(v);
    }
    query.bind(id).execute(pool).await?;
    Ok(())
}

/// 文件被移动后同步索引路径。
pub async fn set_track_path(pool: &PgPool, id: i64, new_path: &str) -> anyhow::Result<()> {
    let p = std::path::Path::new(new_path);
    let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    let filename = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default()
        .to_lowercase();
    sqlx::query("UPDATE tracks SET path = $1, dir = $2, filename = $3, ext = $4 WHERE id = $5")
        .bind(new_path)
        .bind(dir)
        .bind(filename)
        .bind(ext)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_scraped(pool: &PgPool, id: i64) -> anyhow::Result<()> {
    sqlx::query("UPDATE tracks SET scraped_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 一次分页列表查询的参数。
#[derive(Debug, Clone, Default)]
pub struct TrackQuery {
    pub q: String,
    pub page: i64,
    pub page_size: i64,
    pub sort: String,
    pub order_desc: bool,
    pub language: String,
    pub albumtype: String,
    pub genre: String,
    pub year: String,
    pub artist: String,
    pub album: String,
    pub missing_cover: bool,
    pub missing_lyrics: bool,
    pub no_artist: bool,
    pub no_album: bool,
    pub not_loaded: bool,
}

/// 分页结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PagedTracks {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub items: Vec<Track>,
}

/// 分页列出曲目。**只查索引，绝不读音频文件**——这是「歌一多就卡」的解法。
pub async fn list_tracks(pool: &PgPool, query: &TrackQuery) -> anyhow::Result<PagedTracks> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();

    if !query.q.trim().is_empty() {
        values.push(format!("%{}%", query.q.trim()));
        let idx = values.len();
        clauses.push(format!(
            "(title ILIKE ${idx} OR artist ILIKE ${idx} OR album ILIKE ${idx} \
             OR albumartist ILIKE ${idx} OR filename ILIKE ${idx} OR path ILIKE ${idx})"
        ));
    }
    for (column, value) in [
        ("language", &query.language),
        ("albumtype", &query.albumtype),
        ("genre", &query.genre),
        ("year", &query.year),
        ("artist", &query.artist),
        ("album", &query.album),
    ] {
        if !value.trim().is_empty() {
            values.push(value.trim().to_string());
            clauses.push(format!("{column} = ${}", values.len()));
        }
    }
    if query.missing_cover {
        clauses.push("has_cover = false".to_string());
    }
    if query.missing_lyrics {
        clauses.push("has_lyrics = false".to_string());
    }
    if query.no_artist {
        clauses.push("artist = ''".to_string());
    }
    if query.no_album {
        clauses.push("album = ''".to_string());
    }
    if query.not_loaded {
        clauses.push("tags_loaded = false".to_string());
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let sort_expr = match query.sort.as_str() {
        "title" => "title",
        "album" => "album",
        "year" => "year",
        "path" => "path",
        "track" => "track",
        "indexed" => "indexed_at",
        _ => "artist",
    };
    let direction = if query.order_desc { "DESC" } else { "ASC" };
    let page_size = query.page_size.clamp(1, 1000);
    let page = query.page.max(1);
    let offset = (page - 1) * page_size;

    let count_sql = format!("SELECT count(*) FROM tracks{where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for v in &values {
        count_query = count_query.bind(v);
    }
    let total = count_query.fetch_one(pool).await?;

    let list_sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks{where_sql} ORDER BY {sort_expr} {direction}, id ASC LIMIT ${} OFFSET ${}",
        values.len() + 1,
        values.len() + 2
    );
    let mut list_query = sqlx::query_as::<_, Track>(&list_sql);
    for v in &values {
        list_query = list_query.bind(v);
    }
    let items = list_query
        .bind(page_size)
        .bind(offset)
        .fetch_all(pool)
        .await?;

    Ok(PagedTracks {
        total,
        page,
        page_size,
        pages: if total == 0 { 0 } else { (total + page_size - 1) / page_size },
        items,
    })
}

/// 库统计。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LibraryStats {
    pub tracks: i64,
    pub artists: i64,
    pub albums: i64,
    pub missing_cover: i64,
    pub missing_lyrics: i64,
    pub no_artist: i64,
    pub no_album: i64,
    pub not_loaded: i64,
    pub bytes: i64,
}

pub async fn library_stats(pool: &PgPool) -> anyhow::Result<LibraryStats> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            count(*),
            count(DISTINCT NULLIF(artist, '')),
            count(DISTINCT NULLIF(album, '')),
            count(*) FILTER (WHERE NOT has_cover),
            count(*) FILTER (WHERE NOT has_lyrics),
            count(*) FILTER (WHERE artist = ''),
            count(*) FILTER (WHERE album = ''),
            count(*) FILTER (WHERE NOT tags_loaded),
            COALESCE(sum(size), 0)::bigint
         FROM tracks",
    )
    .fetch_one(pool)
    .await?;
    Ok(LibraryStats {
        tracks: row.0,
        artists: row.1,
        albums: row.2,
        missing_cover: row.3,
        missing_lyrics: row.4,
        no_artist: row.5,
        no_album: row.6,
        not_loaded: row.7,
        bytes: row.8,
    })
}

// --------------------------------------------------------------------------- 设置

pub async fn get_setting(pool: &PgPool, key: &str) -> anyhow::Result<Option<serde_json::Value>> {
    let row: Option<Json<serde_json::Value>> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|j| j.0))
}

pub async fn get_setting_or(
    pool: &PgPool,
    key: &str,
    default: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    Ok(get_setting(pool, key).await?.unwrap_or(default))
}

pub async fn set_setting(pool: &PgPool, key: &str, value: &serde_json::Value) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(key)
    .bind(Json(value))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn all_settings(pool: &PgPool) -> anyhow::Result<HashMap<String, serde_json::Value>> {
    let rows: Vec<(String, Json<serde_json::Value>)> =
        sqlx::query_as("SELECT key, value FROM settings").fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(k, v)| (k, v.0)).collect())
}

// --------------------------------------------------------------------------- 别名库

pub async fn aliases(pool: &PgPool, table: &str) -> anyhow::Result<HashMap<String, String>> {
    let sql = match table {
        "artist" => "SELECT from_name, to_name FROM alias_artist",
        "album" => "SELECT from_name, to_name FROM alias_album",
        other => anyhow::bail!("未知别名表：{other}"),
    };
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

/// 整体替换某张别名表（与 Python 版的语义一致：前端提交全量）。
pub async fn replace_aliases(
    pool: &PgPool,
    kind: &str,
    mapping: &HashMap<String, String>,
) -> anyhow::Result<usize> {
    let (delete_sql, insert_sql) = match kind {
        "artist" => (
            "DELETE FROM alias_artist",
            "INSERT INTO alias_artist (from_name, to_name) VALUES ($1, $2)",
        ),
        "album" => (
            "DELETE FROM alias_album",
            "INSERT INTO alias_album (from_name, to_name) VALUES ($1, $2)",
        ),
        other => anyhow::bail!("未知别名类型：{other}"),
    };
    let mut tx = pool.begin().await?;
    sqlx::query(delete_sql).execute(&mut *tx).await?;
    let mut saved = 0usize;
    for (from, to) in mapping {
        if from.trim().is_empty() || to.trim().is_empty() {
            continue;
        }
        sqlx::query(insert_sql)
            .bind(from)
            .bind(to)
            .execute(&mut *tx)
            .await?;
        saved += 1;
    }
    tx.commit().await?;
    Ok(saved)
}
