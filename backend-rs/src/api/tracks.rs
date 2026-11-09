//! 曲目索引与元数据编辑：`/api/tracks*`、`/api/aliases/{kind}`。
//!
//! 三条写路径里的前两条在这里：
//! - `/api/tracks/preview`：只读文件算差异（`tagio::preview_update`），绝不落盘
//! - `/api/tracks/apply`：真写标签 + 同步索引（写失败进 `failed[]`，不中断整批）

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::models::Track;
use crate::repo::{self, TrackQuery};
use crate::tagio;
use crate::AppState;

use super::{
    alias_table, apply_aliases, bad_kind, body_field_map, body_ids, changes_json, fields_json,
    full_track_json, light_track_json, path_i64, prepare_fields, raw_tags_json, unique_ids, ApiError,
    ApiResult, RawQuery, PREVIEW_DISPLAY_LIMIT,
};

/// `/api/tracks`：只查索引的分页列表。
pub async fn list_tracks(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    // page_size 是**强校验**：越界报 422（数组形态），与 FastAPI 的 Query(ge=1, le=1000) 一致
    let page_size = query.i64("page_size", 100)?;
    if page_size < 1 {
        return Err(ApiError::unprocessable(
            "greater_than_equal",
            vec!["query", "page_size"],
            "Input should be greater than or equal to 1",
            Value::String(page_size.to_string()),
            Some(json!({ "ge": 1 })),
        ));
    }
    if page_size > 1000 {
        return Err(ApiError::unprocessable(
            "less_than_equal",
            vec!["query", "page_size"],
            "Input should be less than or equal to 1000",
            Value::String(page_size.to_string()),
            Some(json!({ "le": 1000 })),
        ));
    }

    let mut track_query = parse_track_query(&state.config.music_dir, &query)?;
    track_query.page = query.i64("page", 1)?;
    track_query.page_size = page_size;

    let page = repo::list_tracks(&state.db, &track_query).await?;
    let items: Vec<Value> = page.items.iter().map(light_track_json).collect();
    Ok(Json(json!({
        "total": page.total,
        "page": page.page,
        "page_size": page.page_size,
        "pages": page.pages,
        "items": items,
    })))
}

/// Shared semantic scope parser for both list browsing and a whole-filter
/// selection. The JSON endpoint validates wire types before calling this parser.
pub(super) fn parse_track_query(root: &std::path::Path, query: &RawQuery) -> ApiResult<TrackQuery> {
    let sort = query.str("sort", "artist");
    let sort = match sort.as_str() {
        "artist" | "title" | "album" | "year" | "path" | "track" | "indexed" | "edited"
        | "disc_track" => sort,
        _ => "artist".to_owned(),
    };
    Ok(TrackQuery {
        q: query.str("q", "").trim().to_owned(),
        page: 1,
        page_size: 100,
        sort,
        order_desc: query.str("order", "asc").trim().eq_ignore_ascii_case("desc"),
        language: query.str("language", "").trim().to_owned(),
        albumtype: query.str("albumtype", "").trim().to_owned(),
        genre: query.str("genre", "").trim().to_owned(),
        year: query.str("year", "").trim().to_owned(),
        artist: query.str("artist", "").trim().to_owned(),
        artist_group: super::library_artists::parse_artist_group(query.0.get("artist_group"), false)?,
        album: query.str("album", "").trim().to_owned(),
        album_group: super::albums::parse_album_group(query.0.get("album_group"))?,
        folder: super::folders::track_scope(root, query)?,
        missing_cover: query.bool("missing_cover", false)?,
        missing_lyrics: query.bool("missing_lyrics", false)?,
        no_artist: query.bool("no_artist", false)?,
        no_album: query.bool("no_album", false)?,
        not_loaded: query.bool("not_loaded", false)?,
        ids: Vec::new(),
    })
}

