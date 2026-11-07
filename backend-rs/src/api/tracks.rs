//! 曲目索引与元数据编辑：`/api/tracks*`、`/api/aliases/{kind}`。
//!
//! 三条写路径里的前两条在这里：
//! - `/api/tracks/preview`：只读文件算差异（`tagio::preview_update`），绝不落盘
//! - `/api/tracks/apply`：真写标签 + 同步索引（写失败进 `failed[]`，不中断整批）

use std::collections::{BTreeSet, HashMap};
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
    full_track_json, light_track_json, path_i64, prepare_fields, raw_tags_json, ApiError, ApiResult,
    RawQuery, PREVIEW_DISPLAY_LIMIT,
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

    let page = query.i64("page", 1)?;
    let order = query.str("order", "asc");
    let track_query = TrackQuery {
        q: query.str("q", ""),
        page,
        page_size,
        sort: query.str("sort", "artist"),
        order_desc: order.trim().eq_ignore_ascii_case("desc"),
        language: query.str("language", ""),
        albumtype: query.str("albumtype", ""),
        genre: query.str("genre", ""),
        year: query.str("year", ""),
        artist: query.str("artist", ""),
        album: query.str("album", ""),
        album_group: super::albums::parse_album_group(query.0.get("album_group"))?,
        missing_cover: query.bool("missing_cover", false)?,
        missing_lyrics: query.bool("missing_lyrics", false)?,
        no_artist: query.bool("no_artist", false)?,
        no_album: query.bool("no_album", false)?,
        // Rust 新增参数（Python 没有，前端也没用；快速扫描后用得上）
        not_loaded: query.bool("not_loaded", false)?,
        ids: Vec::new(),
    };

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
    let ids = body_ids(&payload, "ids")?;
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
    })))
}

/// `POST /api/tracks/apply`：真写标签 + 同步索引。
pub async fn apply(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let ids = body_ids(&payload, "ids")?;
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
    for track_id in &ids {
        let Some(track) = repo::get_track(&state.db, *track_id).await? else {
            failed.push(json!({ "track_id": track_id, "error": "索引里没有这条曲目", "stage": "lookup", "file_changed": false }));
            continue;
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

/// 一次取回多条曲目（按 id 建索引，避免 N 次查询）。
pub async fn fetch_by_ids(
    state: &AppState,
    ids: &[i64],
) -> Result<HashMap<i64, Track>, ApiError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let query = TrackQuery {
        ids: ids.to_vec(),
        page_size: ids.len() as i64,
        ..Default::default()
    };
    let page = repo::list_tracks(&state.db, &query).await?;
    Ok(page.items.into_iter().map(|t| (t.id, t)).collect())
}

