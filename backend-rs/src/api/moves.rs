//! 整理移动、任务、扫描、模板试渲染。
//!
//! 「先预览、后确认」的落地点：
//! - `/api/move/preview`：只算不动，计划全量落 `move_plans`（token = 32 位 hex）
//! - `/api/move/execute`：`dry_run=true` 同步返回汇总；否则起后台任务，同一 token
//!   再次非 dry_run 提交 → **409**（e2e 断言的那条）
//! - 任务进度：Postgres 落行 + Redis 存实时值；完成时强制 `done == total`（percent=100.0）

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde_json::{json, Map, Value};
use sqlx::types::Json as SqlJson;
use crate::jobs::{JobPatch, JobStore, Progress, ProgressEvent};
use crate::mover::{self, MovePlan, PlanOptions};
use crate::repo::{self, TrackQuery};
use crate::templates;
use crate::AppState;

use super::status::effective_settings;
use super::tracks::fetch_by_ids;
use super::{
    body_bool, body_i64, body_ids, body_map, body_str, library_root, parse_body, py_str, ApiError,
    ApiResult, RawQuery, PREVIEW_DISPLAY_LIMIT,
};


/// `POST /api/move/preview`
pub async fn move_preview(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let ids = body_ids(&payload, "ids")?;
    let filters = body_map(&payload, "filters")?;

    let mut rows: Vec<crate::models::Track> = if !ids.is_empty() {
        // 给了 ids 就忽略 filters（Python：`payload.ids or None` 优先）
        let map = fetch_by_ids(&state, &ids).await?;
        ids.iter().filter_map(|id| map.get(id).cloned()).collect()
    } else {
        let filter_ids = match filters.get("ids") {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
                .collect::<Vec<i64>>(),
            _ => Vec::new(),
        };
        let query = TrackQuery {
            q: String::new(),
            page: 1,
            page_size: 1000,
            sort: "artist".to_string(),
            order_desc: false,
            language: filter_text(&filters, "language"),
            albumtype: filter_text(&filters, "albumtype"),
            genre: filter_text(&filters, "genre"),
            year: filter_text(&filters, "year"),
            artist: filter_text(&filters, "artist"),
            album: filter_text(&filters, "album"),
            missing_cover: filter_bool(&filters, "missing_cover"),
            missing_lyrics: filter_bool(&filters, "missing_lyrics"),
            no_artist: filter_bool(&filters, "no_artist"),
            no_album: filter_bool(&filters, "no_album"),
            not_loaded: false,
            ids: filter_ids,
        };
        fetch_all(&state, &query).await?
    };
    if rows.is_empty() {
        return Err(ApiError::bad_request("没有匹配到曲目"));
    }

    let settings = effective_settings(&state).await;
    let dir_template = super::body_str(&payload, "dir_template", "")
        .trim()
        .to_string();
    let dir_template = if dir_template.is_empty() {
        setting_text(&settings, "dir_template")
            .unwrap_or_else(|| crate::templates::DEFAULT_DIR_TEMPLATE.to_string())
    } else {
        dir_template
    };
    let filename_template = super::body_str(&payload, "filename_template", "")
        .trim()
        .to_string();
    let filename_template = if filename_template.is_empty() {
        setting_text(&settings, "filename_template")
            .unwrap_or_else(|| crate::templates::DEFAULT_FILENAME_TEMPLATE.to_string())
    } else {
        filename_template
    };
    let conflict_policy = super::body_str(&payload, "conflict_policy", "")
        .trim()
        .to_string();
    let conflict_policy = if conflict_policy.is_empty() {
        setting_text(&settings, "conflict_policy").unwrap_or_else(|| "rename".to_string())
    } else {
        conflict_policy
    };
    let unknown_artist = setting_text(&settings, "unknown_artist").unwrap_or_else(|| "未知艺术家".to_string());
    let unknown_album = setting_text(&settings, "unknown_album").unwrap_or_else(|| "未知专辑".to_string());
    let unknown_other = setting_text(&settings, "unknown_other").unwrap_or_else(|| "未知".to_string());

    let limit = match payload.get("limit") {
        None | Some(Value::Null) => None,
        Some(_) => Some(super::body_i64(&payload, "limit", 0)?.max(0) as usize),
    };
    // `total` 是「匹配到的曲目总数」，`planned` 才是截断后的计划条数（两个概念，别合并）
    let total = rows.len();
    let mut truncated = false;
    if let Some(limit) = limit {
        if total > limit {
            truncated = true;
            rows.truncate(limit);
        }
    }

    let root = library_root(&state.db, &state.config).await?;
    let plan = mover::plan_moves(
        &rows,
        &PlanOptions {
            library_root: Path::new(&root),
            dir_template: &dir_template,
            filename_template: &filename_template,
            conflict_policy: &conflict_policy,
            unknown_artist: &unknown_artist,
            unknown_album: &unknown_album,
            unknown_other: &unknown_other,
        },
    );

    let token = uuid::Uuid::new_v4().simple().to_string();
    let stored = plan_to_json(&plan, total, truncated);
    save_plan(&state, &token, &stored).await?;

    let mut display = stored;
    let item_count = display["items"].as_array().map(|a| a.len()).unwrap_or(0);
    let display_truncated = item_count > PREVIEW_DISPLAY_LIMIT;
    if display_truncated {
        if let Some(items) = display["items"].as_array_mut() {
            items.truncate(PREVIEW_DISPLAY_LIMIT);
        }
    }
    display["token"] = json!(token);
    display["display_truncated"] = json!(display_truncated);
    display["template_warnings"] = json!(super::status::template_warnings(&dir_template));
    Ok(Json(display))
}