/// Resolve an explicit selection against PostgreSQL only. Missing index rows
/// remain visible in their original position; this never stats an audio path.
pub async fn selection(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let ids = unique_ids(body_ids(&payload, "ids")?);
    let (page, page_size, pages, range) = selection_page(&payload, ids.len())?;
    let total = ids.len() as i64;
    let page_ids = &ids[range];

    let mut transaction = state.db.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(anyhow::Error::from)?;
    let found_total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tracks WHERE id = ANY($1) AND id > 0")
            .bind(&ids)
            .fetch_one(&mut *transaction)
            .await
            .map_err(anyhow::Error::from)?;
    let tracks: Vec<Track> = sqlx::query_as(&format!(
        "SELECT {} FROM tracks WHERE id = ANY($1) AND id > 0",
        repo::TRACK_COLUMNS,
    ))
    .bind(page_ids)
    .fetch_all(&mut *transaction)
    .await
    .map_err(anyhow::Error::from)?;
    transaction.commit().await.map_err(anyhow::Error::from)?;
    let tracks: HashMap<_, _> = tracks.into_iter().map(|track| (track.id, track)).collect();
    let items = selection_items(page_ids, &tracks);
    Ok(Json(json!({
        "total": total, "selected_total": total, "found_total": found_total,
        "missing_total": total - found_total, "page": page, "page_size": page_size,
        "pages": pages, "items": items,
    })))
}

fn selection_page(
    payload: &serde_json::Map<String, Value>,
    total: usize,
) -> Result<(i64, i64, i64, std::ops::Range<usize>), ApiError> {
    let page_size = super::body_i64(payload, "page_size", 100)?;
    if !(1..=200).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["body", "page_size"],
            "每页已选曲目数须为 1–200",
            json!(page_size),
            Some(json!({"ge": 1, "le": 200})),
        ));
    }
    let requested = super::body_i64(payload, "page", 1)?;
    let total = total as i64;
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / page_size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    let start = ((page - 1) * page_size) as usize;
    let end = start.saturating_add(page_size as usize).min(total as usize);
    Ok((page, page_size, pages, start..end))
}

fn selection_items(ids: &[i64], tracks: &HashMap<i64, Track>) -> Vec<Value> {
    ids.iter()
        .map(|id| match tracks.get(id) {
            Some(track) => json!({"id": id, "status": "found", "track": light_track_json(track)}),
            None => json!({"id": id, "status": "missing", "track": Value::Null}),
        })
        .collect()
}

/// `/api/tracks/{track_id}`：整行 + `file_exists`。
pub async fn detail(State(state): State<AppState>, Path(raw_id): Path<String>) -> ApiResult {
    let track_id = path_i64(&raw_id, "track_id")?;
    let track = repo::get_track(&state.db, track_id).await?;
    match track {
        Some(track) => Ok(Json(full_track_json(&track))),
        None => Err(ApiError::not_found("没有这条曲目")),
    }
}

/// `/api/tracks/{track_id}/cover`：内嵌封面 / 缩略图（二进制）。
///
/// `size=0` 保留内嵌原图；1..=512 按 128 / 256 / 512 档生成真正的 AVIF 缩略图。
/// 缓存随索引版本失效，磁盘读取与图像编码在受限的阻塞线程中完成。
pub async fn cover(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let track_id = path_i64(&raw_id, "track_id")?;
    let size = RawQuery(params).i64("size", 0)?;
    let edge = crate::cover_cache::thumbnail_edge(size).ok_or_else(|| {
        ApiError::unprocessable(
            "value_error",
            vec!["query", "size"],
            "封面尺寸须为 0（原图）或 1–512（缩略图）",
            json!(size),
            None,
        )
    })?;
    let track = match repo::get_track(&state.db, track_id).await? {
        Some(track) => track,
        None => return Err(ApiError::not_found("没有这条曲目")),
    };

    let Some(image) = crate::cover_cache::load(state.config.clone(), track, edge).await? else {
        return Err(ApiError::not_found("这首歌没有内嵌封面"));
    };
    Ok(image_response(image.bytes, &image.mime))
}

fn image_response(bytes: Vec<u8>, mime: &str) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        bytes,
    )
        .into_response()
}

