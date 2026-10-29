//! HTTP 接口层（阶段 4）：21 条路由逐字段对齐 Python 版契约（`app/main.py`）。
//!
//! 为什么手写解析而不用 `axum::Json<T>`：
//! FastAPI 的校验错误是 `422 {"detail":[{type,loc,msg,input,...}]}`，而 axum 的拒绝
//! 响应是纯文本；前端 `app/static/api.js:20-36` 专门解析数组形态的 detail，
//! 所以请求体统一按 `Bytes` 收下再自己校验，错误形状完全可控。
//!
//! 对齐清单（键名字面量见各子模块）：
//! - 错误体一律 `{"detail": "中文消息"}`；校验失败是数组形态
//! - `jobs.result` 是 **JSON 字符串**（前端与 e2e 都要二次 parse）
//! - 时间戳一律浮点秒（`indexed_at`/`edited_at`/`scraped_at`/`created_at`/`updated_at`）
//! - 布尔过滤参数在查询串里是 `1/true`，请求体里兼容 bool 与 "1"/"true"
//! - 静态前端挂在最后（`main.rs` 里做 fallback），API 路由优先

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde_json::{json, Map, Value};

use crate::config::Config;
use crate::error::AppError;
use crate::models::{FieldChange, Track};
use crate::repo;
use crate::AppState;

mod moves;
mod scrape;
mod status;
mod tracks;

/// 刮削层用的公共 HTTP 客户端（连接池复用；UA 与 `scrapers.rs` 保持一致）。
pub static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent("metatidy/0.1 (https://github.com/jasonb589/metatidy)")
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// 一次最多回多少条明细（Python 的 `PREVIEW_DISPLAY_LIMIT`）。
pub const PREVIEW_DISPLAY_LIMIT: usize = 500;

/// 管理界面的 11 个可写设置键（顺序 = Python `USER_SETTING_DEFAULTS` 的书写顺序）。
///
/// 做成函数而不是 `const`：`Value` 的构造不是 const fn。
pub fn user_setting_defaults() -> Vec<(&'static str, Value)> {
    vec![
        ("dir_template", json!("{language}/{artist}/{album}")),
        ("filename_template", json!("{track:02} - {title}")),
        ("conflict_policy", json!("rename")),
        ("unknown_artist", json!("未知艺术家")),
        ("unknown_album", json!("未知专辑")),
        ("unknown_other", json!("未知")),
        ("normalize_artist_ampersand", json!(true)),
        (
            "enabled_sources",
            json!(["netease", "qq", "kugou", "kuwo", "musicbrainz", "itunes", "deezer"]),
        ),
        ("write_cover", json!(true)),
        ("write_lyrics", json!(true)),
        ("overwrite_existing", json!(true)),
    ]
}

/// 模板占位符表（14 条，键名与描述照抄 `app/config.py:139-154`）。
pub const TEMPLATE_PLACEHOLDERS: &[(&str, &str)] = &[
    ("artist", "歌手（多歌手已用 & 连接）"),
    ("albumartist", "专辑艺术家"),
    ("album", "专辑名"),
    ("title", "歌曲名"),
    ("track", "音轨号，可补零：{track:02}"),
    ("disc", "碟号，可补零：{disc:02}"),
    ("year", "年份，可截取：{year:4}"),
    ("genre", "流派"),
    ("language", "语言（中文/英文/日文…）"),
    ("albumtype", "专辑类型（专辑/单曲/合辑…）"),
    ("mb_artist_id", "MusicBrainz 歌手 ID"),
    ("release_group_id", "MusicBrainz 发行组 ID"),
    ("ext", "原扩展名（不含点）"),
    ("original", "原文件名（不含扩展名）"),
];

/// 模板占位符 key 集合（校验模板时用）。
pub fn placeholder_keys() -> Vec<&'static str> {
    TEMPLATE_PLACEHOLDERS.iter().map(|(k, _)| *k).collect()
}

/// 接口层错误：`AppError`（500/400/404）+ 校验错误（422 数组形态）+ 任意状态码。
#[derive(Debug)]
pub enum ApiError {
    App(AppError),
    /// pydantic 风格的校验数组，整体塞进 `{"detail": [...]}`
    Unprocessable(Value),
    /// 其它显式状态码（409、404 等）
    Status(StatusCode, String),
}