/// `/api/move/plan/{token}`
pub async fn move_plan(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
) -> ApiResult {
    match load_plan(&state, &token).await? {
        Some((payload, executed)) => {
            let mut plan = payload;
            plan["_executed"] = json!(executed);
            plan["_token"] = json!(token);
            Ok(Json(plan))
        }
        None => Err(ApiError::not_found("计划不存在或已过期")),
    }
}

/// `POST /api/move/execute`
pub async fn move_execute(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    if payload.get("token").is_none() {
        return Err(ApiError::unprocessable(
            "missing",
            vec!["body", "token"],
            "Field required",
            Value::Null,
            None,
        ));
    }
    let token = body_str(&payload, "token", "");
    let dry_run = body_bool(&payload, "dry_run", false)?;

    let Some((payload, executed)) = load_plan(&state, &token).await? else {
        return Err(ApiError::not_found("计划不存在，请重新预览"));
    };
    if executed && !dry_run {
        return Err(ApiError::conflict("这个计划已经执行过了，请重新预览"));
    }

    let plan = plan_from_json(&payload);
    if dry_run {
        let summary = mover::execute_plan(&plan, true, |_, _, _| {});
        return Ok(Json(summary_json(&summary)));
    }

    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job_id = store.create("move").await?;
    let job_state = state.clone();
    let job_store = store.clone();
    let job_id_for_task = job_id.clone();
    let token_for_task = token.clone();
    tokio::spawn(async move {
        run_move(job_state, job_store, job_id_for_task, plan, token_for_task).await;
    });
    Ok(Json(json!({ "job_id": job_id })))
}

/// 移动任务体：执行 → 同步索引 → 标记计划已执行 → 写结果。
async fn run_move(
    state: AppState,
    store: JobStore,
    job_id: String,
    plan: MovePlan,
    token: String,
) {
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

    // 任务总数 = 可移动项（in_place / conflict_skip / invalid 不算）
    let movable = plan
        .items
        .iter()
        .filter(|item| {
            !matches!(
                item.action.as_str(),
                "in_place" | "conflict_skip" | "invalid"
            )
        })
        .count();
    progress.set_total(movable as i64).await;

    let (tx, rx) = crate::jobs::progress_channel();
    let drain = crate::jobs::spawn_progress_drain(progress, rx);
    let plan_for_task = plan.clone();
    let summary = tokio::task::spawn_blocking(move || {
        mover::execute_plan(&plan_for_task, false, |_done, _total, name| {
            let _ = tx.send(ProgressEvent::Step(1, Some(name)));
        })
    })
    .await;
    let mut progress = drain.await.unwrap_or_else(|_| Progress::new(store.clone(), job_id.clone()));

    match summary {
        Ok(summary) => {
            // 索引同步失败只吞掉，不影响「文件已经移动」这个事实（与 Python 一致）
            for (track_id, new_path) in &summary.moved_paths {
                if let Err(err) = repo::set_track_path(&state.db, *track_id, new_path).await {
                    tracing::warn!("移动后同步索引失败：{err}");
                }
            }
            if let Err(err) = sqlx::query("UPDATE move_plans SET executed = TRUE WHERE token = $1")
                .bind(&token)
                .execute(&state.db)
                .await
            {
                tracing::warn!("标记计划已执行失败：{err}");
            }
            progress.finish(Some(summary_json(&summary))).await;
        }
        Err(err) => {
            progress.fail("RuntimeError", &err.to_string()).await;
        }
    }
}

/// `/api/jobs/{job_id}`
pub async fn get_job(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
) -> ApiResult {
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    match store.get(&job_id).await? {
        Some(row) => Ok(Json(row.json(true))),
        None => Err(ApiError::not_found("任务不存在")),
    }
}

