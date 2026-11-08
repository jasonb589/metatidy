//! Persistent track collections. Every operation is PostgreSQL-only; snapshots
//! come from the index and never require file, artwork or external service reads.

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::types::Json as DbJson;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::models::Track;
use crate::{repo, AppState};

use super::{light_track_json, ApiError, ApiResult, RawQuery};

const MAX_MEMBERS: usize = 20_000;
const MAX_SAFE_ID: i64 = 9_007_199_254_740_991;
const COLLECTION_COLUMNS: &str = "name, revision, create_fingerprint";
const SUMMARY_QUERY: &str = "SELECT c.id, c.name, c.revision, c.created_at, c.updated_at, \
    counts.track_count, counts.missing_count FROM track_collections c \
    CROSS JOIN LATERAL (SELECT count(*) AS track_count, \
    count(*) FILTER (WHERE t.id IS NULL) AS missing_count \
    FROM track_collection_members m LEFT JOIN tracks t ON t.id = m.track_id \
    WHERE m.collection_id = c.id) counts";

#[derive(sqlx::FromRow)]
struct Collection {
    name: String,
    revision: Uuid,
    create_fingerprint: String,
}

#[derive(sqlx::FromRow)]
struct Summary {
    id: Uuid,
    name: String,
    revision: Uuid,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    track_count: i64,
    missing_count: i64,
}

#[derive(sqlx::FromRow)]
struct Member {
    track_id: i64,
    position: i64,
    snapshot: DbJson<Value>,
}

#[derive(Debug)]
struct CreateRequest {
    id: Uuid,
    name: String,
    ids: Vec<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemberAction {
    Append,
    Remove,
}

/// Lists saved collections, not tracks. Counts and page contents share one
/// snapshot, including the index-missing counts used by the overview cards.
pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let q = parse_query(&query)?;
    let page_size = page_size(&query, 20, 100)?;
    let requested = query.i64("page", 1)?;
    let mut tx = read_transaction(&state.db).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM track_collections WHERE $1 = '' OR strpos(lower(name), lower($1)) > 0",
    )
    .bind(&q)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let (page, pages, offset) = page_bounds(total, requested, page_size);
    let summaries: Vec<Summary> = sqlx::query_as(&format!(
        "{SUMMARY_QUERY} WHERE $1 = '' OR strpos(lower(c.name), lower($1)) > 0 \
         ORDER BY c.updated_at DESC, c.id ASC LIMIT $2 OFFSET $3"
    ))
    .bind(&q)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<_> = summaries.iter().map(summary_json).collect();
    Ok(Json(json!({
        "total": total, "page": page, "page_size": page_size, "pages": pages, "items": items,
    })))
}

/// A client UUID identifies one create request. Its normalized original payload
/// remains immutable even when the collection is later renamed or edited.
pub async fn create(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request = parse_create(&super::parse_body(&body)?)?;
    let fingerprint = create_fingerprint(&request.name, &request.ids);
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;
    let inserted = sqlx::query(
        "INSERT INTO track_collections (id, name, revision, create_fingerprint) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    )
    .bind(request.id)
    .bind(&request.name)
    .bind(Uuid::new_v4())
    .bind(&fingerprint)
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?
    .rows_affected()
        == 1;

    if inserted {
        let snapshots = new_member_snapshots(&mut tx, &request.ids).await?;
        insert_members(&mut tx, request.id, 0, snapshots).await?;
    } else {
        // ON CONFLICT also waits for a concurrent creator. The lock serializes
        // a retry with rename/member/delete requests before returning a summary.
        let existing = lock_collection(&mut tx, request.id).await?;
        ensure_same_create(&existing.create_fingerprint, &fingerprint)?;
    }

    let collection = fetch_summary(&mut tx, request.id).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({"collection": summary_json(&collection)})))
}