impl ApiError {
    /// 409（`/api/move/execute` 的一次性 token）
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::Status(StatusCode::CONFLICT, msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::App(AppError::not_found(msg))
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::App(AppError::bad_request(msg))
    }

    /// 构造 pydantic 风格的校验错误。
    pub fn unprocessable(
        typ: &str,
        loc: Vec<&str>,
        msg: &str,
        input: Value,
        ctx: Option<Value>,
    ) -> Self {
        let mut entry = json!({
            "type": typ,
            "loc": loc,
            "msg": msg,
            "input": input,
        });
        if let Some(ctx) = ctx {
            entry["ctx"] = ctx;
        }
        Self::Unprocessable(Value::Array(vec![entry]))
    }

    /// 错误文本（`{"detail": ...}` 里的那份；批量任务的 `details[].error` 也用它）。
    pub fn detail_text(&self) -> String {
        match self {
            ApiError::App(err) => err.to_string(),
            ApiError::Unprocessable(detail) => detail
                .get(0)
                .and_then(|entry| entry.get("msg"))
                .and_then(|msg| msg.as_str())
                .unwrap_or("参数校验失败")
                .to_string(),
            ApiError::Status(_, detail) => detail.clone(),
        }
    }
}

impl From<AppError> for ApiError {
    fn from(err: AppError) -> Self {
        ApiError::App(err)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        ApiError::App(AppError::Other(err))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::App(err) => err.into_response(),
            ApiError::Unprocessable(detail) => {
                (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "detail": detail }))).into_response()
            }
            ApiError::Status(code, detail) => {
                if code.is_server_error() {
                    tracing::error!("请求失败：{detail}");
                }
                (code, Json(json!({ "detail": detail }))).into_response()
            }
        }
    }
}

/// 接口层的统一返回类型。
pub type ApiResult<T = Json<Value>> = Result<T, ApiError>;

// --------------------------------------------------------------------------- 请求体

/// 解析请求体为对象；空请求体等价于空对象（`POST /api/scan` 允许整体缺省）。
pub fn parse_body(body: &Bytes) -> Result<Map<String, Value>, ApiError> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(err) => {
            return Err(ApiError::unprocessable(
                "json_invalid",
                vec!["body"],
                &format!("JSON 解析失败：{err}"),
                Value::String(String::from_utf8_lossy(body).to_string()),
                None,
            ))
        }
    };
    match value {
        Value::Object(map) => Ok(map),
        other => Err(ApiError::unprocessable(
            "dict_type",
            vec!["body"],
            "Input should be a valid dictionary",
            other,
            None,
        )),
    }
}

/// 取字符串字段（`null` 与缺省都当没给；数字/bool 转成文本）。
pub fn body_str(body: &Map<String, Value>, key: &str, default: &str) -> String {
    match body.get(key) {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => default.to_string(),
    }
}

/// 取布尔字段：接受 bool 与 `1/0/true/false/yes/on`（FastAPI 的布尔解析范围）。
pub fn body_bool(body: &Map<String, Value>, key: &str, default: bool) -> Result<bool, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::Number(n)) => Ok(n.as_i64().map(|v| v != 0).unwrap_or(default)),
        Some(Value::String(s)) => parse_bool_str(s).ok_or_else(|| {
            ApiError::unprocessable(
                "bool_parsing",
                vec!["body", key],
                "Input should be a valid boolean",
                Value::String(s.clone()),
                None,
            )
        }),
        Some(other) => Err(ApiError::unprocessable(
            "bool_type",
            vec!["body", key],
            "Input should be a valid boolean",
            other.clone(),
            None,
        )),
    }
}

/// 取整数字段（`null` → 默认值）。
pub fn body_i64(body: &Map<String, Value>, key: &str, default: i64) -> Result<i64, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| {
            ApiError::unprocessable(
                "int_parsing",
                vec!["body", key],
                "Input should be a valid integer",
                Value::Number(n.clone()),
                None,
            )
        }),
        Some(Value::String(s)) => s.trim().parse::<i64>().map_err(|_| {
            ApiError::unprocessable(
                "int_parsing",
                vec!["body", key],
                "Input should be a valid integer",
                Value::String(s.clone()),
                None,
            )
        }),
        Some(other) => Err(ApiError::unprocessable(
            "int_type",
            vec!["body", key],
            "Input should be a valid integer",
            other.clone(),
            None,
        )),
    }
}

