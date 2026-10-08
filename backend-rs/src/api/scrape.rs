//! 搜索与刮削：`/api/search`、`/api/scrape/apply`、`/api/scrape/batch`。
//!
//! 写入路径与 Python 完全一致：
//! 1. 从候选里取「用户勾选的字段」→ 清洗（白名单 + 多歌手归一）→ 套别名库
//! 2. 先算差异（`preview_update`，只读）→ 再落盘（`apply_update`）
//! 3. 索引同步带上 `mtime/size/scraped_at`，写了封面/歌词就把标志位置 1
//!
//! 两条接口的 `written` 类型**故意不同**（int vs list[str]）：
//! 前端与 e2e 分别按这两种用法断言（契约 D.1 的 ⚠️）。

use std::collections::HashMap;
use std::path::Path;

use axum::body::Bytes;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Map, Value};

use crate::jobs::{JobPatch, JobStore, Progress};
use crate::models::Track;
use crate::repo;
use crate::scrapers::{self, ScrapeQuery};
use crate::tagio;
use crate::AppState;

use super::status::enabled_sources;
use super::tracks::file_meta;
use super::{apply_aliases, changes_json, parse_body, ApiError, ApiResult, HTTP};

/// 默认要写的字段（`ScrapeApplyRequest.fields` 的默认值）。
pub const DEFAULT_WRITE_FIELDS: &[&str] = &[
    "title",
    "artist",
    "album",
    "albumartist",
    "genre",
    "year",
    "albumtype",
];

