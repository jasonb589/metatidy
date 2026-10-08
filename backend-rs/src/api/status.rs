//! 状态、设置、数据源：`/api/status`、`/api/settings`、`/api/sources`。
//!
//! `/api/status` 是**并集**（契约 K.1 的取舍）：
//! - Python 版那套字段一个不少（`version`/`music_dir`/`music_dir_exists`/`library_root`/
//!   `data_dir`/`db_path`/`supported_formats`/`stats`/`scraper`/`docker`），前端零改动可用；
//! - Rust 侧原有的冒烟断言字段继续保留（`engine`/`postgres`/`redis`，CI 会 grep 它们）。

use axum::body::Bytes;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Map, Value};

use crate::repo;
use crate::scanner;
use crate::scrapers;
use crate::AppState;

use super::{
    parse_body, placeholder_keys, py_str, settings_values, user_setting_defaults, ApiError,
    ApiResult, TEMPLATE_PLACEHOLDERS,
};

use crate::templates::validate_template;

/// `/api/status`
pub async fn api_status(State(state): State<AppState>) -> ApiResult {
    let stats = repo::library_stats(&state.db).await?;
    let sources = scrapers::known_sources();
    let redis_ok = match state.redis.clone() {
        Some(mut conn) => {
            let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
            pong.map(|v| v == "PONG").unwrap_or(false)
        }
        None => false,
    };

    let mut formats: Vec<String> = scanner::AUDIO_EXTENSIONS
        .iter()
        .map(|ext| (*ext).to_string())
        .collect();
    formats.sort();

    let data_dir = state.config.data_dir.to_string_lossy().to_string();
    let db_path = state
        .config
        .data_dir
        .join("metatidy.db")
        .to_string_lossy()
        .to_string();

    let body = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rust",
        "music_dir": state.config.music_dir.to_string_lossy(),
        "music_dir_exists": state.config.music_dir.exists(),
        "library_root": super::library_root(&state.db, &state.config).await?,
        "data_dir": data_dir,
        "db_path": db_path,
        "supported_formats": formats,
        "stats": {
            "tracks": stats.tracks,
            "artists": stats.artists,
            "albums": stats.albums,
            "missing_cover": stats.missing_cover,
            "missing_lyrics": stats.missing_lyrics,
            "no_artist": stats.no_artist,
            "no_album": stats.no_album,
            "bytes": stats.bytes,
            "languages": stats.languages,
            "albumtypes": stats.albumtypes,
            // Rust 侧新增：快速扫描后「只建了索引、还没读过标签」的条数
            "not_loaded": stats.not_loaded,
        },
        "scraper": {
            "available": true,
            "sources": sources,
            "count": sources.len(),
        },
        "docker": std::path::Path::new("/.dockerenv").exists(),
        "tracks": stats.tracks,
        "postgres": true,
        "redis": redis_ok,
    });
    Ok(Json(body))
}

/// `/api/settings`
pub async fn get_settings(State(state): State<AppState>) -> ApiResult {
    let values = settings_values(&state.db, &state.config).await?;
    let placeholders: Vec<Value> = TEMPLATE_PLACEHOLDERS
        .iter()
        .map(|(key, desc)| json!({ "key": key, "desc": desc }))
        .collect();
    Ok(Json(json!({ "values": values, "placeholders": placeholders })))
}

/// `PUT /api/settings`：白名单外的键**静默丢弃**；校验不阻塞保存（先落库再出警告）。
pub async fn put_settings(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let Some(values) = payload.get("values") else {
        return Err(ApiError::unprocessable(
            "missing",
            vec!["body", "values"],
            "Field required",
            Value::Null,
            None,
        ));
    };
    if !values.is_object() {
        return Err(ApiError::unprocessable(
            "dict_type",
            vec!["body", "values"],
            "Input should be a valid dictionary",
            values.clone(),
            None,
        ));
    }
    let mut incoming: Map<String, Value> = values.as_object().cloned().unwrap_or_default();

    let mut saved = Map::new();
    let known: Vec<&str> = user_setting_defaults()
        .into_iter()
        .map(|(k, _)| k)
        .chain(std::iter::once("library_root"))
        .collect();
    // 按提交顺序逐键写入（未知键直接跳过）
    for (key, value) in incoming.iter_mut() {
        if !known.contains(&key.as_str()) {
            continue;
        }
        repo::set_setting(&state.db, key, value).await?;
        saved.insert(key.clone(), value.clone());
    }

    let mut warnings: Vec<String> = Vec::new();
    let keys = placeholder_keys();
    for (field, label) in [
        ("dir_template", "目录模板"),
        ("filename_template", "文件名模板"),
    ] {
        if let Some(value) = saved.get(field) {
            for warning in validate_template(&py_str(value), &keys) {
                warnings.push(format!("{label}：{warning}"));
            }
        }
    }

    Ok(Json(json!({ "saved": saved, "warnings": warnings })))
}

/// 数据源注册表（13 条，顺序与 `scrapers::SOURCE_NAMES` 一致）。
const SOURCE_LABELS: &[(&str, &str, Option<&str>)] = &[
    ("musicbrainz", "MusicBrainz", None),
    ("netease", "网易云音乐", None),
    ("qq", "QQ音乐", None),
    ("kugou", "酷狗音乐", None),
    ("kuwo", "酷我音乐", None),
    ("itunes", "iTunes", None),
    ("deezer", "Deezer", None),
    ("lastfm", "Last.fm", Some("LASTFM_API_KEY")),
    ("theaudiodb", "TheAudioDB", None),
    (
        "spotify",
        "Spotify",
        Some("SPOTIFY_CLIENT_ID+SPOTIFY_CLIENT_SECRET"),
    ),
    ("genius", "Genius", Some("GENIUS_TOKEN")),
    ("ytmusic", "YouTube Music", None),
    ("discogs", "Discogs", Some("DISCOGS_TOKEN")),
];

/// `/api/sources`
///
/// `status` 在 Rust 版统一是「内置」：13 个源都有内置实现（Python 版的「已迁移」
/// 指的是迁移层提供实现，Rust 侧不存在那个迁移层）。
pub async fn api_sources() -> ApiResult {
    let mut out: Vec<Value> = Vec::with_capacity(SOURCE_LABELS.len());
    for (name, label, needs_key) in SOURCE_LABELS {
        let implemented = scrapers::SOURCE_NAMES.contains(name);
        out.push(json!({
            "name": name,
            "label": label,
            "needs_key": needs_key,
            "status": if implemented { "内置" } else { "不可用" },
            "default_on": scrapers::SEARCH_PRIORITY.contains(name),
        }));
    }
    Ok(Json(json!({ "sources": out })))
}

/// 设置里取字符串数组（`enabled_sources`），空则调用方回落到搜索优先级。
pub async fn enabled_sources(state: &AppState) -> Vec<String> {
    super::setting_str_list(&state.db, "enabled_sources")
        .await
        .unwrap_or_default()
}

/// 供其它子模块复用的「有效设置」读取（失败时退回纯默认值，不把请求打挂）。
pub async fn effective_settings(state: &AppState) -> Map<String, Value> {
    settings_values(&state.db, &state.config)
        .await
        .unwrap_or_else(|_| {
            let mut out = Map::new();
            for (key, value) in user_setting_defaults() {
                out.insert(key.to_string(), value);
            }
            out
        })
}

/// 单条模板校验警告文案（`PUT /api/settings` 与 `/api/move/preview` 共用格式）。
pub fn template_warnings(template: &str) -> Vec<String> {
    validate_template(template, &placeholder_keys())
}