/// 取小数字段（`null` → 默认值）。
pub fn body_f64(body: &Map<String, Value>, key: &str, default: f64) -> Result<f64, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(default)),
        Some(Value::String(s)) => s.trim().parse::<f64>().map_err(|_| {
            ApiError::unprocessable(
                "float_parsing",
                vec!["body", key],
                "Input should be a valid number",
                Value::String(s.clone()),
                None,
            )
        }),
        Some(other) => Err(ApiError::unprocessable(
            "float_type",
            vec!["body", key],
            "Input should be a valid number",
            other.clone(),
            None,
        )),
    }
}

/// 取整数数组（`null` → 空数组）。
pub fn body_ids(body: &Map<String, Value>, key: &str) -> Result<Vec<i64>, ApiError> {
    let Some(value) = body.get(key) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        return Err(ApiError::unprocessable(
            "list_type",
            vec!["body", key],
            "Input should be a valid list",
            value.clone(),
            None,
        ));
    };
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        match item {
            Value::Number(n) => {
                let v = n.as_i64().ok_or_else(|| {
                    ApiError::unprocessable(
                        "int_parsing",
                        vec!["body", key, &index.to_string()],
                        "Input should be a valid integer",
                        item.clone(),
                        None,
                    )
                })?;
                out.push(v);
            }
            Value::String(s) => {
                let v = s.trim().parse::<i64>().map_err(|_| {
                    ApiError::unprocessable(
                        "int_parsing",
                        vec!["body", key, &index.to_string()],
                        "Input should be a valid integer",
                        item.clone(),
                        None,
                    )
                })?;
                out.push(v);
            }
            other => {
                return Err(ApiError::unprocessable(
                    "int_type",
                    vec!["body", key, &index.to_string()],
                    "Input should be a valid integer",
                    other.clone(),
                    None,
                ))
            }
        }
    }
    Ok(out)
}

/// 取字符串数组（`null` / 缺省 → 默认值；元素转成文本）。
pub fn body_str_list(body: &Map<String, Value>, key: &str) -> Result<Vec<String>, ApiError> {
    let Some(value) = body.get(key) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        return Err(ApiError::unprocessable(
            "list_type",
            vec!["body", key],
            "Input should be a valid list",
            value.clone(),
            None,
        ));
    };
    Ok(items
        .iter()
        .map(|item| match item {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => String::new(),
        })
        .collect())
}

/// 取对象字段（缺省 / `null` → 空对象）。
pub fn body_map(body: &Map<String, Value>, key: &str) -> Result<Map<String, Value>, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(other) => Err(ApiError::unprocessable(
            "dict_type",
            vec!["body", key],
            "Input should be a valid dictionary",
            other.clone(),
            None,
        )),
    }
}

/// 取字段字典：值允许字符串/数字/bool，`null` 丢弃（Python 的 `v is not None`）。
pub fn body_field_map(body: &Map<String, Value>, key: &str) -> Result<HashMap<String, String>, ApiError> {
    let map = body_map(body, key)?;
    let mut out = HashMap::new();
    for (k, v) in map {
        match v {
            Value::Null => continue,
            Value::String(s) => {
                out.insert(k, s);
            }
            Value::Number(_) | Value::Bool(_) => {
                out.insert(k, v_text(&v));
            }
            _ => continue,
        }
    }
    Ok(out)
}

/// `serde_json::Value` → 文本（字符串直取，其它用紧凑 JSON 表示）。
pub fn v_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Python `str(x)` 的近似：`None` → `"None"`（`/api/template/test` 依赖这个写法）。
pub fn py_str(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "None".to_string(),
        Value::Bool(b) => if *b { "True" } else { "False" }.to_string(),
        other => other.to_string(),
    }
}