pub async fn detail(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let id = parse_uuid(&json!(raw_id), "path", "id")?;
    let query = RawQuery(params);
    let page_size = page_size(&query, 100, 200)?;
    let requested = query.i64("page", 1)?;
    let expected = query
        .0
        .get("revision")
        .map(|value| parse_uuid(&json!(value), "query", "revision"))
        .transpose()?;
    let mut tx = read_transaction(&state.db).await?;
    let collection = fetch_summary(&mut tx, id).await?;
    if let Some(expected) = expected {
        ensure_revision(collection.revision, expected)?;
    }
    let (page, pages, offset) = page_bounds(collection.track_count, requested, page_size);
    let members: Vec<Member> = sqlx::query_as(
        "SELECT track_id, position, snapshot FROM track_collection_members \
         WHERE collection_id = $1 ORDER BY position LIMIT $2 OFFSET $3",
    )
    .bind(id)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let ids: Vec<_> = members.iter().map(|member| member.track_id).collect();
    let tracks = fetch_tracks(&mut tx, &ids, false).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<_> = members
        .iter()
        .map(|member| member_json(member, tracks.get(&member.track_id)))
        .collect();
    Ok(Json(json!({
        "collection": summary_json(&collection), "total": collection.track_count,
        "page": page, "page_size": page_size, "pages": pages, "items": items,
    })))
}

pub async fn rename(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    body: Bytes,
) -> ApiResult {
    let id = parse_uuid(&json!(raw_id), "path", "id")?;
    let payload = super::parse_body(&body)?;
    let revision = body_uuid(&payload, "revision")?;
    let name = parse_name(&payload)?;
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;
    let existing = lock_collection(&mut tx, id).await?;
    ensure_revision(existing.revision, revision)?;
    if existing.name != name {
        sqlx::query(
            "UPDATE track_collections SET name = $2, revision = $3, \
             updated_at = clock_timestamp() WHERE id = $1",
        )
        .bind(id)
        .bind(name)
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    let collection = fetch_summary(&mut tx, id).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({"collection": summary_json(&collection)})))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    body: Bytes,
) -> ApiResult {
    let id = parse_uuid(&json!(raw_id), "path", "id")?;
    let revision = body_uuid(&super::parse_body(&body)?, "revision")?;
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;
    let existing = lock_collection(&mut tx, id).await?;
    ensure_revision(existing.revision, revision)?;
    sqlx::query("DELETE FROM track_collections WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({"deleted": true, "id": id})))
}

pub async fn members(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    body: Bytes,
) -> ApiResult {
    let id = parse_uuid(&json!(raw_id), "path", "id")?;
    let payload = super::parse_body(&body)?;
    let revision = body_uuid(&payload, "revision")?;
    let action = parse_action(&payload)?;
    let ids = parse_ids(&payload)?;
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;
    let existing = lock_collection(&mut tx, id).await?;
    ensure_revision(existing.revision, revision)?;
    let current = member_ids(&mut tx, id).await?;
    let changed = changed_members(&current, &ids, action)?;
    let (mut added, mut removed) = (0, 0);
    if !changed.is_empty() {
        match action {
            MemberAction::Append => {
                let snapshots = new_member_snapshots(&mut tx, &changed).await?;
                insert_members(&mut tx, id, current.len() as i64, snapshots).await?;
                added = changed.len();
            }
            MemberAction::Remove => {
                sqlx::query(
                    "DELETE FROM track_collection_members WHERE collection_id = $1 AND track_id = ANY($2)",
                )
                .bind(id)
                .bind(&changed)
                .execute(&mut *tx)
                .await
                .map_err(anyhow::Error::from)?;
                sqlx::query(
                    "WITH ordered AS (SELECT track_id, row_number() OVER (ORDER BY position) AS position \
                     FROM track_collection_members WHERE collection_id = $1) \
                     UPDATE track_collection_members m SET position = o.position FROM ordered o \
                     WHERE m.collection_id = $1 AND m.track_id = o.track_id AND m.position <> o.position",
                )
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(anyhow::Error::from)?;
                removed = changed.len();
            }
        }
        sqlx::query(
            "UPDATE track_collections SET revision = $2, updated_at = clock_timestamp() WHERE id = $1",
        )
        .bind(id)
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    let collection = fetch_summary(&mut tx, id).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({
        "collection": summary_json(&collection), "added": added, "removed": removed,
    })))
}

