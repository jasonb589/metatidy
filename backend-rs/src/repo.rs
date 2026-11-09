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
    // 先归一成本机原生写法再查：Windows 上混用 '/' 与 '\' 的同一个文件
    // 在字符串比较里并不相等（见 models::path_key）。
    let key = crate::models::path_key(std::path::Path::new(path));
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE path = $1");
    let row = sqlx::query_as::<_, Track>(&sql)
        .bind(key)
        .fetch_optional(pool)
        .await?;
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
        .bind(crate::models::path_key(p))
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
    /// Exact normalized album group from the album browser, including blank artists.
    pub album_group: Option<(String, String)>,
    /// ASCII-space-normalized, exact track-artist scope; legacy artist stays unchanged.
    pub artist_group: String,
    /// Validated native directory scope, shared with indexed folder browsing.
    pub folder: Option<crate::folders::FolderScope>,
    pub missing_cover: bool,
    pub missing_lyrics: bool,
    pub no_artist: bool,
    pub no_album: bool,
    /// Rust 侧新增：只取「还没读过标签」的索引（快速扫描的产物）。
    /// Python 版没有这个查询参数；用于曲库的「待读标签」筛选。
    pub not_loaded: bool,
    /// 只取这些 id（空 = 不限制）。用于移动预览的 `ids` 分支与批量预览。
    pub ids: Vec<i64>,
}