/// `/api/jobs`（最近 20 条，不带 percent）
pub async fn list_jobs(State(state): State<AppState>) -> ApiResult {
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let rows = store.list(20).await?;
    let jobs: Vec<Value> = rows.iter().map(|row| row.json(false)).collect();
    Ok(Json(json!({ "jobs": jobs })))
}

/// `POST /api/scan`（请求体可整体缺省）
pub async fn scan(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let full = body_bool(&payload, "full", false)?;
    let prune = body_bool(&payload, "prune", true)?;
    // Rust 扩展：`fast` 只建索引不打开文件（Python 没有这个开关）
    let fast = body_bool(&payload, "fast", false)?;
    let root = body_str(&payload, "root", "").trim().to_string();
    let root = if root.is_empty() {
        state.config.music_dir.clone()
    } else {
        PathBuf::from(root)
    };
    let workers = match payload.get("workers") {
        None | Some(Value::Null) => state.config.scan_workers,
        Some(_) => body_i64(&payload, "workers", state.config.scan_workers as i64)?.max(1) as usize,
    };

    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job_id = store.create("scan").await?;
    let job_state = state.clone();
    let job_store = store.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        run_scan(job_state, job_store, job_id_for_task, root, full, prune, fast, workers).await;
    });
    Ok(Json(json!({ "job_id": job_id })))
}

/// 扫描任务体（音乐目录不存在时：接口仍是 200 + job_id，错误落在任务里）。
#[allow(clippy::too_many_arguments)]
async fn run_scan(
    state: AppState,
    store: JobStore,
    job_id: String,
    root: PathBuf,
    full: bool,
    prune: bool,
    fast: bool,
    workers: usize,
) {
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
    if !root.exists() {
        progress
            .fail(
                "FileNotFoundError",
                &format!("音乐目录不存在：{}", root.display()),
            )
            .await;
        return;
    }

    progress.note(format!("枚举 {} …", root.display())).await;
    let options = crate::scanner::ScanOptions {
        root: root.clone(),
        full,
        prune,
        fast,
        workers: workers.max(1),
    };
    let (tx, rx) = crate::jobs::progress_channel();
    let drain = crate::jobs::spawn_progress_drain(progress, rx);
    let result = crate::scanner::scan(&state.db, &options, move |done, total, message| {
        let _ = tx.send(ProgressEvent::Set {
            done: done as i64,
            total: total as i64,
            message,
        });
    })
    .await;
    let mut progress = drain.await.unwrap_or_else(|_| Progress::new(store.clone(), job_id.clone()));

    match result {
        Ok(summary) => {
            progress
                .finish(Some(json!({
                    "root": summary.root,
                    "scanned": summary.scanned,
                    "parsed": summary.parsed,
                    "skipped": summary.skipped,
                    "added": summary.added,
                    "updated": summary.updated,
                    "removed": summary.removed,
                    "failed": summary.failed,
                    // Python 的 `seconds` 是「解析耗时」，这里再附一个总耗时
                    "seconds": (summary.parse_seconds * 100.0).round() / 100.0,
                    "total_seconds": (summary.seconds * 100.0).round() / 100.0,
                    "fast_mode": summary.fast_mode,
                    "errors": summary.errors,
                })))
                .await;
        }
        Err(err) => progress.fail("RuntimeError", &err.to_string()).await,
    }
}

/// `GET /api/template/test`
pub async fn template_test(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let dir_template = query.str("dir_template", crate::templates::DEFAULT_DIR_TEMPLATE);
    let filename_template =
        query.str("filename_template", crate::templates::DEFAULT_FILENAME_TEMPLATE);
    let track_id = match query.opt_str("track_id") {
        Some(raw) => Some(super::path_i64(&raw, "track_id")?),
        None => None,
    };

    let track = match track_id {
        Some(id) => repo::get_track(&state.db, id).await?,
        None => {
            // 不传 track_id 时取列表第一条（默认排序 artist asc）
            repo::list_tracks(
                &state.db,
                &TrackQuery {
                    page_size: 1,
                    ..Default::default()
                },
            )
            .await?
            .items
            .into_iter()
            .next()
        }
    };
    let Some(track) = track else {
        return Err(ApiError::not_found("索引里还没有曲目，先扫描一次"));
    };

    let settings = effective_settings(&state).await;
    // 注意：这里与 Python 一样用 `str(...)`（不是 `or` 兜底），设置被写成 null 时会得到 "None"
    let unknown_artist = py_str(settings.get("unknown_artist").unwrap_or(&Value::Null));
    let unknown_album = py_str(settings.get("unknown_album").unwrap_or(&Value::Null));
    let unknown_other = py_str(settings.get("unknown_other").unwrap_or(&Value::Null));
    let root = library_root(&state.db, &state.config).await?;
    let target = templates::target_path(
        &track,
        Path::new(&root),
        &dir_template,
        &filename_template,
        &unknown_artist,
        &unknown_album,
        &unknown_other,
    );

    Ok(Json(json!({
        "track": {
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
        },
        "source": track.path,
        "target": target.to_string_lossy(),
        "warnings": super::status::template_warnings(&dir_template),
    })))
}