/// Normalize supported values while retaining unsupported keys for diagnostics.
pub(super) fn prepare_update_fields(
    fields: &HashMap<String, String>,
    normalize_artist: bool,
) -> HashMap<String, String> {
    let mut prepared = prepare_fields(fields, normalize_artist);
    // Preserve unsupported keys for an explicit skipped reason. The writer is
    // still the authority on the editable-field allowlist.
    for (key, value) in fields {
        if key != "lyrics" {
            prepared.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    prepared
}

/// `POST /api/tracks/preview`：差异预览（只读文件）。
pub async fn preview(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let ids = unique_ids(body_ids(&payload, "ids")?);
    if ids.is_empty() {
        return Err(ApiError::bad_request("至少选择一首"));
    }
    let normalize_artist = super::body_bool(&payload, "normalize_artist", true)?;
    let overwrite = super::body_bool(&payload, "overwrite", true)?;
    let raw_fields = body_field_map(&payload, "fields")?;
    let mut fields = prepare_update_fields(&raw_fields, normalize_artist);
    // 歌词走独立通道：它不是普通文本字段（不在 EDITABLE_FIELDS 里），填了才写、留空 = 不动
    let lyrics = raw_fields.get("lyrics").map(|text| text.trim().to_string());
    if fields.is_empty() && lyrics.is_none() {
        return Err(ApiError::bad_request("没有可编辑的字段"));
    }
    let artist_alias = repo::aliases(&state.db, "artist").await?;
    let album_alias = repo::aliases(&state.db, "album").await?;
    fields = apply_aliases(&fields, &artist_alias, &album_alias);

    let truncated = ids.len() > PREVIEW_DISPLAY_LIMIT;
    let indexed = indexed_ids(&state, &ids).await?;
    let index_missing_ids: Vec<_> = ids.iter().copied().filter(|id| !indexed.contains(id)).collect();
    let selected: Vec<i64> = ids.iter().take(PREVIEW_DISPLAY_LIMIT).copied().collect();
    let tracks = fetch_by_ids(&state, &selected).await?;

    let mut items: Vec<Value> = Vec::new();
    let mut changed_total = 0usize;
    for track_id in &selected {
        let Some(track) = tracks.get(track_id) else {
            items.push(json!({"track_id": track_id, "path": "", "filename": "",
                "changes": {}, "effective_fields": {}, "skipped": [], "count": 0,
                "current": {"error": "索引里没有这条曲目"}, "file_exists": false}));
            continue;
        };
        let path = std::path::Path::new(&track.path);
        match tagio::preview_update(path, &fields, overwrite, lyrics.as_deref()) {
            Ok(mut plan) => {
                if let Some(change) = plan.changes.get_mut("lyrics") {
                    change.old = lyrics_summary(&change.old);
                    change.new = lyrics_summary(&change.new);
                }
                let mut effective = fields_json(&plan.effective_fields);
                if let Some(text) = &plan.lyrics {
                    effective["lyrics"] = json!(lyrics_summary(text));
                }
                changed_total += plan.changes.len();
                items.push(json!({
                    "path": track.path, "changes": changes_json(&plan.changes),
                    "effective_fields": effective, "skipped": plan.skipped,
                    "count": plan.changes.len(), "current": raw_tags_json(&plan.current),
                    "track_id": track.id, "filename": track.filename, "file_exists": true,
                }));
            }
            Err(err) => items.push(json!({
                "path": track.path, "changes": {}, "effective_fields": {}, "skipped": [],
                "count": 0, "current": {"error": err.message}, "track_id": track.id,
                "filename": track.filename, "file_exists": path.exists(),
            })),
        }
    }

    // 回显里也带上歌词：否则界面上那句「将写入字段：」在只改歌词时是空的
    let mut echoed = fields_json(&fields);
    if let Some(text) = &lyrics {
        if let Some(obj) = echoed.as_object_mut() {
            obj.insert("lyrics".to_string(), Value::String(lyrics_summary(text)));
        }
    }
    Ok(Json(json!({
        "fields": echoed,
        "items": items,
        "changed_fields": changed_total,
        "truncated": truncated,
        "selected_total": ids.len(),
        "previewed_total": selected.len(),
        "index_missing_total": index_missing_ids.len(),
        "index_missing_ids": index_missing_ids,
    })))
}

/// `POST /api/tracks/apply`：真写标签 + 同步索引。
pub async fn apply(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let ids = unique_ids(body_ids(&payload, "ids")?);
    if ids.is_empty() {
        return Err(ApiError::bad_request("至少选择一首"));
    }
    let normalize_artist = super::body_bool(&payload, "normalize_artist", true)?;
    let overwrite = super::body_bool(&payload, "overwrite", true)?;
    let raw_fields = body_field_map(&payload, "fields")?;
    let mut fields = prepare_update_fields(&raw_fields, normalize_artist);
    // 歌词走独立通道：它不是普通文本字段（不在 EDITABLE_FIELDS 里），填了才写、留空 = 不动
    let lyrics = raw_fields.get("lyrics").map(|text| text.trim().to_string());
    if fields.is_empty() && lyrics.is_none() {
        return Err(ApiError::bad_request("没有可编辑的字段"));
    }
    let artist_alias = repo::aliases(&state.db, "artist").await?;
    let album_alias = repo::aliases(&state.db, "album").await?;
    fields = apply_aliases(&fields, &artist_alias, &album_alias);

    let mut written = 0i64;
    let mut skipped = 0i64;
    let mut failed: Vec<Value> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    let mut applied_fields = BTreeSet::new();
    // Keep path lookup, tag writes and index synchronization serialized with
    // scanning, moving and other writers, including reviewed filename plans.
    let _library_guard = crate::scanner::lock_library_scan().await;
    for track_id in &ids {
        let track = match selection_lookup(*track_id, repo::get_track(&state.db, *track_id).await) {
            Ok(track) => track,
            Err(detail) => {
                failed.push(detail);
                continue;
            }
        };
        let path = std::path::Path::new(&track.path);
        match tagio::apply_update(path, &fields, overwrite, None, lyrics.as_deref()) {
            Ok(outcome) => {
                if let Err(err) = sync_update_outcome(&state, &track, &outcome, false).await {
                    failed.push(json!({"track_id": track_id, "path": track.path,
                        "error": err.to_string(), "stage": "index", "file_changed": outcome.file_changed}));
                    continue;
                }
                let mut fields = outcome.written.clone();
                if outcome.lyrics_written {
                    fields.push("lyrics".to_string());
                }
                fields.sort();
                applied_fields.extend(fields.iter().cloned());
                if outcome.file_changed {
                    written += 1;
                } else {
                    skipped += 1;
                }
                items.push(json!({"track_id": track_id, "written": fields,
                    "skipped": outcome.skipped, "file_changed": outcome.file_changed,
                    "cover": outcome.cover_written, "lyrics": outcome.lyrics_written}));
            }
            Err(err) => failed.push(json!({
                "track_id": track_id,
                "path": track.path,
                "error": format!("TagError: {err}"),
                "stage": err.stage,
                "file_changed": err.file_changed,
            })),
        }
    }

    Ok(Json(
        json!({ "written": written, "skipped": skipped, "failed": failed,
        "fields": applied_fields, "items": items }),
    ))
}

pub(super) async fn sync_update_outcome(
    state: &AppState,
    track: &Track,
    outcome: &tagio::UpdateOutcome,
    scraped: bool,
) -> anyhow::Result<()> {
    // A no-op may have seen external edits to unrequested fields. Preserve the
    // old mtime/size so the next incremental scan still detects those changes.
    let (mtime, size) = if outcome.file_changed {
        let meta = fs::metadata(&track.path)
            .map_err(|err| anyhow::anyhow!("标签已保存，但读取文件状态失败；请重新扫描：{err}",))?;
        let modified = meta
            .modified()
            .and_then(|modified| {
                modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            })
            .map_err(|err| anyhow::anyhow!("标签已保存，但读取修改时间失败；请重新扫描：{err}",))?;
        (Some(modified.as_secs_f64()), Some(meta.len() as i64))
    } else {
        (None, None)
    };
    repo::sync_after_write(
        &state.db,
        track.id,
        &outcome.readback_fields,
        mtime,
        size,
        scraped && outcome.file_changed,
        Some(outcome.has_cover),
        Some(outcome.has_lyrics),
        !scraped && outcome.file_changed,
    )
    .await
    .map_err(|err| {
        anyhow::anyhow!(
            "标签处理后同步索引失败（文件是否已改变：{}）；请重新扫描：{err}",
            outcome.file_changed,
        )
    })
}

/// `GET /api/tracks/{track_id}/lyrics`：读文件里现有的歌词（编辑面板打开时载入用）。
pub async fn lyrics(State(state): State<AppState>, Path(raw_id): Path<String>) -> ApiResult {
    let track_id = path_i64(&raw_id, "track_id")?;
    let Some(track) = repo::get_track(&state.db, track_id).await? else {
        return Err(ApiError::not_found("没有这条曲目"));
    };
    let path = std::path::Path::new(&track.path);
    let text = tagio::read_lyrics(path);
    Ok(Json(json!({
        "track_id": track.id,
        "path": track.path,
        "lyrics": text,
        "lines": text.lines().filter(|line| !line.trim().is_empty()).count(),
        "chars": text.chars().count(),
        "has_lyrics": !text.trim().is_empty(),
        "file_exists": path.exists(),
    })))
}

/// 歌词差异的紧凑表示：整篇歌词塞进差异表没法看，只给「行数 + 首行」。
pub(super) fn lyrics_summary(text: &str) -> String {
    if text.trim().is_empty() {
        return "（无歌词）".to_string();
    }
    let lines = text.lines().filter(|line| !line.trim().is_empty()).count();
    let head: String = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(32)
        .collect();
    format!("{lines} 行 · 首行 {head}")
}

/// `/api/aliases/{kind}`（读）。
pub async fn get_aliases(State(state): State<AppState>, Path(kind): Path<String>) -> ApiResult {
    let Some(table) = alias_table(&kind) else {
        return Err(bad_kind());
    };
    let rows = repo::aliases_ordered(&state.db, table).await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(from, to)| json!({ "from": from, "to": to }))
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `PUT /api/aliases/{kind}`（全量替换；空 body 会清空整表 —— 与 Python 语义一致）。
pub async fn put_aliases(
    State(state): State<AppState>,
    Path(kind): Path<String>,
    body: Bytes,
) -> ApiResult {
    let Some(table) = alias_table(&kind) else {
        return Err(bad_kind());
    };
    let payload = super::parse_body(&body)?;
    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut mapping: HashMap<String, String> = HashMap::new();
    for item in items {
        let Some(entry) = item.as_object() else {
            continue; // 非 dict 元素丢弃
        };
        let from = entry
            .get("from")
            .map(super::v_text)
            .unwrap_or_default()
            .trim()
            .to_string();
        let to = entry
            .get("to")
            .map(super::v_text)
            .unwrap_or_default()
            .trim()
            .to_string();
        if from.is_empty() || to.is_empty() {
            continue;
        }
        mapping.insert(from, to);
    }
    let saved = repo::replace_aliases(&state.db, table, &mapping).await?;
    Ok(Json(json!({ "saved": saved })))
}

/// Keep lookup failures in the per-item result after earlier files may have
/// changed, instead of turning a partly completed batch into a bare HTTP 500.
pub(super) fn selection_lookup(
    track_id: i64,
    outcome: anyhow::Result<Option<Track>>,
) -> Result<Track, Value> {
    match outcome {
        Ok(Some(track)) if track_id > 0 => Ok(track),
        lookup => {
            let message = match lookup {
                Err(error) => format!("读取曲目索引失败：{error}"),
                _ => "索引里没有这条曲目".to_string(),
            };
            Err(
                json!({"track_id": track_id, "status": "失败", "stage": "lookup",
                "error": message, "file_changed": false}),
            )
        }
    }
}

/// Check the complete selection without loading tags or statting audio paths.
async fn indexed_ids(state: &AppState, ids: &[i64]) -> Result<HashSet<i64>, ApiError> {
    let found: Vec<i64> = sqlx::query_scalar("SELECT id FROM tracks WHERE id = ANY($1) AND id > 0")
        .bind(ids)
        .fetch_all(&state.db)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(found.into_iter().collect())
}

/// The track list caps at 1000 rows. Chunk internally so every caller can
/// resolve a complete explicit selection without silent first-page truncation.
pub async fn fetch_by_ids(state: &AppState, ids: &[i64]) -> Result<HashMap<i64, Track>, ApiError> {
    let mut tracks = HashMap::new();
    for chunk in ids.chunks(1000) {
        let query = TrackQuery {
            ids: chunk.to_vec(),
            page_size: chunk.len() as i64,
            ..Default::default()
        };
        let page = repo::list_tracks(&state.db, &query).await?;
        tracks.extend(
            page.items
                .into_iter()
                .filter(|track| track.id > 0)
                .map(|track| (track.id, track)),
        );
    }
    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_lookup_preserves_missing_and_database_failures_as_explicit_results() {
        let missing = selection_lookup(77, Ok(None)).unwrap_err();
        let database =
            selection_lookup(88, Err(anyhow::anyhow!("connection unavailable"))).unwrap_err();
        assert_eq!(missing["track_id"], 77);
        assert_eq!(database["track_id"], 88);
        for detail in [&missing, &database] {
            assert_eq!(detail["status"], "失败");
            assert_eq!(detail["stage"], "lookup");
            assert_eq!(detail["file_changed"], false);
        }
        assert!(missing["error"].as_str().unwrap().contains("没有这条曲目"));
        assert!(database["error"]
            .as_str()
            .unwrap()
            .contains("connection unavailable"));
        let track = Track {
            id: 9,
            ..Default::default()
        };
        assert_eq!(selection_lookup(9, Ok(Some(track.clone()))).unwrap().id, 9);
        assert!(selection_lookup(0, Ok(Some(track))).is_err());
    }

    #[test]
    fn selection_pagination_validates_size_and_clamps_without_overflow() {
        let empty = serde_json::Map::new();
        assert_eq!(selection_page(&empty, 0).unwrap(), (1, 100, 0, 0..0));
        let last = json!({"page": i64::MAX, "page_size": 200});
        assert_eq!(
            selection_page(last.as_object().unwrap(), 1005).unwrap(),
            (6, 200, 6, 1000..1005)
        );
        let first = json!({"page": -20, "page_size": 200});
        assert_eq!(
            selection_page(first.as_object().unwrap(), 1005).unwrap(),
            (1, 200, 6, 0..200)
        );
        for invalid in [
            json!({"page_size": 0}),
            json!({"page_size": 201}),
            json!({"page": "not-an-int"}),
            json!({"page": 2.5}),
            json!({"page_size": true}),
        ] {
            assert!(selection_page(invalid.as_object().unwrap(), 1005).is_err());
        }
    }

    #[test]
    fn selection_projection_keeps_missing_positions_and_does_not_claim_disk_existence() {
        let track = Track {
            id: 9,
            path: "/offline/music/never-statted.flac".into(),
            title: "索引里的曲目".into(),
            ..Default::default()
        };
        let tracks = HashMap::from([(9, track)]);
        let items = selection_items(&[7, 9, 0], &tracks);
        assert_eq!(
            items
                .iter()
                .map(|item| item["id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![7, 9, 0]
        );
        assert_eq!(items[0]["status"], "missing");
        assert!(items[0]["track"].is_null());
        assert_eq!(items[1]["status"], "found");
        assert_eq!(items[1]["track"]["title"], "索引里的曲目");
        assert!(items[1]["track"].get("file_exists").is_none());
        assert_eq!(items[2]["status"], "missing");
    }
}