/// 绑定参数：文本与数字 id 混排时必须按位置区分类型。
#[derive(Debug, PartialEq)]
enum Param {
    Text(String),
    Ids(Vec<i64>),
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

/// The list and whole-filter snapshot must share their actual predicates and
/// deterministic ordering, rather than maintaining two similar query builders.
struct TrackSql {
    predicate: String,
    order: String,
    params: Vec<Param>,
}

fn track_sql(query: &TrackQuery) -> TrackSql {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Param> = Vec::new();
    // 刚 push 进去的那个参数在 SQL 里的下标：Postgres 从 1 开始，push 之后
    // `params.len()` 正好就是它。**不能写成 len()+1** —— 调用点全都在 push 之后，
    // 那样第一个参数会被写成 $2，于是「只绑了 1 个参数却引用 $2」直接 500
    // （本地端到端第一次跑就是卡在这里：preview / move-preview / 任意带过滤的列表全挂）。
    let placeholder = |params: &[Param]| params.len();

    if !query.q.trim().is_empty() {
        params.push(Param::Text(format!("%{}%", query.q.trim())));
        let idx = placeholder(&params);
        // 8 列子串匹配（Python 版同样是这 8 列）
        clauses.push(format!(
            "(title ILIKE ${idx} OR artist ILIKE ${idx} OR album ILIKE ${idx} \
             OR albumartist ILIKE ${idx} OR filename ILIKE ${idx} OR path ILIKE ${idx} \
             OR genre ILIKE ${idx} OR year ILIKE ${idx})"
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
            params.push(Param::Text(value.trim().to_string()));
            clauses.push(format!("{column} = ${}", placeholder(&params)));
        }
    }
    if let Some((album, artist)) = &query.album_group {
        params.push(Param::Text(album.clone()));
        let album_bind = placeholder(&params);
        params.push(Param::Text(artist.clone()));
        clauses.push(album_group_predicate(album_bind, placeholder(&params)));
    }
    if !query.artist_group.is_empty() {
        params.push(Param::Text(query.artist_group.clone()));
        clauses.push(artist_group_predicate(placeholder(&params)));
    }
    if let Some(folder) = &query.folder {
        params.push(Param::Text(folder.directory().to_owned()));
        let exact_bind = placeholder(&params);
        let descendants_bind = if folder.recursive() {
            params.push(Param::Text(folder.descendant_pattern()));
            Some(placeholder(&params))
        } else {
            None
        };
        clauses.push(crate::folders::dir_predicate(exact_bind, descendants_bind));
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
        clauses.push(format!("{ALBUM_NAME_EXPR} = ''"));
    }
    if query.not_loaded {
        clauses.push("tags_loaded = false".to_string());
    }
    if !query.ids.is_empty() {
        params.push(Param::Ids(query.ids.clone()));
        clauses.push(format!("id = ANY(${})", placeholder(&params)));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let sort_expr = match query.sort.as_str() {
        // 8 个白名单值，未知值静默回落 artist（与 Python 一致）。
        // 注意：Python 的 indexed/edited 因白名单值自带 DESC、SQL 又拼一次方向而实测 500
        // （契约 K.13）——这里**有意修好**：SQL 只拼一次方向，方向完全由 `order` 决定。
        "title" => "title",
        "album" => "album",
        "year" => "year",
        "path" => "path",
        "track" => "track",
        "indexed" => "indexed_at",
        "edited" => "edited_at",
        _ => "artist",
    };
    let direction = if query.order_desc { "DESC" } else { "ASC" };
    let order_sql = if query.sort == "disc_track" {
        disc_track_order(query.order_desc)
    } else {
        format!("{sort_expr} {direction}, id ASC")
    };
    TrackSql {
        predicate: where_sql,
        order: order_sql,
        params,
    }
}

/// 分页列出曲目。**只查索引，绝不读音频文件**——这是「歌一多就卡」的解法。
pub async fn list_tracks(pool: &PgPool, query: &TrackQuery) -> anyhow::Result<PagedTracks> {
    let TrackSql {
        predicate: where_sql,
        order: order_sql,
        params,
    } = track_sql(query);
    let page_size = query.page_size.clamp(1, 1000);
    let page = query.page.max(1);
    let offset = (page - 1).saturating_mul(page_size);

    let count_sql = format!("SELECT count(*) FROM tracks{where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for p in &params {
        count_query = match p {
            Param::Text(v) => count_query.bind(v),
            Param::Ids(v) => count_query.bind(v),
        };
    }
    let total = count_query.fetch_one(pool).await?;
    let list_sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks{where_sql} ORDER BY {order_sql} LIMIT ${} OFFSET ${}",
        params.len() + 1,
        params.len() + 2
    );
    let mut list_query = sqlx::query_as::<_, Track>(&list_sql);
    for p in &params {
        list_query = match p {
            Param::Text(v) => list_query.bind(v),
            Param::Ids(v) => list_query.bind(v),
        };
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

/// One statement gets one PostgreSQL MVCC snapshot. The extra row detects an
/// over-limit result without COUNT or exposing a truncated successful response.
/// The caller must reject more than FILTERED_SELECTION_LIMIT rows in full.
pub const FILTERED_SELECTION_LIMIT: usize = 20_000;

pub async fn filtered_track_snapshot(pool: &PgPool, query: &TrackQuery) -> anyhow::Result<Vec<Track>> {
    let TrackSql {
        predicate,
        order,
        params,
    } = track_sql(query);
    let sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks{predicate} ORDER BY {order} LIMIT {}",
        FILTERED_SELECTION_LIMIT + 1,
    );
    let mut statement = sqlx::query_as::<_, Track>(&sql);
    for param in &params {
        statement = match param {
            Param::Text(value) => statement.bind(value),
            Param::Ids(value) => statement.bind(value),
        };
    }
    Ok(statement.fetch_all(pool).await?)
}

/// These expressions are shared by album grouping and its exact track filter.
/// Album-artist tags keep compilations together; track artist is the fallback.
const ALBUM_NAME_EXPR: &str = "BTRIM(album)";
const ALBUM_ARTIST_EXPR: &str = "COALESCE(NULLIF(BTRIM(albumartist), ''), BTRIM(artist))";

/// Hashes make the exact-group index safe for long text tags. The original
/// expressions remain mandatory residual checks; hash equality is not identity.
fn album_group_predicate(album_bind: usize, artist_bind: usize) -> String {
    format!(
        "{ALBUM_NAME_EXPR} <> '' AND \
        md5({ALBUM_NAME_EXPR}) = md5(${album_bind}::text) AND \
        md5({ALBUM_ARTIST_EXPR}) = md5(${artist_bind}::text) AND \
        {ALBUM_NAME_EXPR} = ${album_bind} AND {ALBUM_ARTIST_EXPR} = ${artist_bind}"
    )
}

fn artist_group_predicate(bind: usize) -> String {
    format!("BTRIM(artist) <> '' AND md5(BTRIM(artist))=md5(${bind}::text) AND BTRIM(artist)=${bind}")
}

/// All album pages and whole-album selections use the track list's numeric
/// order, including totals, malformed values and deterministic ID ties.
fn disc_track_order(descending: bool) -> String {
    let direction = if descending { "DESC" } else { "ASC" };
    let numeric = |column: &str, fallback: &str| {
        format!(
            "CASE WHEN BTRIM(split_part({column}, '/', 1)) ~ '^[0-9]{{1,9}}$' \
            THEN BTRIM(split_part({column}, '/', 1))::bigint ELSE {fallback} END"
        )
    };
    format!(
        "{} {direction}, {} {direction} NULLS LAST, id ASC",
        numeric("disc", "1"),
        numeric("track", "NULL")
    )
}

const ALBUM_SUMMARY_FIELDS: &str = "count(*) AS track_count, \
    count(DISTINCT COALESCE(NULLIF(BTRIM(disc), ''), '1')) AS disc_count, \
    COALESCE(sum(duration), 0)::double precision AS duration, \
    COALESCE(sum(size), 0)::bigint AS bytes, \
    count(*) FILTER (WHERE NOT has_cover) AS missing_cover, \
    count(*) FILTER (WHERE NOT has_lyrics) AS missing_lyrics, \
    count(*) FILTER (WHERE NOT tags_loaded) AS not_loaded, \
    min(id) FILTER (WHERE has_cover) AS cover_track_id, \
    CASE WHEN count(DISTINCT NULLIF(BTRIM(year), '')) = 1 \
         THEN min(NULLIF(BTRIM(year), '')) ELSE '' END AS year, \
    extract(epoch from max(indexed_at))::double precision AS indexed_at";

// JSON tuples avoid delimiter ambiguity in arbitrary tag text. This is a
// membership/order revision, not an authorization token or a file lock.
const ALBUM_REVISION_EXPR: &str = "md5(COALESCE(string_agg(\
    jsonb_build_array(id, disc, track)::text, ',' ORDER BY id), ''))";

fn album_summary_sql(where_sql: &str, having_sql: &str, with_revision: bool) -> String {
    let revision = if with_revision {
        format!(", {ALBUM_REVISION_EXPR} AS revision")
    } else {
        String::new()
    };
    format!(
        "SELECT {ALBUM_NAME_EXPR} AS album, {ALBUM_ARTIST_EXPR} AS album_artist, \
        {ALBUM_SUMMARY_FIELDS}{revision} FROM tracks WHERE {where_sql} \
        GROUP BY {ALBUM_NAME_EXPR}, {ALBUM_ARTIST_EXPR}{having_sql}"
    )
}

#[derive(Debug, Clone)]
pub struct AlbumQuery {
    pub q: String,
    pub page: i64,
    pub page_size: i64,
    pub sort: String,
    pub incomplete: bool,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct AlbumSummary {
    pub album: String,
    pub album_artist: String,
    pub track_count: i64,
    pub disc_count: i64,
    pub duration: f64,
    pub bytes: i64,
    pub missing_cover: i64,
    pub missing_lyrics: i64,
    pub not_loaded: i64,
    pub cover_track_id: Option<i64>,
    pub year: String,
    pub indexed_at: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PagedAlbums {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub items: Vec<AlbumSummary>,
}

#[derive(sqlx::FromRow)]
struct AlbumHeader {
    #[sqlx(flatten)]
    summary: AlbumSummary,
    revision: String,
}

pub struct AlbumDetail {
    pub summary: AlbumSummary,
    pub revision: String,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub items: Vec<Track>,
}

pub enum AlbumSelection {
    Missing,
    Changed,
    Ready { revision: String, ids: Vec<i64> },
}

fn album_page(total: i64, requested: i64, page_size: i64) -> (i64, i64, i64) {
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / page_size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    (page, pages, (page - 1) * page_size)
}

pub async fn album_detail(
    pool: &PgPool,
    group: &(String, String),
    requested: i64,
    page_size: i64,
) -> anyhow::Result<Option<AlbumDetail>> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let predicate = album_group_predicate(1, 2);
    let header: Option<AlbumHeader> = sqlx::query_as(&album_summary_sql(&predicate, "", true))
        .bind(&group.0)
        .bind(&group.1)
        .fetch_optional(&mut *transaction)
        .await?;
    let Some(header) = header else {
        return Ok(None);
    };
    let (page, pages, offset) = album_page(header.summary.track_count, requested, page_size);
    let items = sqlx::query_as::<_, Track>(&format!(
        "SELECT {TRACK_COLUMNS} FROM tracks WHERE {predicate} ORDER BY {} LIMIT $3 OFFSET $4",
        disc_track_order(false),
    ))
    .bind(&group.0)
    .bind(&group.1)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(AlbumDetail {
        summary: header.summary,
        revision: header.revision,
        page,
        page_size,
        pages,
        items,
    }))
}

/// Select all IDs in one snapshot, independent of track-list page caps. The
/// caller receives a fixed set; subsequent group edits cannot extend that set.
pub async fn album_selection(
    pool: &PgPool,
    group: &(String, String),
    expected_revision: &str,
) -> anyhow::Result<AlbumSelection> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let predicate = album_group_predicate(1, 2);
    let (total, revision): (i64, String) = sqlx::query_as(&format!(
        "SELECT count(*), {ALBUM_REVISION_EXPR} FROM tracks WHERE {predicate}",
    ))
    .bind(&group.0)
    .bind(&group.1)
    .fetch_one(&mut *transaction)
    .await?;
    if total == 0 {
        return Ok(AlbumSelection::Missing);
    }
    if revision != expected_revision {
        return Ok(AlbumSelection::Changed);
    }
    let ids: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT id FROM tracks WHERE {predicate} ORDER BY {}",
        disc_track_order(false),
    ))
    .bind(&group.0)
    .bind(&group.1)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(AlbumSelection::Ready { revision, ids })
}

