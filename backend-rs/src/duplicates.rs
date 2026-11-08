//! Read-only metadata duplicate review. Equal artist/title tags are candidates,
//! never proof of equal audio content or permission to remove a file.

use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

use crate::models::Track;
use crate::repo::TRACK_COLUMNS;

pub type Group = (String, String);

const ARTIST_KEY: &str = "lower(BTRIM(artist))";
const TITLE_KEY: &str = "lower(BTRIM(title))";
const ELIGIBLE: &str = "tags_loaded AND NOT path_derived \
    AND BTRIM(artist) <> '' AND BTRIM(title) <> ''";

// Cover every light_track_json field, including the original display tags and
// timestamps. Epoch values keep the digest independent of a session's timezone.
// Hash each row first so arbitrarily long tags do not enlarge the final aggregate.
// This is a freshness checksum, not an authorization token or a filesystem lock.
const ROW_REVISION: &str = "md5(jsonb_build_array(\
    id, path, dir, filename, ext, title, artist, album, albumartist, genre, year, \
    track, disc, language, albumtype, has_cover, has_lyrics, duration, \
    extract(epoch from indexed_at), extract(epoch from edited_at), \
    extract(epoch from scraped_at), mtime, size, tags_loaded, path_derived\
    )::text)";

#[derive(Debug, Clone)]
pub struct ListQuery {
    pub q: String,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize)]
pub struct GroupSummary {
    pub group: Group,
    pub artist: String,
    pub title: String,
    pub track_count: i64,
}

#[derive(sqlx::FromRow)]
struct GroupRow {
    artist_key: String,
    title_key: String,
    artist: String,
    title: String,
    track_count: i64,
}

#[derive(Debug, Serialize)]
pub struct PagedGroups {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub items: Vec<GroupSummary>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ComparisonSummary {
    pub bytes: i64,
    pub duration_min: Option<f64>,
    pub duration_max: Option<f64>,
    pub formats: Vec<String>,
    pub missing_cover: i64,
    pub missing_lyrics: i64,
}

#[derive(sqlx::FromRow)]
struct Header {
    total: i64,
    revision: String,
    #[sqlx(flatten)]
    summary: ComparisonSummary,
}

pub struct Detail {
    pub total: i64,
    pub revision: String,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub summary: ComparisonSummary,
    pub items: Vec<Track>,
}

pub enum DetailResult {
    Missing,
    Changed,
    Ready(Detail),
}

pub enum SelectionResult {
    Changed,
    Ready {
        total: i64,
        revision: String,
        track: Track,
    },
}

/// Hash predicates can use the bounded partial index, but original canonical
/// strings remain the identity. A hash collision cannot join unrelated groups.
fn group_predicate() -> String {
    format!(
        "{ELIGIBLE} AND md5({ARTIST_KEY}) = md5($1::text) \
         AND md5({TITLE_KEY}) = md5($2::text) \
         AND {ARTIST_KEY} = $1 AND {TITLE_KEY} = $2"
    )
}

fn page_bounds(total: i64, requested: i64, page_size: i64) -> (i64, i64, i64) {
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / page_size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    (page, pages, (page - 1) * page_size)
}

fn search_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query
            .trim()
            .replace('!', "!!")
            .replace('%', "!%")
            .replace('_', "!_")
    )
}

async fn snapshot(pool: &PgPool) -> anyhow::Result<Transaction<'_, Postgres>> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    Ok(transaction)
}

pub async fn list(pool: &PgPool, query: &ListQuery) -> anyhow::Result<PagedGroups> {
    let pattern = search_pattern(&query.q);
    // Search canonical keys, which are identical for every member of a group.
    // Searching original spellings before grouping could hide group members.
    let grouped = format!(
        "SELECT {ARTIST_KEY} AS artist_key, {TITLE_KEY} AS title_key, \
         min(BTRIM(artist) COLLATE \"C\") AS artist, \
         min(BTRIM(title) COLLATE \"C\") AS title, count(*) AS track_count \
         FROM tracks WHERE {ELIGIBLE} \
         AND ({ARTIST_KEY} ILIKE $1 ESCAPE '!' OR {TITLE_KEY} ILIKE $1 ESCAPE '!') \
         GROUP BY {ARTIST_KEY}, {TITLE_KEY} HAVING count(*) >= 2"
    );
    let mut transaction = snapshot(pool).await?;
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM ({grouped}) AS duplicate_groups"
    ))
    .bind(&pattern)
    .fetch_one(&mut *transaction)
    .await?;
    let page_size = query.page_size.clamp(1, 50);
    let (page, pages, offset) = page_bounds(total, query.page, page_size);
    let rows: Vec<GroupRow> = sqlx::query_as(&format!(
        "SELECT * FROM ({grouped}) AS duplicate_groups \
         ORDER BY artist_key COLLATE \"C\" ASC, title_key COLLATE \"C\" ASC \
         LIMIT $2 OFFSET $3"
    ))
    .bind(&pattern)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(PagedGroups {
        total,
        page,
        page_size,
        pages,
        items: rows
            .into_iter()
            .map(|row| GroupSummary {
                group: (row.artist_key, row.title_key),
                artist: row.artist,
                title: row.title,
                track_count: row.track_count,
            })
            .collect(),
    })
}