fn parse_bool_str(raw: &str) -> Option<bool> {
    match raw.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

// --------------------------------------------------------------------------- 查询串

/// 查询参数（所有键都当可选；数字解析失败按 pydantic 报 422）。
#[derive(Debug, Clone, Default)]
pub struct RawQuery(pub HashMap<String, String>);

impl RawQuery {
    pub fn str(&self, key: &str, default: &str) -> String {
        self.0.get(key).cloned().unwrap_or_else(|| default.to_string())
    }

    pub fn opt_str(&self, key: &str) -> Option<String> {
        self.0.get(key).filter(|v| !v.is_empty()).cloned()
    }

    pub fn bool(&self, key: &str, default: bool) -> Result<bool, ApiError> {
        match self.0.get(key) {
            None => Ok(default),
            Some(raw) if raw.is_empty() => Ok(default),
            Some(raw) => parse_bool_str(raw).ok_or_else(|| {
                ApiError::unprocessable(
                    "bool_parsing",
                    vec!["query", key],
                    "Input should be a valid boolean",
                    Value::String(raw.clone()),
                    None,
                )
            }),
        }
    }

    pub fn i64(&self, key: &str, default: i64) -> Result<i64, ApiError> {
        match self.0.get(key) {
            None => Ok(default),
            Some(raw) if raw.is_empty() => Ok(default),
            Some(raw) => raw.trim().parse::<i64>().map_err(|_| {
                ApiError::unprocessable(
                    "int_parsing",
                    vec!["query", key],
                    "Input should be a valid integer, unable to parse string as an integer",
                    Value::String(raw.clone()),
                    None,
                )
            }),
        }
    }
}

/// `/api/tracks/{track_id}` 的路径参数解析（非数字 → 422）。
pub fn path_i64(raw: &str, param: &str) -> Result<i64, ApiError> {
    raw.trim().parse::<i64>().map_err(|_| {
        ApiError::unprocessable(
            "int_parsing",
            vec!["path", param],
            "Input should be a valid integer, unable to parse string as an integer",
            Value::String(raw.to_string()),
            None,
        )
    })
}

// --------------------------------------------------------------------------- 曲目 JSON

fn ts(value: Option<chrono::DateTime<chrono::Utc>>) -> f64 {
    value
        .map(|dt| dt.timestamp_millis() as f64 / 1000.0)
        .unwrap_or(0.0)
}

/// 列表用的「轻投影」（键集合与 Python 版的 `light=True` 完全一致）。
///
/// `has_cover`/`has_lyrics` 特意用 0/1（Python 是 INTEGER；前端按 falsy/truthy 用）。
pub fn light_track_json(track: &Track) -> Value {
    json!({
        "id": track.id,
        "path": track.path,
        "dir": track.dir,
        "filename": track.filename,
        "ext": track.ext,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "albumartist": track.albumartist,
        "genre": track.genre,
        "year": track.year,
        "track": track.track,
        "disc": track.disc,
        "language": track.language,
        "albumtype": track.albumtype,
        "has_cover": i64::from(track.has_cover),
        "has_lyrics": i64::from(track.has_lyrics),
        "duration": track.duration,
        "indexed_at": ts(track.indexed_at),
        "edited_at": ts(track.edited_at),
        "scraped_at": ts(track.scraped_at),
        "mtime": track.mtime,
        "size": track.size,
        // Rust 侧新增：让前端与验收都能看出「这行只是从路径建的索引，还是真读过标签」
        "tags_loaded": track.tags_loaded,
        "path_derived": track.path_derived,
    })
}

/// 单曲详情（整行 + `file_exists`）；`tags_loaded`/`path_derived` 是 Rust 侧新增列。
pub fn full_track_json(track: &Track) -> Value {
    let mut out = json!({
        "id": track.id,
        "path": track.path,
        "dir": track.dir,
        "filename": track.filename,
        "ext": track.ext,
        "mtime": track.mtime,
        "size": track.size,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "albumartist": track.albumartist,
        "genre": track.genre,
        "year": track.year,
        "track": track.track,
        "disc": track.disc,
        "language": track.language,
        "composer": track.composer,
        "lyricist": track.lyricist,
        "copyright": track.copyright,
        "albumtype": track.albumtype,
        "comment": track.comment,
        "mb_artist_id": track.mb_artist_id,
        "release_group_id": track.release_group_id,
        "has_cover": i64::from(track.has_cover),
        "has_lyrics": i64::from(track.has_lyrics),
        "duration": track.duration,
        "tags_loaded": track.tags_loaded,
        "path_derived": track.path_derived,
        "indexed_at": ts(track.indexed_at),
        "edited_at": ts(track.edited_at),
        "scraped_at": ts(track.scraped_at),
    });
    out["file_exists"] = json!(std::path::Path::new(&track.path).exists());
    out
}

/// 读盘标签的字典（`/api/tracks/preview` 的 `current`，键集合照抄 Python `read_tags`）。
pub fn raw_tags_json(tags: &crate::tagio::RawTags) -> Value {
    let mut out = json!({
        "title": tags.title,
        "artist": tags.artist,
        "album": tags.album,
        "albumartist": tags.albumartist,
        "genre": tags.genre,
        "year": tags.year,
        "track": tags.track,
        "disc": tags.disc,
        "language": tags.language,
        "composer": tags.composer,
        "lyricist": tags.lyricist,
        "copyright": tags.copyright,
        "albumtype": tags.albumtype,
        "comment": tags.comment,
        "mb_artist_id": tags.mb_artist_id,
        "release_group_id": tags.release_group_id,
        "has_cover": i64::from(tags.has_cover),
        "has_lyrics": i64::from(tags.has_lyrics),
        "duration": tags.duration,
        "format": tags.format,
    });
    if let Some(err) = &tags.error {
        out["error"] = json!(err);
    }
    out
}

/// 差异字典 → JSON（`{field: {old, new}}`）。
pub fn changes_json(changes: &HashMap<String, FieldChange>) -> Value {
    let mut map = Map::new();
    let mut keys: Vec<&String> = changes.keys().collect();
    keys.sort();
    for key in keys {
        let change = &changes[key];
        map.insert(
            key.clone(),
            json!({ "old": change.old, "new": change.new }),
        );
    }
    Value::Object(map)
}

// --------------------------------------------------------------------------- 设置与别名

/// 有效设置：默认值铺底 → DB 值覆盖 → 补 `library_root`（Python `all_settings()` 的顺序）。
pub async fn settings_values(
    pool: &sqlx::PgPool,
    config: &Config,
) -> anyhow::Result<Map<String, Value>> {
    let mut out = Map::new();
    for (key, value) in user_setting_defaults() {
        out.insert(key.to_string(), value);
    }
    for (key, value) in repo::all_settings(pool).await? {
        out.insert(key, value);
    }
    out.insert("library_root".to_string(), json!(library_root(pool, config).await?));
    Ok(out)
}

/// 有效库根：DB 设置优先，否则进程配置（Python `_library_root()`）。
pub async fn library_root(pool: &sqlx::PgPool, config: &Config) -> anyhow::Result<String> {
    let configured = repo::get_setting(pool, "library_root").await?;
    let value = match configured {
        Some(Value::String(s)) if !s.trim().is_empty() => s,
        Some(Value::Null) | None => config.library_root.to_string_lossy().to_string(),
        Some(other) => py_str(&other),
    };
    Ok(value)
}

/// 取设置里的字符串数组（用于 `enabled_sources`）。
pub async fn setting_str_list(pool: &sqlx::PgPool, key: &str) -> anyhow::Result<Vec<String>> {
    let raw = repo::get_setting(pool, key).await?;
    Ok(match raw {
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => v_text(other),
            })
            .collect(),
        _ => Vec::new(),
    })
}