/// Literal substring search: user-entered percent/underscore are not wildcards.
fn album_search_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query.trim().replace('!', "!!").replace('%', "!%").replace('_', "!_")
    )
}

/// Album browsing never stats paths or opens audio files. Count and page share a
/// short repeatable-read snapshot so scans cannot change the page between queries.
pub async fn list_albums(pool: &PgPool, query: &AlbumQuery) -> anyhow::Result<PagedAlbums> {
    let pattern = album_search_pattern(&query.q);
    let where_sql = format!(
        "{ALBUM_NAME_EXPR} <> '' AND \
         ({ALBUM_NAME_EXPR} ILIKE $1 ESCAPE '!' OR {ALBUM_ARTIST_EXPR} ILIKE $1 ESCAPE '!')"
    );
    let having_sql = if query.incomplete {
        " HAVING bool_or(NOT has_cover OR NOT has_lyrics OR NOT tags_loaded)"
    } else {
        ""
    };
    let grouped_sql = album_summary_sql(&where_sql, having_sql, false);
    // Sort expressions are constants; query values are always bound parameters.
    let order_sql = match query.sort.as_str() {
        "artist" => "album_artist ASC, album ASC",
        "recent" => "indexed_at DESC, album ASC, album_artist ASC",
        _ => "album ASC, album_artist ASC",
    };
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let count_sql = format!("SELECT count(*) FROM ({grouped_sql}) AS albums");
    let total = sqlx::query_scalar::<_, i64>(&count_sql)
        .bind(&pattern)
        .fetch_one(&mut *transaction)
        .await?;
    let page_size = query.page_size.clamp(1, 100);
    let (page, pages, offset) = album_page(total, query.page, page_size);
    let list_sql = format!(
        "SELECT * FROM ({grouped_sql}) AS albums ORDER BY {order_sql} LIMIT $2 OFFSET $3"
    );
    let items = sqlx::query_as::<_, AlbumSummary>(&list_sql)
        .bind(&pattern)
        .bind(page_size)
        .bind(offset)
        .fetch_all(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(PagedAlbums {
        total,
        page,
        page_size,
        pages,
        items,
    })
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ArtistSummary {
    pub name: String,
    pub track_count: i64,
    pub album_count: i64,
    pub unalbumed_count: i64,
    pub duration: f64,
    pub bytes: i64,
    pub missing_cover: i64,
    pub missing_lyrics: i64,
    pub not_loaded: i64,
    pub indexed_at: f64,
}

pub struct PagedArtists {
    pub total: i64,
    pub page: i64,
    pub pages: i64,
    pub items: Vec<ArtistSummary>,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct ArtistAlbum {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub summary: AlbumSummary,
    pub artist_track_count: i64,
}

pub enum ArtistItems {
    Albums(Vec<ArtistAlbum>),
    Tracks(Vec<Track>),
}

pub struct ArtistDetail {
    pub summary: ArtistSummary,
    pub revision: String,
    pub total: i64,
    pub page: i64,
    pub pages: i64,
    pub items: ArtistItems,
}

pub enum ArtistDetailResult {
    Missing,
    Changed,
    Ready(ArtistDetail),
}

fn artist_summary_sql(predicate: &str) -> String {
    format!("SELECT BTRIM(artist) AS name, count(*) AS track_count, \
        count(DISTINCT ({ALBUM_NAME_EXPR},{ALBUM_ARTIST_EXPR})) FILTER (WHERE {ALBUM_NAME_EXPR}<>'') AS album_count, \
        count(*) FILTER (WHERE {ALBUM_NAME_EXPR}='') AS unalbumed_count, \
        COALESCE(sum(duration),0)::double precision AS duration, COALESCE(sum(size),0)::bigint AS bytes, \
        count(*) FILTER (WHERE NOT has_cover) AS missing_cover, \
        count(*) FILTER (WHERE NOT has_lyrics) AS missing_lyrics, \
        count(*) FILTER (WHERE NOT tags_loaded) AS not_loaded, \
        COALESCE(extract(epoch from max(indexed_at)),0)::double precision AS indexed_at \
        FROM tracks WHERE {predicate} GROUP BY BTRIM(artist)")
}

/// Artist stats and the page use one database snapshot. No audio paths, cover
/// URLs, portrait services or caches are accessed by this browsing query.
pub async fn list_library_artists(
    pool: &PgPool,
    q: &str,
    sort: &str,
    descending: bool,
    requested: i64,
    page_size: i64,
) -> anyhow::Result<PagedArtists> {
    let grouped = artist_summary_sql("BTRIM(artist)<>'' AND BTRIM(artist) ILIKE $1 ESCAPE '!'");
    let column = match sort {
        "tracks" => "track_count",
        "recent" => "indexed_at",
        _ => "name",
    };
    let direction = if descending { "DESC" } else { "ASC" };
    let pattern = album_search_pattern(q);
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM ({grouped}) AS artists"))
        .bind(&pattern)
        .fetch_one(&mut *tx)
        .await?;
    let (page, pages, offset) = album_page(total, requested, page_size);
    let items = sqlx::query_as(&format!("SELECT * FROM ({grouped}) AS artists ORDER BY {column} {direction},name ASC LIMIT $2 OFFSET $3"))
        .bind(&pattern).bind(page_size).bind(offset).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(PagedArtists {
        total,
        page,
        pages,
        items,
    })
}

/// Related full-album rows participate in the revision because album cards
/// report whole-album metadata, including tracks by other artists. xmin also
/// catches A→B→A edits whose final values happen to match the original values.
const ARTIST_RELATED_CTE: &str = "WITH own_rows AS MATERIALIZED (
    SELECT id,xmin::text AS row_version,BTRIM(album) AS album,
        COALESCE(NULLIF(BTRIM(albumartist),''),BTRIM(artist)) AS album_artist
    FROM tracks WHERE BTRIM(artist)<>'' AND md5(BTRIM(artist))=md5($1::text) AND BTRIM(artist)=$1),
    own_groups AS MATERIALIZED (SELECT DISTINCT album,album_artist FROM own_rows WHERE album<>''), related AS (
    SELECT id,row_version FROM own_rows UNION
    SELECT t.id,t.xmin::text AS row_version FROM own_groups g JOIN tracks t
        ON BTRIM(t.album)<>'' AND md5(BTRIM(t.album))=md5(g.album)
        AND md5(COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist)))=md5(g.album_artist)
        AND BTRIM(t.album)=g.album AND COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist))=g.album_artist)";

