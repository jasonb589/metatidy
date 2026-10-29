//! 曲目索引与元数据编辑：`/api/tracks*`、`/api/aliases/{kind}`。
//!
//! 三条写路径里的前两条在这里：
//! - `/api/tracks/preview`：只读文件算差异（`tagio::preview_update`），绝不落盘
//! - `/api/tracks/apply`：真写标签 + 同步索引（写失败进 `failed[]`，不中断整批）

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::models::{FieldChange, Track};
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
/// `size=0` = 原图；`size>0` = 缩略图。缓存落 `{data_dir}/covers|thumbs/{id}.jpg`，
/// 只在 `缓存 mtime >= 曲目 mtime` 时复用（与 Python 的失效判断一致）。
///
/// ⚠️ 有意偏离：契约要求 `size>0` 时返回真正的缩略图，但那需要图像库（PIL 的等价物），
/// 而任务约束不允许新增依赖 —— 这里返回**原图字节**并标 `image/jpeg`
/// （浏览器 `<img>` 会自己缩放，前端表现不变）。
pub async fn cover(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let track_id = path_i64(&raw_id, "track_id")?;
    let size = RawQuery(params).i64("size", 0)?;
    let track = match repo::get_track(&state.db, track_id).await? {
        Some(track) => track,
        None => return Err(ApiError::not_found("没有这条曲目")),
    };

    let cache_dir = if size > 0 {
        state.config.thumb_cache_dir()
    } else {
        state.config.cover_cache_dir()
    };
    let cache: PathBuf = cache_dir.join(format!("{track_id}.jpg"));
    if let Ok(meta) = fs::metadata(&cache) {
        let cached_mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        if cached_mtime >= track.mtime {
            if let Ok(bytes) = fs::read(&cache) {
                return Ok(image_response(bytes, "image/jpeg"));
            }
        }
    }

    let Some((bytes, mime)) = tagio::read_cover(std::path::Path::new(&track.path)) else {
        return Err(ApiError::not_found("这首歌没有内嵌封面"));
    };
    let mime = if size > 0 { "image/jpeg".to_string() } else { mime };
    if let Err(err) = fs::create_dir_all(&cache_dir).and_then(|_| fs::write(&cache, &bytes)) {
        tracing::debug!("封面缓存写入失败（不影响响应）：{err}");
    }
    Ok(image_response(bytes, &mime))
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

/// `POST /api/tracks/preview`：差异预览（只读文件）。
pub async fn preview(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let ids = body_ids(&payload, "ids")?;
    if ids.is_empty() {
        return Err(ApiError::bad_request("至少选择一首"));
    }
    let normalize_artist = super::body_bool(&payload, "normalize_artist", true)?;
    let raw_fields = body_field_map(&payload, "fields")?;
    let mut fields = prepare_fields(&raw_fields, normalize_artist);
    // 歌词走独立通道：它不是普通文本字段（不在 EDITABLE_FIELDS 里），填了才写、留空 = 不动
    let lyrics = raw_fields
        .get("lyrics")
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
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
            continue; // 索引里查不到的 id 静默跳过
        };
        let path = std::path::Path::new(&track.path);
        let mut changes = tagio::preview_update(path, &fields);
        // 歌词的差异只报「行数 + 首行」：整篇塞进差异表没法看
        if let Some(new_lyrics) = &lyrics {
            let old_lyrics = tagio::read_lyrics(path);
            if old_lyrics.trim() != new_lyrics.trim() {
                changes.insert(
                    "lyrics".to_string(),
                    FieldChange {
                        old: lyrics_summary(&old_lyrics),
                        new: lyrics_summary(new_lyrics),
                    },
                );
            }
        }
        let current = raw_tags_json(&tagio::read_tags(path));
        changed_total += changes.len();
        items.push(json!({
            "path": track.path,
            "changes": changes_json(&changes),
            "count": changes.len(),
            "current": current,
            "track_id": track.id,
            "filename": track.filename,
            "file_exists": path.exists(),
        }));
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
    let mut fields = prepare_fields(&raw_fields, normalize_artist);
    // 歌词走独立通道：它不是普通文本字段（不在 EDITABLE_FIELDS 里），填了才写、留空 = 不动
    let lyrics = raw_fields
        .get("lyrics")
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    if fields.is_empty() && lyrics.is_none() {
        return Err(ApiError::bad_request("没有可编辑的字段"));
    }
    let artist_alias = repo::aliases(&state.db, "artist").await?;
    let album_alias = repo::aliases(&state.db, "album").await?;
    fields = apply_aliases(&fields, &artist_alias, &album_alias);

    let mut written = 0i64;
    let mut failed: Vec<Value> = Vec::new();
    for track_id in &ids {
        let Some(track) = repo::get_track(&state.db, *track_id).await? else {
            failed.push(json!({ "track_id": track_id, "error": "索引里没有这条曲目" }));
            continue;
        };
        let path = std::path::Path::new(&track.path);
        match tagio::apply_update(path, &fields, overwrite, None, lyrics.as_deref()) {
            Ok(_) => {
                let (mtime, size) = file_meta(path);
                repo::sync_after_write(
                    &state.db,
                    track.id,
                    &fields,
                    Some(mtime),
                    Some(size),
                    false,
                    None,
                    lyrics.as_ref().map(|_| true),
                    true,
                )
                .await?;
                written += 1;
            }
            Err(err) => failed.push(json!({
                "track_id": track_id,
                "path": track.path,
                "error": format!("TagError: {err}"),
            })),
        }
    }

    let mut sorted: Vec<String> = fields.keys().cloned().collect();
    if lyrics.is_some() {
        sorted.push("lyrics".to_string());
    }
    sorted.sort();
    Ok(Json(json!({ "written": written, "failed": failed, "fields": sorted })))
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
fn lyrics_summary(text: &str) -> String {
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

/// 文件元数据（失败时给 0，和 Python 的 `_safe_mtime/_safe_size` 一样吞掉错误）。
pub fn file_meta(path: &std::path::Path) -> (f64, i64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            (mtime, meta.len() as i64)
        }
        Err(_) => (0.0, 0),
    }
}