/// Returns the complete ordered IDs, including missing index rows. Clients can
/// resolve them in bounded pages and explicitly adopt the resulting selection.
pub async fn selection(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    body: Bytes,
) -> ApiResult {
    let id = parse_uuid(&json!(raw_id), "path", "id")?;
    let revision = body_uuid(&super::parse_body(&body)?, "revision")?;
    let mut tx = read_transaction(&state.db).await?;
    let collection = fetch_summary(&mut tx, id).await?;
    ensure_revision(collection.revision, revision)?;
    let ids = member_ids(&mut tx, id).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(
        json!({"collection": summary_json(&collection), "ids": ids}),
    ))
}

async fn read_transaction(pool: &PgPool) -> ApiResult<Transaction<'_, Postgres>> {
    let mut tx = pool.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(tx)
}

async fn lock_collection(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<Collection> {
    sqlx::query_as(&format!(
        "SELECT {COLLECTION_COLUMNS} FROM track_collections WHERE id = $1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?
    .ok_or_else(|| ApiError::not_found("曲目清单已不存在，请刷新清单列表"))
}

async fn fetch_summary(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<Summary> {
    sqlx::query_as(&format!("{SUMMARY_QUERY} WHERE c.id = $1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(anyhow::Error::from)?
        .ok_or_else(|| ApiError::not_found("曲目清单已不存在，请刷新清单列表"))
}

async fn member_ids(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<Vec<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT track_id FROM track_collection_members WHERE collection_id = $1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?)
}

async fn fetch_tracks(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[i64],
    lock: bool,
) -> ApiResult<HashMap<i64, Track>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    // New members retain a key lock until commit, so a concurrent index prune
    // cannot turn a validated append into a partly missing insertion.
    let suffix = if lock { " FOR KEY SHARE" } else { "" };
    let rows: Vec<Track> = sqlx::query_as(&format!(
        "SELECT {} FROM tracks WHERE id = ANY($1) ORDER BY id{suffix}",
        repo::TRACK_COLUMNS
    ))
    .bind(ids)
    .fetch_all(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    Ok(rows.into_iter().map(|track| (track.id, track)).collect())
}

async fn new_member_snapshots(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[i64],
) -> ApiResult<Vec<Value>> {
    let tracks = fetch_tracks(tx, ids, true).await?;
    if tracks.len() != ids.len() {
        return Err(ApiError::conflict(format!(
            "有 {} 首待加入曲目已不在索引中，本次清单未修改，请重新核对选择",
            ids.len() - tracks.len()
        )));
    }
    Ok(ids.iter().map(|id| light_track_json(&tracks[id])).collect())
}

async fn insert_members(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    offset: i64,
    snapshots: Vec<Value>,
) -> ApiResult<()> {
    if !snapshots.is_empty() {
        sqlx::query(
            "INSERT INTO track_collection_members (collection_id, track_id, position, snapshot) \
             SELECT $1, (entry.snapshot->>'id')::bigint, $2 + entry.position, entry.snapshot \
             FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS entry(snapshot, position)",
        )
        .bind(id)
        .bind(offset)
        .bind(DbJson(Value::Array(snapshots)))
        .execute(&mut **tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    Ok(())
}

fn summary_json(summary: &Summary) -> Value {
    json!({
        "id": summary.id, "name": summary.name, "revision": summary.revision,
        "track_count": summary.track_count, "missing_count": summary.missing_count,
        "created_at": super::ts(Some(summary.created_at)),
        "updated_at": super::ts(Some(summary.updated_at)),
    })
}

fn member_json(member: &Member, track: Option<&Track>) -> Value {
    json!({
        "id": member.track_id, "position": member.position,
        "status": if track.is_some() { "found" } else { "missing" },
        "track": track.map(light_track_json), "snapshot": member.snapshot.0,
    })
}

fn required<'a>(payload: &'a Map<String, Value>, key: &str) -> ApiResult<&'a Value> {
    payload.get(key).ok_or_else(|| {
        ApiError::unprocessable(
            "missing",
            vec!["body", key],
            "Field required",
            Value::Null,
            None,
        )
    })
}

fn parse_uuid(value: &Value, source: &str, key: &str) -> ApiResult<Uuid> {
    value
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| {
            ApiError::unprocessable(
                "value_error",
                vec![source, key],
                "请提供有效的 UUID 标识",
                value.clone(),
                None,
            )
        })
}

fn body_uuid(payload: &Map<String, Value>, key: &str) -> ApiResult<Uuid> {
    parse_uuid(required(payload, key)?, "body", key)
}

fn parse_name(payload: &Map<String, Value>) -> ApiResult<String> {
    let value = required(payload, "name")?;
    value
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.contains('\0') && name.chars().count() <= 120)
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "value_error",
                vec!["body", "name"],
                "清单名称须为 1–120 个字，不能包含空字符",
                value.clone(),
                None,
            )
        })
}