pub async fn library_artist_detail(
    pool: &PgPool,
    name: &str,
    section: &str,
    requested: i64,
    page_size: i64,
    expected_revision: Option<&str>,
) -> anyhow::Result<ArtistDetailResult> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let predicate = artist_group_predicate(1);
    let summary: Option<ArtistSummary> = sqlx::query_as(&artist_summary_sql(&predicate))
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(summary) = summary else {
        return Ok(ArtistDetailResult::Missing);
    };
    let revision: String = sqlx::query_scalar(&format!("{ARTIST_RELATED_CTE} SELECT md5(jsonb_build_array($1::text,COALESCE(string_agg(jsonb_build_array(id,row_version)::text,',' ORDER BY id),''))::text) FROM related"))
        .bind(name).fetch_one(&mut *tx).await?;
    if expected_revision.is_some_and(|expected| expected != revision) {
        return Ok(ArtistDetailResult::Changed);
    }
    let total = if section == "albums" {
        summary.album_count
    } else {
        summary.track_count
    };
    let (page, pages, offset) = album_page(total, requested, page_size);
    let items = if section == "albums" {
        // Aggregate only the requested groups, but aggregate every track within
        // those groups. artist_track_count explicitly describes the subset.
        let sql = format!("WITH groups AS (
            SELECT {ALBUM_NAME_EXPR} AS album,{ALBUM_ARTIST_EXPR} AS album_artist,count(*) AS artist_track_count
            FROM tracks WHERE {predicate} AND {ALBUM_NAME_EXPR}<>'' GROUP BY {ALBUM_NAME_EXPR},{ALBUM_ARTIST_EXPR}
            ORDER BY album,album_artist LIMIT $2 OFFSET $3)
            SELECT details.*,g.artist_track_count FROM groups g CROSS JOIN LATERAL (
                SELECT BTRIM(t.album) AS album,COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist)) AS album_artist,
                {ALBUM_SUMMARY_FIELDS} FROM tracks t
                WHERE BTRIM(t.album)=g.album AND COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist))=g.album_artist
                AND md5(BTRIM(t.album))=md5(g.album)
                AND md5(COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist)))=md5(g.album_artist)
                GROUP BY BTRIM(t.album),COALESCE(NULLIF(BTRIM(t.albumartist),''),BTRIM(t.artist))) details
            ORDER BY g.album,g.album_artist");
        ArtistItems::Albums(
            sqlx::query_as(&sql)
                .bind(name)
                .bind(page_size)
                .bind(offset)
                .fetch_all(&mut *tx)
                .await?,
        )
    } else {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE {predicate} ORDER BY {ALBUM_NAME_EXPR},{ALBUM_ARTIST_EXPR},{} LIMIT $2 OFFSET $3",disc_track_order(false));
        ArtistItems::Tracks(
            sqlx::query_as(&sql)
                .bind(name)
                .bind(page_size)
                .bind(offset)
                .fetch_all(&mut *tx)
                .await?,
        )
    };
    tx.commit().await?;
    Ok(ArtistDetailResult::Ready(ArtistDetail {
        summary,
        revision,
        total,
        page,
        pages,
        items,
    }))
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
    /// 非空 language 去重（排序），前端用来填下拉框
    pub languages: Vec<String>,
    /// 非空 albumtype 去重（排序）
    pub albumtypes: Vec<String>,
}