/// `POST /api/search`
pub async fn search(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let track_id = match payload.get("track_id") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        Some(other) => {
            return Err(ApiError::unprocessable(
                "int_type",
                vec!["body", "track_id"],
                "Input should be a valid integer",
                other.clone(),
                None,
            ))
        }
    };
    let track = match track_id {
        Some(id) => repo::get_track(&state.db, id).await?,
        None => None,
    };

    let mut keyword = body_str_of(&payload, "keyword");
    let mut artist_hint = body_str_of(&payload, "artist_hint");
    if let Some(track) = &track {
        if keyword.is_empty() {
            keyword = if !track.title.trim().is_empty() {
                track.title.trim().to_string()
            } else {
                Path::new(&track.path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            if artist_hint.is_empty() {
                artist_hint = track.artist.trim().to_string();
            }
        }
    }
    if keyword.is_empty() {
        return Err(ApiError::bad_request("缺少搜索关键词"));
    }

    let requested = super::body_str_list(&payload, "sources")?;
    let sources = if requested.is_empty() {
        enabled_sources(&state).await
    } else {
        requested
    };
    let limit = super::body_i64(&payload, "limit", 3)?.clamp(1, 10) as usize;

    let query = ScrapeQuery {
        title: keyword.clone(),
        artist: artist_hint.clone(),
        album: track.as_ref().map(|t| t.album.clone()),
        duration: track.as_ref().map(|t| t.duration),
        sources,
        limit,
    };
    let outcome = scrapers::search_all(&HTTP, &query).await;
    // 生效源顺序 = `source_status` 的顺序（`search_all` 的实现约定）
    let effective: Vec<String> = outcome
        .source_status
        .iter()
        .map(|s| s.source.clone())
        .collect();
    let known = scrapers::known_sources();

    let mut body = json!({
        "keyword": keyword,
        "artist_hint": artist_hint,
        "sources": effective,
        "candidates": outcome.candidates,
        "source_status": outcome.source_status,
        "core": {
            "available": true,
            "sources": known,
            "count": known.len(),
        },
    });
    if let Some(track) = &track {
        body["track"] = json!({
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "duration": track.duration,
        });
    }
    Ok(Json(body))
}

/// `POST /api/scrape/apply`：单首，把候选字段写进文件。
pub async fn apply(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let track_id = super::body_i64(&payload, "track_id", 0)?;
    let track = repo::get_track(&state.db, track_id).await?;
    let Some(track) = track else {
        return Err(ApiError::not_found("没有这条曲目"));
    };
    let candidate = payload.get("candidate").cloned().unwrap_or(Value::Null);
    if !candidate.is_object() {
        return Err(ApiError::unprocessable(
            "dict_type",
            vec!["body", "candidate"],
            "Input should be a valid dictionary",
            candidate.clone(),
            None,
        ));
    }
    let mut fields = super::body_str_list(&payload, "fields")?;
    if fields.is_empty() {
        fields = DEFAULT_WRITE_FIELDS.iter().map(|s| (*s).to_string()).collect();
    }
    let write_cover = super::body_bool(&payload, "write_cover", false)?;
    let write_lyrics = super::body_bool(&payload, "write_lyrics", false)?;
    let normalize_artist = super::body_bool(&payload, "normalize_artist", true)?;
    let overwrite = super::body_bool(&payload, "overwrite", true)?;

    let result = apply_candidate(
        &state,
        &track,
        &candidate,
        &fields,
        write_cover,
        write_lyrics,
        normalize_artist,
        overwrite,
        false,
    )
    .await?;

    Ok(Json(json!({
        // ⚠️ 这里是数组（`tracks/apply` 那边是 int）
        "written": result.written,
        "changes": result.changes,
        "cover": result.cover,
        "lyrics": result.lyrics,
    })))
}

/// `POST /api/scrape/batch`：批量刮削（后台任务，逐首搜索，可按分数阈值自动写入）。
pub async fn batch(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let ids = super::body_ids(&payload, "ids")?;
    if ids.is_empty() {
        return Err(ApiError::bad_request("至少选择一首"));
    }
    let mut fields = super::body_str_list(&payload, "fields")?;
    if fields.is_empty() {
        fields = DEFAULT_WRITE_FIELDS.iter().map(|s| (*s).to_string()).collect();
    }
    let requested = super::body_str_list(&payload, "sources")?;
    let sources = if requested.is_empty() {
        enabled_sources(&state).await
    } else {
        requested
    };
    let limit = super::body_i64(&payload, "limit", 3)?.max(1) as usize;
    let write_cover = super::body_bool(&payload, "write_cover", false)?;
    let write_lyrics = super::body_bool(&payload, "write_lyrics", false)?;
    let threshold = super::body_f64(&payload, "auto_apply_min_score", 0.0)?;
    let normalize_artist = super::body_bool(&payload, "normalize_artist", true)?;

    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job_id = store.create("scrape").await?;
    let params = BatchParams {
        ids,
        fields,
        sources,
        limit,
        write_cover,
        write_lyrics,
        threshold,
        normalize_artist,
    };
    let job_state = state.clone();
    let job_store = store.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        run_batch(job_state, job_store, job_id_for_task, params).await;
    });
    Ok(Json(json!({ "job_id": job_id })))
}

/// 批量刮削的任务参数。
struct BatchParams {
    ids: Vec<i64>,
    fields: Vec<String>,
    sources: Vec<String>,
    limit: usize,
    write_cover: bool,
    write_lyrics: bool,
    threshold: f64,
    normalize_artist: bool,
}