/// 写入前套用别名库（只换主艺人/专辑名，保持旧项目语义）。
pub fn apply_aliases(
    fields: &HashMap<String, String>,
    artist_alias: &HashMap<String, String>,
    album_alias: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out = fields.clone();
    if let Some(artist) = out.get("artist").cloned() {
        if !artist.is_empty() && !artist_alias.is_empty() {
            let mut parts = artist.split(" & ");
            let main = parts.next().unwrap_or("").to_string();
            let rest: Vec<&str> = parts.collect();
            if let Some(mapped) = artist_alias.get(&main) {
                let mut joined = mapped.clone();
                for extra in rest {
                    joined.push_str(" & ");
                    joined.push_str(extra);
                }
                out.insert("artist".to_string(), joined);
            }
        }
    }
    if let Some(albumartist) = out.get("albumartist").cloned() {
        if !albumartist.is_empty() && !artist_alias.is_empty() {
            let main = albumartist.split(" & ").next().unwrap_or("").to_string();
            if let Some(mapped) = artist_alias.get(&main) {
                out.insert("albumartist".to_string(), mapped.clone());
            }
        }
    }
    if let Some(album) = out.get("album").cloned() {
        if !album.is_empty() && !album_alias.is_empty() {
            if let Some(mapped) = album_alias.get(&album) {
                out.insert("album".to_string(), mapped.clone());
            }
        }
    }
    out
}