async fn header(
    transaction: &mut Transaction<'_, Postgres>,
    group: &Group,
) -> anyhow::Result<Header> {
    let predicate = group_predicate();
    // PostgreSQL orders NaN above Infinity. This predicate excludes both along
    // with unknown/zero/negative durations, while retaining finite positive ones.
    let valid_duration = "duration > 0 AND duration < 'Infinity'::double precision";
    Ok(sqlx::query_as(&format!(
        "SELECT count(*) AS total, \
         md5(jsonb_build_array('duplicates-v1', $1::text, $2::text, count(*))::text \
             || ':' || COALESCE(string_agg({ROW_REVISION}, '' ORDER BY id), '')) AS revision, \
         COALESCE(sum(size), 0)::bigint AS bytes, \
         min(duration) FILTER (WHERE {valid_duration}) AS duration_min, \
         max(duration) FILTER (WHERE {valid_duration}) AS duration_max, \
         COALESCE(array_agg(DISTINCT lower(BTRIM(ext)) COLLATE \"C\" \
             ORDER BY lower(BTRIM(ext)) COLLATE \"C\") \
             FILTER (WHERE BTRIM(ext) <> ''), ARRAY[]::text[]) AS formats, \
         count(*) FILTER (WHERE NOT has_cover) AS missing_cover, \
         count(*) FILTER (WHERE NOT has_lyrics) AS missing_lyrics \
         FROM tracks WHERE {predicate}"
    ))
    .bind(&group.0)
    .bind(&group.1)
    .fetch_one(&mut **transaction)
    .await?)
}

pub async fn detail(
    pool: &PgPool,
    group: &Group,
    requested: i64,
    page_size: i64,
    expected_revision: Option<&str>,
) -> anyhow::Result<DetailResult> {
    let mut transaction = snapshot(pool).await?;
    let header = header(&mut transaction, group).await?;
    if header.total < 2 {
        return Ok(if expected_revision.is_some() {
            DetailResult::Changed
        } else {
            DetailResult::Missing
        });
    }
    if expected_revision.is_some_and(|expected| expected != header.revision) {
        return Ok(DetailResult::Changed);
    }
    let page_size = page_size.clamp(1, 100);
    let (page, pages, offset) = page_bounds(header.total, requested, page_size);
    let items = sqlx::query_as::<_, Track>(&format!(
        "SELECT {TRACK_COLUMNS} FROM tracks WHERE {} ORDER BY id ASC LIMIT $3 OFFSET $4",
        group_predicate()
    ))
    .bind(&group.0)
    .bind(&group.1)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(DetailResult::Ready(Detail {
        total: header.total,
        revision: header.revision,
        page,
        page_size,
        pages,
        summary: header.summary,
        items,
    }))
}

/// Validate one explicitly requested row in the same snapshot as the complete
/// comparison revision. This never writes a stored selection or returns all IDs.
pub async fn selection(
    pool: &PgPool,
    group: &Group,
    expected_revision: &str,
    track_id: i64,
) -> anyhow::Result<SelectionResult> {
    let mut transaction = snapshot(pool).await?;
    let header = header(&mut transaction, group).await?;
    if header.total < 2 || header.revision != expected_revision {
        return Ok(SelectionResult::Changed);
    }
    let track = sqlx::query_as::<_, Track>(&format!(
        "SELECT {TRACK_COLUMNS} FROM tracks WHERE {} AND id = $3",
        group_predicate()
    ))
    .bind(&group.0)
    .bind(&group.1)
    .bind(track_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(track) = track else {
        return Ok(SelectionResult::Changed);
    };
    transaction.commit().await?;
    Ok(SelectionResult::Ready {
        total: header.total,
        revision: header.revision,
        track,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagination_clamps_empty_negative_and_oversized_pages() {
        assert_eq!(page_bounds(0, 9, 20), (1, 0, 0));
        assert_eq!(page_bounds(41, -1, 20), (1, 3, 0));
        assert_eq!(page_bounds(41, 2, 20), (2, 3, 20));
        assert_eq!(page_bounds(41, i64::MAX, 20), (3, 3, 40));
        assert_eq!(page_bounds(40, 2, 20), (2, 2, 20));
        assert_eq!(
            page_bounds(i64::MAX, i64::MAX, 100),
            (
                92_233_720_368_547_759,
                92_233_720_368_547_759,
                9_223_372_036_854_775_800
            )
        );
    }

    #[test]
    fn search_treats_wildcards_and_escape_character_literally() {
        assert_eq!(search_pattern(" \tA!_%'\\艺\n"), "%A!!!_!%'\\艺%");
        assert_eq!(search_pattern("  "), "%%");
        assert_eq!(search_pattern("%_!"), "%!%!_!!%");
    }
}