/// 批量刮削的任务体（与 Python `_run_batch_scrape` 逐条对齐）。
async fn run_batch(state: AppState, store: JobStore, job_id: String, params: BatchParams) {
    let mut progress = Progress::new(store.clone(), job_id.clone());
    if !JobStore::acquire_slot().await {
        let _ = store
            .update(
                &job_id,
                &JobPatch {
                    state: Some("error".to_string()),
                    error: Some("等待其它任务超时".to_string()),
                    ..Default::default()
                },
            )
            .await;
        return;
    }
    progress.note("开始").await;
    progress.set_total(params.ids.len() as i64).await;

    let artist_alias = repo::aliases(&state.db, "artist").await.unwrap_or_default();
    let album_alias = repo::aliases(&state.db, "album").await.unwrap_or_default();
    let search_only = params.threshold <= 0.0;

    let mut applied = 0i64;
    let mut skipped = 0i64;
    let mut failed = 0i64;
    let mut details: Vec<Value> = Vec::new();

    for track_id in &params.ids {
        let track = repo::get_track(&state.db, *track_id).await.ok().flatten();
        let Some(track) = track else {
            progress.step(1, None).await;
            continue;
        };
        let outcome = async {
            let keyword = if track.title.trim().is_empty() {
                Path::new(&track.path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                track.title.trim().to_string()
            };
            let query = ScrapeQuery {
                title: keyword,
                artist: track.artist.trim().to_string(),
                album: Some(track.album.clone()),
                duration: Some(track.duration),
                sources: params.sources.clone(),
                limit: params.limit,
            };
            let found = scrapers::search_all(&HTTP, &query).await;
            let best = found.candidates.first().cloned();
            let Some(best) = best else {
                skipped += 1;
                details.push(json!({ "track_id": track_id, "status": "无候选" }));
                return Ok::<(), ApiError>(());
            };
            let best_value = serde_json::to_value(&best).unwrap_or(Value::Null);
            if search_only {
                skipped += 1;
                details.push(json!({
                    "track_id": track_id,
                    "status": "仅搜索",
                    "score": best.score,
                    "candidate": {
                        "source": best.source,
                        "title": best.title,
                        "artist": best.artist,
                        "album": best.album,
                        "year": best.year,
                        "confidence": best.confidence,
                    },
                }));
                return Ok(());
            }
            if best.score < params.threshold {
                skipped += 1;
                details.push(json!({
                    "track_id": track_id,
                    "status": "低于阈值",
                    "score": best.score,
                }));
                return Ok(());
            }
            let written = apply_candidate(
                &state,
                &track,
                &best_value,
                &params.fields,
                params.write_cover,
                params.write_lyrics,
                params.normalize_artist,
                true, // 批量路径固定 overwrite=True（与 Python 一致）
                true, // 批量路径取歌词时带上专辑名（Python 的批量分支参数是齐的）
            )
            .await?;
            applied += 1;
            details.push(json!({
                "track_id": track_id,
                "status": "已写入",
                "score": best.score,
                "fields": written.written,
                "cover": written.cover,
                "lyrics": written.lyrics,
            }));
            Ok(())
        }
        .await;

        if let Err(err) = outcome {
            failed += 1;
            details.push(json!({
                "track_id": track_id,
                "status": "失败",
                "error": err.detail_text(),
            }));
        }
        let _ = (&artist_alias, &album_alias);
        progress
            .step(
                1,
                Some(if track.filename.is_empty() {
                    track_id.to_string()
                } else {
                    track.filename.clone()
                }),
            )
            .await;
    }

    let details: Vec<Value> = details.into_iter().take(super::PREVIEW_DISPLAY_LIMIT).collect();
    progress
        .finish(Some(json!({
            "applied": applied,
            "skipped": skipped,
            "failed": failed,
            "search_only": search_only,
            "details": details,
        })))
        .await;
}

/// 把候选字段写进文件并同步索引（单首与批量共用同一条路径）。
///
/// `album_for_lyrics`：批量路径取歌词时带专辑名，单首路径不带
/// （Python 的单首分支把 duration 传给了 album 形参，属于 bug；这里按正确语义走）。
#[allow(clippy::too_many_arguments)]
pub async fn apply_candidate(
    state: &AppState,
    track: &Track,
    candidate: &Value,
    fields: &[String],
    write_cover: bool,
    write_lyrics: bool,
    normalize_artist: bool,
    overwrite: bool,
    album_for_lyrics: bool,
) -> Result<CandidateWrite, ApiError> {
    let empty = Map::new();
    let candidate_map = candidate.as_object().unwrap_or(&empty);

    let mut raw: HashMap<String, String> = HashMap::new();
    for key in fields {
        let Some(value) = candidate_map.get(key) else {
            continue;
        };
        if is_blank(value) {
            continue;
        }
        raw.insert(key.clone(), super::v_text(value));
    }
    if fields.iter().any(|f| f == "albumtype") {
        if let Some(value) = candidate_map.get("album_type") {
            if !is_blank(value) {
                raw.insert("albumtype".to_string(), super::v_text(value));
            }
        }
    }
    if raw.is_empty() && !write_cover && !write_lyrics {
        return Err(ApiError::bad_request("没有选择要写入的内容"));
    }

    let mut values = super::prepare_fields(&raw, normalize_artist);
    let artist_alias = repo::aliases(&state.db, "artist").await?;
    let album_alias = repo::aliases(&state.db, "album").await?;
    values = apply_aliases(&values, &artist_alias, &album_alias);

    // 封面：只在勾选且候选带 URL 时才下载（失败不报错，只是没写上）
    let mut cover: Option<(Vec<u8>, String)> = None;
    if write_cover {
        if let Some(url) = candidate_map.get("cover").map(super::v_text) {
            if !url.trim().is_empty() {
                if let Some((bytes, mime)) = scrapers::fetch_cover(&HTTP, url.trim()).await {
                    cover = Some((bytes, mime));
                }
            }
        }
    }

    // 歌词：候选自带就用候选的，否则现取
    let mut lyrics = String::new();
    if write_lyrics {
        lyrics = candidate_map
            .get("lyrics")
            .map(super::v_text)
            .unwrap_or_default();
        if lyrics.trim().is_empty() {
            let title = values
                .get("title")
                .cloned()
                .unwrap_or_else(|| track.title.clone());
            let artist = values
                .get("artist")
                .cloned()
                .unwrap_or_else(|| track.artist.clone());
            let album = if album_for_lyrics {
                Some(
                    values
                        .get("album")
                        .cloned()
                        .unwrap_or_else(|| track.album.clone()),
                )
            } else {
                None
            };
            let duration = candidate_map
                .get("duration")
                .and_then(|v| v.as_f64())
                .unwrap_or(track.duration);
            if let Some((text, _source)) = scrapers::fetch_lyrics(
                &HTTP,
                title.trim(),
                artist.trim(),
                album.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                Some(duration),
            )
            .await
            {
                lyrics = text;
            }
        }
    }

    let path = Path::new(&track.path);
    let changes = tagio::preview_update(path, &values);
    let cover_for_write = cover.clone();
    let lyrics_for_write = if lyrics.trim().is_empty() {
        None
    } else {
        Some(lyrics.clone())
    };
    if let Err(err) = tagio::apply_update(path, &values, overwrite, cover_for_write, lyrics_for_write.as_deref())
    {
        return Err(ApiError::Status(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("写入失败：{err}"),
        ));
    }

    let (mtime, size) = file_meta(path);
    let has_cover = if cover.is_some() { Some(true) } else { None };
    let has_lyrics = if lyrics.trim().is_empty() { None } else { Some(true) };
    repo::sync_after_write(
        &state.db,
        track.id,
        &values,
        Some(mtime),
        Some(size),
        true,
        has_cover,
        has_lyrics,
        false,
    )
    .await?;

    let mut written: Vec<String> = values.keys().cloned().collect();
    written.sort();
    Ok(CandidateWrite {
        written,
        changes: changes_json(&changes),
        cover: cover.is_some(),
        lyrics: !lyrics.trim().is_empty(),
    })
}

/// 一次候选写入的结果。
pub struct CandidateWrite {
    pub written: Vec<String>,
    pub changes: Value,
    pub cover: bool,
    pub lyrics: bool,
}

/// `null` / 空串 / 空数组都算「没给」（Python 是 `v not in (None, "")`）。
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

/// 取字符串字段（局部小工具，避免把 `Map` 拆开传）。
fn body_str_of(payload: &Map<String, Value>, key: &str) -> String {
    super::body_str(payload, key, "").trim().to_string()
}