fn parse_ids(payload: &Map<String, Value>) -> ApiResult<Vec<i64>> {
    let value = required(payload, "ids")?;
    let items = value.as_array().ok_or_else(|| {
        ApiError::unprocessable(
            "list_type",
            vec!["body", "ids"],
            "曲目编号须为数组",
            value.clone(),
            None,
        )
    })?;
    // Apply the input bound before deduplication: repeated IDs cannot bypass the
    // request budget. The collection's resulting size has its own atomic check.
    if items.len() > MAX_MEMBERS {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["body", "ids"],
            "一次最多提交 20000 个曲目编号，请减少选择后重试",
            json!(items.len()),
            Some(json!({"max_length": MAX_MEMBERS})),
        ));
    }
    let mut seen = HashSet::with_capacity(items.len());
    let mut ids = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let id = item
            .as_i64()
            .filter(|id| (1..=MAX_SAFE_ID).contains(id))
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "value_error",
                    vec!["body", "ids", &index.to_string()],
                    "曲目编号须为 1–9007199254740991 的整数",
                    item.clone(),
                    None,
                )
            })?;
        if seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn parse_create(payload: &Map<String, Value>) -> ApiResult<CreateRequest> {
    Ok(CreateRequest {
        id: body_uuid(payload, "id")?,
        name: parse_name(payload)?,
        ids: parse_ids(payload)?,
    })
}

fn parse_action(payload: &Map<String, Value>) -> ApiResult<MemberAction> {
    let value = required(payload, "action")?;
    match value.as_str() {
        Some("append") => Ok(MemberAction::Append),
        Some("remove") => Ok(MemberAction::Remove),
        _ => Err(ApiError::unprocessable(
            "value_error",
            vec!["body", "action"],
            "清单成员操作须为 append 或 remove",
            value.clone(),
            None,
        )),
    }
}

fn parse_query(query: &RawQuery) -> ApiResult<String> {
    let raw = query.str("q", "");
    let q = raw.trim();
    if q.contains('\0') || q.chars().count() > 500 {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "q"],
            "清单搜索最多 500 个字，不能包含空字符",
            json!(raw),
            None,
        ));
    }
    Ok(q.to_string())
}

fn page_size(query: &RawQuery, default: i64, max: i64) -> ApiResult<i64> {
    let size = query.i64("page_size", default)?;
    if !(1..=max).contains(&size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            &format!("每页数量须为 1–{max}"),
            json!(size),
            Some(json!({"ge": 1, "le": max})),
        ));
    }
    Ok(size)
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