/// 字段字典 → JSON（按 key 排序，输出稳定，方便 e2e/pytest 比对）。
pub fn fields_json(fields: &HashMap<String, String>) -> Value {
    let mut map = Map::new();
    let mut keys: Vec<&String> = fields.keys().collect();
    keys.sort();
    for key in keys {
        map.insert(key.clone(), Value::String(fields[key].clone()));
    }
    Value::Object(map)
}

/// 清洗用户提交的字段：只保留可编辑列、归一化多歌手（Python `_prepare_fields`）。
pub fn prepare_fields(
    fields: &HashMap<String, String>,
    normalize_artist: bool,
) -> HashMap<String, String> {
    let allowed: HashSet<&str> = crate::models::EDITABLE_FIELDS.iter().copied().collect();
    let mut clean: HashMap<String, String> = fields
        .iter()
        .filter(|(k, _)| allowed.contains(k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if normalize_artist {
        for key in ["artist", "albumartist"] {
            if let Some(value) = clean.get(key).cloned() {
                if !value.trim().is_empty() {
                    clean.insert(key.to_string(), crate::normalize::normalize_artist_credit(&value));
                }
            }
        }
    }
    clean
}

/// 别名库表名映射（与 Python 的 `artist→alias_artist` 一致）。
pub fn alias_table(kind: &str) -> Option<&'static str> {
    match kind {
        "artist" => Some("artist"),
        "album" => Some("album"),
        _ => None,
    }
}

/// 错误：`kind` 非法（两条别名接口共用）。
pub fn bad_kind() -> ApiError {
    ApiError::bad_request("kind 只能是 artist 或 album")
}

// --------------------------------------------------------------------------- 路由

/// 21 条需要登录的 API 路由 + 4 条公开路由（探针、会话、登录、登出）。
///
/// 认证中间件只挂在「需要登录」的那一组上：`/api/health` 必须匿名可用（否则容器探针和
/// `--healthcheck` 会一直失败），而 `/api/session` 正是前端启动时用来判断「要不要弹登录框」
/// 的接口，它自己不可能要求已登录。
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/status", get(status::api_status))
        .route(
            "/api/settings",
            get(status::get_settings).put(status::put_settings),
        )
        .route("/api/sources", get(status::api_sources))
        .route("/api/tracks", get(tracks::list_tracks))
        .route("/api/tracks/preview", post(tracks::preview))
        .route("/api/tracks/apply", post(tracks::apply))
        .route("/api/tracks/:track_id", get(tracks::detail))
        .route("/api/tracks/:track_id/cover", get(tracks::cover))
        .route("/api/search", post(scrape::search))
        .route("/api/scrape/apply", post(scrape::apply))
        .route("/api/scrape/batch", post(scrape::batch))
        .route("/api/move/preview", post(moves::move_preview))
        .route("/api/move/plan/:token", get(moves::move_plan))
        .route("/api/move/execute", post(moves::move_execute))
        .route("/api/jobs", get(moves::list_jobs))
        .route("/api/jobs/:job_id", get(moves::get_job))
        .route("/api/scan", post(moves::scan))
        .route(
            "/api/aliases/:kind",
            get(tracks::get_aliases).put(tracks::put_aliases),
        )
        .route("/api/template/test", get(moves::template_test))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_auth,
        ));

    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/session", get(crate::auth::session_info))
        .route("/api/login", post(crate::auth::login))
        .route("/api/logout", post(crate::auth::logout))
        .merge(protected)
        .with_state(state)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_all_python_keys() {
        let keys: Vec<&str> = user_setting_defaults().into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys.len(), 11);
        assert_eq!(
            keys,
            vec![
                "dir_template",
                "filename_template",
                "conflict_policy",
                "unknown_artist",
                "unknown_album",
                "unknown_other",
                "normalize_artist_ampersand",
                "enabled_sources",
                "write_cover",
                "write_lyrics",
                "overwrite_existing",
            ]
        );
        assert_eq!(TEMPLATE_PLACEHOLDERS.len(), 14);
        assert_eq!(placeholder_keys()[0], "artist");
        assert_eq!(placeholder_keys()[13], "original");
    }

    #[test]
    fn json_body_may_be_empty_but_not_an_array() {
        assert!(parse_body(&Bytes::new()).unwrap().is_empty());
        let err = parse_body(&Bytes::from_static(b"[1,2]")).unwrap_err();
        match err {
            ApiError::Unprocessable(detail) => {
                assert_eq!(detail[0]["type"], "dict_type");
                assert_eq!(detail[0]["loc"][0], "body");
            }
            other => panic!("应为 422：{other:?}"),
        }
    }

    #[test]
    fn bool_parsing_accepts_frontend_and_python_forms() {
        let body = json!({"a": true, "b": "1", "c": "0", "d": null, "e": 1});
        let map = body.as_object().unwrap().clone();
        assert!(body_bool(&map, "a", false).unwrap());
        assert!(body_bool(&map, "b", false).unwrap());
        assert!(!body_bool(&map, "c", true).unwrap());
        assert!(!body_bool(&map, "d", false).unwrap());
        assert!(body_bool(&map, "e", false).unwrap());
        assert!(!body_bool(&map, "missing", false).unwrap());
        let bad = json!({"a": "maybe"}).as_object().unwrap().clone();
        assert!(body_bool(&bad, "a", false).is_err());
    }

    #[test]
    fn py_str_matches_python_str_of_null() {
        assert_eq!(py_str(&Value::Null), "None");
        assert_eq!(py_str(&json!("x")), "x");
        assert_eq!(py_str(&json!(12)), "12");
        assert_eq!(py_str(&json!(true)), "True");
    }

    #[test]
    fn prepare_fields_filters_and_normalizes() {
        let mut raw = HashMap::new();
        raw.insert("artist".to_string(), "周杰伦/费玉清".to_string());
        raw.insert("album".to_string(), "七里香".to_string());
        raw.insert("path".to_string(), "不该被接受".to_string());
        let clean = prepare_fields(&raw, true);
        assert_eq!(clean.get("artist").unwrap(), "周杰伦 & 费玉清");
        assert_eq!(clean.get("album").unwrap(), "七里香");
        assert!(!clean.contains_key("path"));
        let untouched = prepare_fields(&raw, false);
        assert_eq!(untouched.get("artist").unwrap(), "周杰伦/费玉清");
    }

    #[test]
    fn apply_aliases_only_replaces_main_artist() {
        let mut fields = HashMap::new();
        fields.insert("artist".to_string(), "周杰伦 & 费玉清".to_string());
        fields.insert("album".to_string(), "七里香".to_string());
        fields.insert("albumartist".to_string(), "周杰伦".to_string());
        let mut artists = HashMap::new();
        artists.insert("周杰伦".to_string(), "Jay Chou".to_string());
        let mut albums = HashMap::new();
        albums.insert("七里香".to_string(), "Common Jasmine Orange".to_string());
        let out = apply_aliases(&fields, &artists, &albums);
        assert_eq!(out.get("artist").unwrap(), "Jay Chou & 费玉清");
        assert_eq!(out.get("albumartist").unwrap(), "Jay Chou");
        assert_eq!(out.get("album").unwrap(), "Common Jasmine Orange");
    }

    #[test]
    fn light_track_json_has_python_keys_and_int_flags() {
        let track = Track {
            id: 7,
            path: "D:\\lib\\a.flac".into(),
            filename: "a.flac".into(),
            title: "稻香".into(),
            has_cover: true,
            ..Default::default()
        };
        let json = light_track_json(&track);
        for key in [
            "id", "path", "dir", "filename", "ext", "title", "artist", "album", "albumartist",
            "genre", "year", "track", "disc", "language", "albumtype", "has_cover", "has_lyrics",
            "duration", "indexed_at", "edited_at", "scraped_at", "mtime", "size",
            "tags_loaded", "path_derived",
        ] {
            assert!(json.get(key).is_some(), "缺少键 {key}");
        }
        assert_eq!(json["has_cover"], json!(1));
        assert_eq!(json["has_lyrics"], json!(0));
        assert_eq!(json["indexed_at"], json!(0.0));
        // light 投影不该出现重字段
        assert!(json.get("composer").is_none());
    }
}