pub async fn library_stats(pool: &PgPool) -> anyhow::Result<LibraryStats> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            count(*),
            count(DISTINCT NULLIF(artist, '')),
            count(DISTINCT NULLIF(BTRIM(album), '')),
            count(*) FILTER (WHERE NOT has_cover),
            count(*) FILTER (WHERE NOT has_lyrics),
            count(*) FILTER (WHERE artist = ''),
            count(*) FILTER (WHERE BTRIM(album) = ''),
            count(*) FILTER (WHERE NOT tags_loaded),
            COALESCE(sum(size), 0)::bigint
         FROM tracks",
    )
    .fetch_one(pool)
    .await?;
    let languages: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT language FROM tracks WHERE language <> '' ORDER BY 1",
    )
    .fetch_all(pool)
    .await?;
    let albumtypes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT albumtype FROM tracks WHERE albumtype <> '' ORDER BY 1",
    )
    .fetch_all(pool)
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
        languages,
        albumtypes,
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

/// 按 from_name 升序读别名（前端列表要稳定顺序；Python 是插入顺序，这里用字典序）。
pub async fn aliases_ordered(pool: &PgPool, table: &str) -> anyhow::Result<Vec<(String, String)>> {
    let sql = match table {
        "artist" => "SELECT from_name, to_name FROM alias_artist ORDER BY from_name",
        "album" => "SELECT from_name, to_name FROM alias_album ORDER BY from_name",
        other => anyhow::bail!("未知别名表：{other}"),
    };
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    Ok(rows)
}