// --------------------------------------------------------------------------- 内部工具

/// 分页取回全部匹配曲目（`list_tracks` 单页上限 1000，这里翻页拼完）。
async fn fetch_all(state: &AppState, query: &TrackQuery) -> Result<Vec<crate::models::Track>, ApiError> {
    let mut all: Vec<crate::models::Track> = Vec::new();
    let mut page = 1i64;
    loop {
        let mut q = query.clone();
        q.page = page;
        q.page_size = 1000;
        let result = repo::list_tracks(&state.db, &q).await?;
        let fetched = result.items.len();
        all.extend(result.items);
        if fetched == 0 || all.len() as i64 >= result.total || page > 1000 {
            break;
        }
        page += 1;
    }
    Ok(all)
}

fn filter_text(filters: &Map<String, Value>, key: &str) -> String {
    match filters.get(key) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn filter_bool(filters: &Map<String, Value>, key: &str) -> bool {
    match filters.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(false),
        _ => false,
    }
}

/// 设置里的非空字符串（空串/`null`/缺省都当没有）。
fn setting_text(settings: &Map<String, Value>, key: &str) -> Option<String> {
    match settings.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// 计划 → JSON（落库与响应共用；`total`/`truncated` 由调用方给）。
fn plan_to_json(plan: &MovePlan, total: usize, truncated: bool) -> Value {
    json!({
        "library_root": plan.library_root,
        "dir_template": plan.dir_template,
        "filename_template": plan.filename_template,
        "conflict_policy": plan.conflict_policy,
        "total": total,
        "planned": plan.planned,
        "truncated": truncated,
        "counts": plan.counts,
        "items": plan.items,
    })
}

/// 执行汇总 → JSON（`failures` 是明细，`moved_paths` 不对外）。
fn summary_json(summary: &mover::MoveSummary) -> Value {
    json!({
        "moved": summary.moved,
        "skipped": summary.skipped,
        "failed": summary.failed,
        "renamed": summary.renamed,
        "failures": summary.failures,
    })
}

/// JSON → `MovePlan`（token 计划落库后要能还原成执行器认的结构）。
fn plan_from_json(value: &Value) -> MovePlan {
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| mover::MoveItem {
                    track_id: item.get("track_id").and_then(|v| v.as_i64()).unwrap_or(0),
                    source: text_of(item, "source"),
                    target: text_of(item, "target"),
                    action: text_of(item, "action"),
                    reason: text_of(item, "reason"),
                    filename: text_of(item, "filename"),
                    artist: text_of(item, "artist"),
                    title: text_of(item, "title"),
                    warning: text_of(item, "warning"),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut counts: HashMap<String, usize> = HashMap::new();
    if let Some(map) = value.get("counts").and_then(|v| v.as_object()) {
        for (key, count) in map {
            counts.insert(key.clone(), count.as_u64().unwrap_or(0) as usize);
        }
    }
    MovePlan {
        library_root: text_of(value, "library_root"),
        dir_template: text_of(value, "dir_template"),
        filename_template: text_of(value, "filename_template"),
        conflict_policy: text_of(value, "conflict_policy"),
        total: value.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        planned: value.get("planned").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        counts,
        items,
    }
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(super::v_text)
        .unwrap_or_default()
}

/// 计划落库（JSONB）。
async fn save_plan(state: &AppState, token: &str, payload: &Value) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO move_plans (token, payload, executed) VALUES ($1, $2, FALSE)
         ON CONFLICT (token) DO UPDATE SET payload = EXCLUDED.payload, executed = FALSE,
             created_at = now()",
    )
    .bind(token)
    .bind(SqlJson(payload))
    .execute(&state.db)
    .await?;
    Ok(())
}

/// 读计划（payload + 是否已执行）。
async fn load_plan(state: &AppState, token: &str) -> anyhow::Result<Option<(Value, bool)>> {
    if token.trim().is_empty() {
        return Ok(None);
    }
    let row: Option<(SqlJson<Value>, bool)> =
        sqlx::query_as("SELECT payload, executed FROM move_plans WHERE token = $1")
            .bind(token)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(payload, executed)| (payload.0, executed)))
}