fn create_fingerprint(name: &str, ids: &[i64]) -> String {
    let canonical = json!({"name": name, "ids": ids}).to_string();
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn ensure_same_create(stored: &str, incoming: &str) -> ApiResult<()> {
    if stored != incoming {
        return Err(ApiError::conflict(
            "这个清单编号已用于不同的创建请求，请刷新清单后重试",
        ));
    }
    Ok(())
}

fn ensure_revision(current: Uuid, expected: Uuid) -> ApiResult<()> {
    if current != expected {
        return Err(ApiError::conflict("曲目清单已变化，请刷新详情后重新确认"));
    }
    Ok(())
}

fn changed_members(
    current: &[i64],
    requested: &[i64],
    action: MemberAction,
) -> ApiResult<Vec<i64>> {
    let existing: HashSet<_> = current.iter().copied().collect();
    let changed: Vec<_> = requested
        .iter()
        .copied()
        .filter(|id| existing.contains(id) == (action == MemberAction::Remove))
        .collect();
    if action == MemberAction::Append && current.len() + changed.len() > MAX_MEMBERS {
        return Err(ApiError::conflict(
            "每份清单最多保存 20000 首，本次追加会超过上限，清单未修改",
        ));
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    fn object(value: &Value) -> &Map<String, Value> {
        value.as_object().unwrap()
    }

    #[test]
    fn ids_are_required_safe_positive_integers_and_deduplicate_in_order() {
        assert_eq!(
            parse_ids(object(&json!({"ids": [9, 3, 9, MAX_SAFE_ID, 3]}))).unwrap(),
            vec![9, 3, MAX_SAFE_ID]
        );
        assert!(parse_ids(object(&json!({"ids": []}))).unwrap().is_empty());
        for invalid in [
            json!({}),
            json!({"ids": null}),
            json!({"ids": "1"}),
            json!({"ids": ["1"]}),
            json!({"ids": [true]}),
            json!({"ids": [0]}),
            json!({"ids": [-1]}),
            json!({"ids": [1.0]}),
            json!({"ids": [1.5]}),
            json!({"ids": [MAX_SAFE_ID + 1]}),
        ] {
            assert!(
                matches!(parse_ids(object(&invalid)), Err(ApiError::Unprocessable(_))),
                "{invalid}"
            );
        }
    }

    #[test]
    fn raw_id_budget_is_enforced_before_deduplication() {
        let exact = json!({"ids": vec![1; MAX_MEMBERS]});
        assert_eq!(parse_ids(object(&exact)).unwrap(), vec![1]);
        let over = json!({"ids": vec![1; MAX_MEMBERS + 1]});
        assert!(matches!(
            parse_ids(object(&over)),
            Err(ApiError::Unprocessable(_))
        ));
    }

    #[test]
    fn names_use_trimmed_unicode_characters_and_reject_nul() {
        assert_eq!(
            parse_name(object(
                &json!({"name": format!(" \u{3000}{}\n", "歌".repeat(120))})
            ))
            .unwrap(),
            "歌".repeat(120)
        );
        assert_eq!(
            parse_name(object(&json!({"name": "A / B \"mix\""}))).unwrap(),
            "A / B \"mix\""
        );
        for invalid in [
            json!({}),
            json!({"name": 1}),
            json!({"name": null}),
            json!({"name": " \u{3000}\n"}),
            json!({"name": "A\0B"}),
            json!({"name": "歌".repeat(121)}),
        ] {
            assert!(parse_name(object(&invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn create_fingerprint_covers_normalized_original_payload_and_order() {
        let id = Uuid::new_v4();
        let first = parse_create(object(
            &json!({"id": id, "name": " 原清单 ", "ids": [9, 3, 9]}),
        ))
        .unwrap();
        let retry =
            parse_create(object(&json!({"id": id, "name": "原清单", "ids": [9, 3]}))).unwrap();
        assert_eq!(first.id, id);
        let fingerprint = create_fingerprint(&first.name, &first.ids);
        assert_eq!(fingerprint.len(), 64);
        ensure_same_create(&fingerprint, &create_fingerprint(&retry.name, &retry.ids)).unwrap();
        for different in [
            create_fingerprint("改名", &first.ids),
            create_fingerprint(&first.name, &[3, 9]),
            create_fingerprint(&first.name, &[9]),
        ] {
            assert!(matches!(
                ensure_same_create(&fingerprint, &different),
                Err(ApiError::Status(StatusCode::CONFLICT, _))
            ));
        }
    }

    #[test]
    fn uuid_and_revision_validation_rejects_missing_malformed_and_stale() {
        let id = Uuid::new_v4();
        assert_eq!(
            parse_uuid(&json!(id.to_string().to_uppercase()), "body", "revision").unwrap(),
            id
        );
        for invalid in [
            json!({}),
            json!({"revision": null}),
            json!({"revision": 1}),
            json!({"revision": ""}),
            json!({"revision": "123"}),
        ] {
            assert!(matches!(
                body_uuid(object(&invalid), "revision"),
                Err(ApiError::Unprocessable(_))
            ));
        }
        ensure_revision(id, id).unwrap();
        assert!(matches!(
            ensure_revision(id, Uuid::new_v4()),
            Err(ApiError::Status(StatusCode::CONFLICT, _))
        ));
    }

    #[test]
    fn append_preserves_request_order_and_rejects_resulting_overflow() {
        assert_eq!(
            changed_members(&[9, 2], &[2, 5, 1, 9], MemberAction::Append).unwrap(),
            vec![5, 1]
        );
        assert!(changed_members(&[9, 2], &[2, 9], MemberAction::Append)
            .unwrap()
            .is_empty());
        let almost: Vec<_> = (1..MAX_MEMBERS as i64).collect();
        assert_eq!(
            changed_members(&almost, &[MAX_MEMBERS as i64, 1], MemberAction::Append).unwrap(),
            vec![MAX_MEMBERS as i64]
        );
        assert!(matches!(
            changed_members(
                &almost,
                &[MAX_MEMBERS as i64, MAX_MEMBERS as i64 + 1],
                MemberAction::Append
            ),
            Err(ApiError::Status(StatusCode::CONFLICT, _))
        ));
    }

    #[test]
    fn removal_only_changes_existing_members_and_action_is_explicit() {
        assert_eq!(
            changed_members(&[9, 2, 1], &[2, 7, 1], MemberAction::Remove).unwrap(),
            vec![2, 1]
        );
        assert!(changed_members(&[9, 2], &[7], MemberAction::Remove)
            .unwrap()
            .is_empty());
        assert_eq!(
            parse_action(object(&json!({"action": "append"}))).unwrap(),
            MemberAction::Append
        );
        assert_eq!(
            parse_action(object(&json!({"action": "remove"}))).unwrap(),
            MemberAction::Remove
        );
        for invalid in [
            json!({}),
            json!({"action": "replace"}),
            json!({"action": null}),
        ] {
            assert!(parse_action(object(&invalid)).is_err());
        }
    }

    #[test]
    fn pages_are_bounded_even_with_empty_or_extreme_requests() {
        assert_eq!(page_bounds(0, i64::MAX, 100), (1, 0, 0));
        assert_eq!(page_bounds(201, -1, 100), (1, 3, 0));
        assert_eq!(page_bounds(201, i64::MAX, 100), (3, 3, 200));
        assert_eq!(
            page_bounds(i64::MAX, i64::MAX, 200),
            (
                (i64::MAX - 1) / 200 + 1,
                (i64::MAX - 1) / 200 + 1,
                ((i64::MAX - 1) / 200) * 200
            )
        );
        assert_eq!(page_size(&RawQuery(HashMap::new()), 100, 200).unwrap(), 100);
        for invalid in ["0", "201", "x"] {
            assert!(page_size(
                &RawQuery(HashMap::from([("page_size".into(), invalid.into())])),
                100,
                200
            )
            .is_err());
        }
    }

    #[test]
    fn query_is_literal_bounded_unicode_text() {
        assert_eq!(
            parse_query(&RawQuery(HashMap::from([(
                "q".into(),
                "  100%_音乐  ".into()
            )])))
            .unwrap(),
            "100%_音乐"
        );
        assert_eq!(
            parse_query(&RawQuery(HashMap::from([("q".into(), "歌".repeat(500))]))).unwrap(),
            "歌".repeat(500)
        );
        for invalid in ["歌".repeat(501), "a\0b".into()] {
            assert!(parse_query(&RawQuery(HashMap::from([("q".into(), invalid)]))).is_err());
        }
    }

    #[test]
    fn member_snapshot_survives_missing_index_and_current_metadata_changes() {
        let original = Track {
            id: 7,
            title: "原名".into(),
            path: "/nonexistent/old.flac".into(),
            tags_loaded: false,
            ..Track::default()
        };
        let snapshot = light_track_json(&original);
        let member = Member {
            track_id: 7,
            position: 2,
            snapshot: DbJson(snapshot.clone()),
        };
        let missing = member_json(&member, None);
        assert_eq!(missing["status"], "missing");
        assert!(missing["track"].is_null());
        assert_eq!(missing["snapshot"], snapshot);
        let current = Track {
            title: "新名".into(),
            path: "/nonexistent/new.flac".into(),
            ..original
        };
        let found = member_json(&member, Some(&current));
        assert_eq!(found["track"]["title"], "新名");
        assert_eq!(found["snapshot"]["title"], "原名");
        assert_eq!(found["position"], 2);
        assert_eq!(found["status"], "found");
        assert!(found["track"].get("file_exists").is_none());
    }
}