/// 写盘之后同步索引：文本字段 + 文件元数据 + 时间戳/封面歌词标志。
///
/// 为什么单独一个函数：`update_fields` 只认 16 个文本列，而三条写路径
/// （编辑落库 / 刮削写盘 / 封面歌词）还要更新 `mtime`/`size`/`scraped_at`/
/// `has_cover`/`has_lyrics`，这些列都得一次性写进去（Python 版也是拼一个大 dict）。
pub async fn sync_after_write(
    pool: &PgPool,
    id: i64,
    fields: &HashMap<String, String>,
    mtime: Option<f64>,
    size: Option<i64>,
    scraped: bool,
    has_cover: Option<bool>,
    has_lyrics: Option<bool>,
    touch_edited: bool,
) -> anyhow::Result<()> {
    let allowed = [
        "title", "artist", "album", "albumartist", "genre", "year", "track", "disc",
        "language", "composer", "lyricist", "copyright", "albumtype", "comment",
        "mb_artist_id", "release_group_id",
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for key in allowed {
        if let Some(v) = fields.get(key) {
            texts.push(v.clone());
            sets.push(format!("{key} = ${}", texts.len()));
        }
    }
    // 可选列按固定顺序追加，绑定顺序与占位符顺序必须一致
    let mut next = texts.len();
    let mut numeric_binds: u8 = 0;
    if mtime.is_some() {
        next += 1;
        numeric_binds |= 1;
        sets.push(format!("mtime = ${next}"));
    }
    if size.is_some() {
        next += 1;
        numeric_binds |= 2;
        sets.push(format!("size = ${next}"));
    }
    if has_cover.is_some() {
        next += 1;
        numeric_binds |= 4;
        sets.push(format!("has_cover = ${next}"));
    }
    if has_lyrics.is_some() {
        next += 1;
        numeric_binds |= 8;
        sets.push(format!("has_lyrics = ${next}"));
    }
    if scraped {
        sets.push("scraped_at = now()".to_string());
    }
    if touch_edited {
        sets.push("edited_at = now()".to_string());
    }
    if sets.is_empty() {
        return Ok(());
    }
    let sql = format!("UPDATE tracks SET {} WHERE id = ${}", sets.join(", "), next + 1);
    let mut query = sqlx::query(&sql);
    for v in &texts {
        query = query.bind(v);
    }
    if numeric_binds & 1 != 0 {
        query = query.bind(mtime.unwrap_or_default());
    }
    if numeric_binds & 2 != 0 {
        query = query.bind(size.unwrap_or_default());
    }
    if numeric_binds & 4 != 0 {
        query = query.bind(has_cover.unwrap_or(false));
    }
    if numeric_binds & 8 != 0 {
        query = query.bind(has_lyrics.unwrap_or(false));
    }
    let updated = query.bind(id).execute(pool).await?;
    anyhow::ensure!(updated.rows_affected() == 1, "写入后曲目索引已不存在，请重新扫描");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{album_page, disc_track_order, track_sql, Param, TrackQuery};

    #[test]
    fn track_scope_binds_search_groups_directories_and_ids_without_interpolation() {
        let root = if cfg!(windows) {
            std::path::Path::new(r"C:\Music")
        } else {
            std::path::Path::new("/music")
        };
        let directory = crate::models::path_key(&root.join("100%_! 's"));
        let folder = crate::folders::FolderScope::new(root, &directory, true).unwrap();
        let descendants = folder.descendant_pattern();
        let query = TrackQuery {
            q: "  O'Brien%_  ".into(),
            language: " zh ".into(),
            albumtype: " studio ".into(),
            genre: " pop ".into(),
            year: " 2026 ".into(),
            artist: " artist ".into(),
            album: " album ".into(),
            album_group: Some(("A 'group'".into(), "".into())),
            folder: Some(folder),
            missing_cover: true,
            missing_lyrics: true,
            no_artist: true,
            no_album: true,
            not_loaded: true,
            ids: vec![3, 5],
            ..TrackQuery::default()
        };
        let sql = track_sql(&query);
        assert_eq!(sql.params, vec![
            Param::Text("%O'Brien%_%".into()),
            Param::Text("zh".into()),
            Param::Text("studio".into()),
            Param::Text("pop".into()),
            Param::Text("2026".into()),
            Param::Text("artist".into()),
            Param::Text("album".into()),
            Param::Text("A 'group'".into()),
            Param::Text("".into()),
            Param::Text(directory.clone()),
            Param::Text(descendants.clone()),
            Param::Ids(vec![3, 5]),
        ]);
        // Query wildcards keep the list endpoint's meaning; native directory
        // wildcards are escaped so an exact folder cannot widen into its peers.
        assert!(descendants.contains("100!%!_!! 's"));
        assert!(!sql.predicate.contains("O'Brien"));
        assert!(!sql.predicate.contains(&directory));
        for column in ["title", "artist", "album", "albumartist", "filename", "path", "genre", "year"] {
            assert!(sql.predicate.contains(&format!("{column} ILIKE $1")));
        }
        for predicate in [
            "language = $2", "albumtype = $3", "genre = $4", "year = $5",
            "artist = $6", "album = $7", "BTRIM(album) = $8",
            "COALESCE(NULLIF(BTRIM(albumartist), ''), BTRIM(artist)) = $9",
            "(dir = $10 OR dir LIKE $11 ESCAPE '!')", "has_cover = false",
            "has_lyrics = false", "artist = ''", "BTRIM(album) = ''",
            "tags_loaded = false", "id = ANY($12)",
        ] {
            assert!(sql.predicate.contains(predicate), "{predicate}");
        }
        let direct = TrackQuery {
            folder: Some(crate::folders::FolderScope::new(root, &directory, false).unwrap()),
            ..TrackQuery::default()
        };
        let direct_sql = track_sql(&direct);
        assert_eq!(direct_sql.predicate, " WHERE dir = $1");
        assert_eq!(direct_sql.params, vec![Param::Text(directory)]);
    }

    #[test]
    fn exact_artist_group_does_not_change_the_legacy_artist_filter() {
        let query = TrackQuery { artist: " Legacy ".into(), artist_group: "\u{3000}A & B / O'Brien\u{3000}".into(), ..Default::default() };
        let sql = track_sql(&query);
        assert_eq!(sql.params,vec![Param::Text("Legacy".into()),Param::Text("\u{3000}A & B / O'Brien\u{3000}".into())]);
        assert!(sql.predicate.contains("artist = $1"));
        assert!(sql.predicate.contains("BTRIM(artist)=$2"));
        assert!(sql.predicate.contains("md5(BTRIM(artist))=md5($2::text)"));
        assert!(!sql.predicate.contains("O'Brien"));
    }

    #[test]
    fn track_sort_has_stable_ties_and_scope_is_independent_of_pagination() {
        for (sort, column) in [
            ("artist", "artist"), ("title", "title"), ("album", "album"),
            ("year", "year"), ("path", "path"), ("track", "track"),
            ("indexed", "indexed_at"), ("edited", "edited_at"),
            ("artist; DROP TABLE tracks", "artist"),
        ] {
            for descending in [false, true] {
                let query = TrackQuery {
                    sort: sort.into(), order_desc: descending,
                    ..TrackQuery::default()
                };
                let sql = track_sql(&query);
                let direction = if descending { "DESC" } else { "ASC" };
                assert_eq!(sql.order, format!("{column} {direction}, id ASC"));
                assert!(sql.predicate.is_empty());
                assert!(sql.params.is_empty());
            }
        }
        for descending in [false, true] {
            let query = TrackQuery {
                sort: "disc_track".into(), order_desc: descending,
                q: "filtered".into(), ..TrackQuery::default()
            };
            let sql = track_sql(&query);
            assert_eq!(sql.order, disc_track_order(descending));
            assert!(sql.order.ends_with("NULLS LAST, id ASC"));
            let paginated = track_sql(&TrackQuery {
                page: i64::MAX, page_size: 1, ..query
            });
            assert_eq!(sql.predicate, paginated.predicate);
            assert_eq!(sql.params, paginated.params);
            assert_eq!(sql.order, paginated.order);
        }
    }

    #[test]
    fn album_pages_cover_large_groups_and_clamp_without_overflow() {
        assert_eq!(album_page(1005, 1, 200), (1, 6, 0));
        assert_eq!(album_page(1005, i64::MAX, 200), (6, 6, 1000));
        assert_eq!(album_page(1005, -10, 200), (1, 6, 0));
        assert_eq!(album_page(0, 50, 100), (1, 0, 0));
        assert_eq!(
            album_page(i64::MAX, i64::MAX, 100),
            (92233720368547759, 92233720368547759, 9223372036854775800)
        );
    }
}
