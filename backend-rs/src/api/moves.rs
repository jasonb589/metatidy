//! 整理移动、任务、扫描、模板试渲染。
//!
//! 「先预览、后确认」的落地点：
//! - `/api/move/preview`：只算不动，计划全量落 `move_plans`（token = 32 位 hex）
//! - `/api/move/execute`：`dry_run=true` 同步返回汇总；否则起后台任务，同一 token
//!   再次非 dry_run 提交 → **409**（e2e 断言的那条）
//! - 任务进度：Postgres 落行 + Redis 存实时值；完成时强制 `done == total`（percent=100.0）

use std::collections::{HashMap, HashSet};
use std::path::Path;

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};
use sqlx::types::Json as SqlJson;
use crate::jobs::{JobHistoryQuery, JobStore, Progress, ProgressEvent};
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
        fetch_selected(&state, &ids).await?
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
            album_group: None,
            folder: None,
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

/// Filter the stored complete plan, not the first 500 preview rows. No audio
/// files are accessed by browsing or exporting a plan snapshot.
pub async fn move_plan_items(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let filter = PlanFilter::parse(&query)?;
    let page_size = query.i64("page_size", 100)?;
    if !(1..=200).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            "每页计划条数须为 1–200",
            json!(page_size),
            Some(json!({"ge": 1, "le": 200})),
        ));
    }
    let requested_page = query.i64("page", 1)?;
    let report = query_plan(&state, &token, &filter, Some((requested_page, page_size))).await?;
    Ok(Json(report))
}

/// Download a plan snapshot only. The file makes no claim about actual moves.
pub async fn move_plan_export(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let query = RawQuery(params);
    let filter = PlanFilter::parse(&query)?;
    let format = query.str("format", "csv");
    if !matches!(format.as_str(), "csv" | "json") {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "format"],
            "报告格式须为 csv 或 json",
            json!(format),
            None,
        ));
    }
    let mut report = query_plan(&state, &token, &filter, None).await?;
    report["report_type"] = json!("move_plan");
    report["report_scope"] = json!(if filter.q.is_empty() && filter.action.is_empty() {
        "complete"
    } else {
        "filtered"
    });
    let (mime, content) = if format == "csv" {
        ("text/csv; charset=utf-8", plan_csv(&report).into_bytes())
    } else {
        (
            "application/json; charset=utf-8",
            serde_json::to_vec_pretty(&report).map_err(anyhow::Error::from)?,
        )
    };
    let safe_token: String = token
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(64)
        .collect();
    let disposition = HeaderValue::from_str(&format!(
        "attachment; filename=\"metatidy-move-plan-{safe_token}.{format}\""
    ))
    .map_err(anyhow::Error::from)?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(mime)),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        content,
    )
        .into_response())
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

    if dry_run {
        let Some((payload, _)) = load_plan(&state, &token).await? else {
            return Err(ApiError::not_found("计划不存在，请重新预览"));
        };
        let plan = plan_from_json(&payload);
        let summary = mover::execute_plan(&plan, true, |_, _, _| {});
        return Ok(Json(summary_json(&summary)));
    }

    // Claim and job creation either both commit or both roll back. Concurrent
    // requests cannot start a second worker while the first one is queued.
    let (payload, job_id) = claim_plan_and_create_job(&state, &token).await?;
    let plan = plan_from_json(&payload);
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job_state = state.clone();
    let job_store = store.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        run_move(job_state, job_store, job_id_for_task, plan).await;
    });
    Ok(Json(json!({ "job_id": job_id })))
}

/// 移动任务体：执行 → 同步索引 → 写结果。计划已在创建任务时原子领取。
async fn run_move(
    state: AppState,
    store: JobStore,
    job_id: String,
    plan: MovePlan,
) {
    let mut progress = Progress::new(store.clone(), job_id.clone());
    let Some(_slot) = JobStore::acquire_slot().await else {
        progress.fail("TimeoutError", "等待其它任务超时").await;
        return;
    };
    progress.note("等待扫描或整理任务完成…").await;
    // Hold through filesystem moves AND the final path updates. Otherwise a
    // watcher could index a destination first and make set_track_path collide.
    let _library_guard = crate::scanner::lock_library_scan().await;
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

/// Keep the recent 20 records for existing clients; global activity and watch
/// completion are independent of whichever history page the user is viewing.
pub async fn list_jobs(State(state): State<AppState>) -> ApiResult {
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let rows = store.list(20).await?;
    let jobs: Vec<Value> = rows.iter().map(|row| row.json(false)).collect();
    let mut result = store.overview().await?;
    result["jobs"] = json!(jobs);
    Ok(Json(result))
}

pub async fn job_history(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = parse_job_history_query(&RawQuery(params))?;
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    Ok(Json(store.history(&query).await?))
}

pub async fn job_report(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let query = RawQuery(params);
    let format = query.str("format", "json");
    if format != "json" {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "format"],
            "任务结果报告格式须为 json",
            json!(format),
            None,
        ));
    }
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job = store
        .get(&job_id)
        .await?
        .ok_or_else(|| ApiError::not_found("任务不存在"))?;
    let content = serde_json::to_vec_pretty(&job.report()).map_err(anyhow::Error::from)?;
    let disposition = HeaderValue::from_str(&format!(
        "attachment; filename=\"metatidy-job-{}.json\"",
        job.id,
    ))
    .map_err(anyhow::Error::from)?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            ),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        content,
    )
        .into_response())
}

fn parse_job_history_query(query: &RawQuery) -> Result<JobHistoryQuery, ApiError> {
    let q = query.str("q", "").trim().to_string();
    if q.chars().count() > 500 {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "q"],
            "任务搜索最多 500 字",
            json!(q),
            Some(json!({"max_length": 500})),
        ));
    }
    let kind = query.str("kind", "").trim().to_string();
    if !matches!(kind.as_str(), "" | "scan" | "scrape" | "move" | "filename_tags") {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "kind"],
            "未知的任务类型",
            json!(kind),
            None,
        ));
    }
    let state = query.str("state", "").trim().to_string();
    if !matches!(state.as_str(), "" | "running" | "done" | "error") {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "state"],
            "未知的任务状态",
            json!(state),
            None,
        ));
    }
    let page_size = query.i64("page_size", 20)?;
    if !(1..=100).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            "每页任务数须为 1–100",
            json!(page_size),
            Some(json!({"ge": 1, "le": 100})),
        ));
    }
    Ok(JobHistoryQuery {
        q,
        kind,
        state,
        page: query.i64("page", 1)?,
        page_size,
    })
}

/// `POST /api/scan`（请求体可整体缺省）
pub async fn scan(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = parse_body(&body)?;
    let full = body_bool(&payload, "full", false)?;
    let prune = body_bool(&payload, "prune", true)?;
    // Rust 扩展：`fast` 只建索引不打开文件（Python 没有这个开关）
    let fast = body_bool(&payload, "fast", false)?;
    // 「只扫这个子目录」：留空 = 整个库；相对路径按库根解析；越界直接 400。
    // 有了它，新增几张专辑时不用把整个库再走一遍（云盘上遍历目录才是慢的那一步）。
    let root = body_str(&payload, "root", "").trim().to_string();
    let root = crate::scanner::resolve_scan_root(&state.config.music_dir, &root)
        .map_err(ApiError::bad_request)?;
    let workers = match payload.get("workers") {
        None | Some(Value::Null) => state.config.scan_workers,
        Some(_) => body_i64(&payload, "workers", state.config.scan_workers as i64)?.max(1) as usize,
    };

    let options = crate::scanner::ScanOptions {
        root,
        full,
        prune,
        fast,
        workers: workers.max(1),
    };
    let job_id = start_scan_job(state, options, false).await?;
    Ok(Json(json!({ "job_id": job_id })))
}

/// Manual and automatic scans use the same persisted job and progress path.
pub(crate) async fn start_scan_job(
    state: AppState,
    mut options: crate::scanner::ScanOptions,
    automatic: bool,
) -> Result<String, ApiError> {
    if automatic {
        options.full = false;
        options.prune = false;
    }
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let job_id = store.create("scan").await?;
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        run_scan(state, store, job_id_for_task, options, automatic).await;
    });
    Ok(job_id)
}

/// 扫描任务体（音乐目录不存在时：接口仍是 200 + job_id，错误落在任务里）。
async fn run_scan(
    state: AppState,
    store: JobStore,
    job_id: String,
    options: crate::scanner::ScanOptions,
    automatic: bool,
) {
    let mut progress = Progress::new(store.clone(), job_id.clone());
    progress
        .note(if automatic { "自动增量扫描已排队" } else { "扫描已排队" })
        .await;
    let (tx, rx) = crate::jobs::progress_channel();
    let drain = crate::jobs::spawn_progress_drain(progress, rx);
    let result = crate::scanner::scan_with_library_root(
        &state.db,
        &options,
        &state.config.music_dir,
        move |done, total, message| {
            let _ = tx.send(ProgressEvent::Set {
                done: done as i64,
                total: total as i64,
                message,
            });
        },
    )
    .await;
    let mut progress = drain.await.unwrap_or_else(|_| Progress::new(store.clone(), job_id.clone()));

    match result {
        Ok(summary) => {
            progress
                .finish(Some(json!({
                    "trigger": if automatic { "watch" } else { "manual" },
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

const PLAN_ACTIONS: [&str; 6] = [
    "move",
    "in_place",
    "conflict_rename",
    "conflict_skip",
    "conflict_overwrite",
    "invalid",
];

struct PlanFilter {
    q: String,
    action: String,
}

impl PlanFilter {
    fn parse(query: &RawQuery) -> Result<Self, ApiError> {
        let q = query.str("q", "").trim().to_string();
        if q.chars().count() > 500 {
            return Err(ApiError::unprocessable(
                "value_error",
                vec!["query", "q"],
                "计划搜索最多 500 字",
                json!(q),
                Some(json!({"max_length": 500})),
            ));
        }
        let action = query.str("action", "").trim().to_string();
        if !action.is_empty() && !PLAN_ACTIONS.contains(&action.as_str()) {
            return Err(ApiError::unprocessable(
                "value_error",
                vec!["query", "action"],
                "未知的计划动作筛选",
                json!(action),
                None,
            ));
        }
        Ok(Self { q, action })
    }

    fn pattern(&self) -> String {
        format!(
            "%{}%",
            self.q
                .replace('!', "!!")
                .replace('%', "!%")
                .replace('_', "!_")
        )
    }
}

// $1=token, $2=literal search pattern, $3=action. Every searchable field is
// evaluated on the complete JSONB array before LIMIT, preserving its ordinal.
const PLAN_ROWS_SQL: &str = "FROM move_plans AS plan \
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(plan.payload->'items', '[]'::jsonb)) \
        WITH ORDINALITY AS plan_item(item, ordinal) \
    WHERE plan.token = $1 AND ($3 = '' OR plan_item.item->>'action' = $3) AND (\
        COALESCE(plan_item.item->>'source', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'target', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'filename', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'title', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'artist', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'reason', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'warning', '') ILIKE $2 ESCAPE '!' OR \
        COALESCE(plan_item.item->>'track_id', '') ILIKE $2 ESCAPE '!')";

fn plan_page(total: i64, requested: i64, page_size: i64) -> (i64, i64, i64) {
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / page_size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    (page, pages, (page - 1) * page_size)
}

async fn query_plan(
    state: &AppState,
    token: &str,
    filter: &PlanFilter,
    pagination: Option<(i64, i64)>,
) -> Result<Value, ApiError> {
    let mut transaction = state.db.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(anyhow::Error::from)?;
    let header: Option<(SqlJson<Value>, bool)> =
        sqlx::query_as("SELECT payload - 'items', executed FROM move_plans WHERE token = $1")
            .bind(token)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(anyhow::Error::from)?;
    let Some((SqlJson(mut result), executed)) = header else {
        return Err(ApiError::not_found("计划不存在，请重新预览"));
    };
    let pattern = filter.pattern();
    let count_sql = format!("SELECT count(*) {PLAN_ROWS_SQL}");
    let filtered_total: i64 = sqlx::query_scalar(&count_sql)
        .bind(token)
        .bind(&pattern)
        .bind(&filter.action)
        .fetch_one(&mut *transaction)
        .await
        .map_err(anyhow::Error::from)?;
    let base = format!(
        "SELECT plan_item.item || jsonb_build_object('ordinal', plan_item.ordinal) \
        {PLAN_ROWS_SQL} ORDER BY plan_item.ordinal"
    );
    let items: Vec<SqlJson<Value>> = if let Some((requested, page_size)) = pagination {
        let (page, pages, offset) = plan_page(filtered_total, requested, page_size);
        result["page"] = json!(page);
        result["page_size"] = json!(page_size);
        result["pages"] = json!(pages);
        sqlx::query_scalar(&format!("{base} LIMIT $4 OFFSET $5"))
            .bind(token)
            .bind(&pattern)
            .bind(&filter.action)
            .bind(page_size)
            .bind(offset)
            .fetch_all(&mut *transaction)
            .await
            .map_err(anyhow::Error::from)?
    } else {
        sqlx::query_scalar(&base)
            .bind(token)
            .bind(&pattern)
            .bind(&filter.action)
            .fetch_all(&mut *transaction)
            .await
            .map_err(anyhow::Error::from)?
    };
    transaction.commit().await.map_err(anyhow::Error::from)?;
    result["token"] = json!(token);
    result["executed"] = json!(executed);
    result["q"] = json!(filter.q);
    result["action"] = json!(filter.action);
    result["filtered_total"] = json!(filtered_total);
    result["items"] = Value::Array(items.into_iter().map(|item| item.0).collect());
    Ok(result)
}

/// Quote all cells and neutralize formula prefixes, including leading spaces
/// and control characters. The JSON report keeps exact original tag values.
fn csv_cell(value: &str) -> String {
    let trimmed = value
        .trim_start_matches(|ch: char| ch.is_whitespace() || ch.is_control() || ch == '\u{feff}');
    let dangerous = trimmed.starts_with(['=', '+', '-', '@'])
        || value
            .chars()
            .take_while(|ch| ch.is_whitespace() || ch.is_control() || *ch == '\u{feff}')
            .any(|ch| matches!(ch, '\t' | '\r' | '\n'));
    let safe = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

fn plan_csv(report: &Value) -> String {
    const FIELDS: [&str; 10] = [
        "ordinal", "track_id", "source", "target", "action", "reason", "filename", "artist",
        "title", "warning",
    ];
    let mut output = String::from("\u{feff}report_type,plan_token,ordinal,track_id,source,target,action,reason,filename,artist,title,warning\r\n");
    if let Some(items) = report["items"].as_array() {
        for item in items {
            let mut cells = vec![csv_cell("move_plan"), csv_cell(&text_of(report, "token"))];
            cells.extend(FIELDS.iter().map(|field| csv_cell(&text_of(item, field))));
            output.push_str(&cells.join(","));
            output.push_str("\r\n");
        }
    }
    output
}

async fn claim_plan_and_create_job(
    state: &AppState,
    token: &str,
) -> Result<(Value, String), ApiError> {
    let mut transaction = state.db.begin().await.map_err(anyhow::Error::from)?;
    let payload: Option<SqlJson<Value>> = sqlx::query_scalar(
        "UPDATE move_plans SET executed = TRUE WHERE token = $1 AND executed = FALSE RETURNING payload",
    ).bind(token).fetch_optional(&mut *transaction).await.map_err(anyhow::Error::from)?;
    let Some(SqlJson(payload)) = payload else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM move_plans WHERE token = $1)")
                .bind(token)
                .fetch_one(&mut *transaction)
                .await
                .map_err(anyhow::Error::from)?;
        return Err(if exists {
            ApiError::conflict("这个计划已提交执行，请重新预览")
        } else {
            ApiError::not_found("计划不存在，请重新预览")
        });
    };
    let job_id = crate::jobs::new_job_id();
    let uuid = crate::jobs::job_uuid(&job_id).expect("新任务编号应有效");
    sqlx::query(
        "INSERT INTO jobs (id, kind, state, total, done, message, error, result) \
        VALUES ($1, 'move', 'running', 0, 0, '整理已排队', '', NULL)",
    )
    .bind(uuid)
    .execute(&mut *transaction)
    .await
    .map_err(anyhow::Error::from)?;
    transaction.commit().await.map_err(anyhow::Error::from)?;
    tracing::info!("任务开始：kind=move id={job_id}");
    Ok((payload, job_id))
}

/// Track list pages cap at 1000. Chunk explicit selections instead of silently
/// returning only the first page, and preserve their original selection order.
async fn fetch_selected(
    state: &AppState,
    ids: &[i64],
) -> Result<Vec<crate::models::Track>, ApiError> {
    let mut seen = HashSet::new();
    let ids: Vec<_> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
    let mut rows = Vec::with_capacity(ids.len());
    let mut missing = Vec::new();
    for chunk in ids.chunks(1000) {
        let map = fetch_by_ids(state, chunk).await?;
        for id in chunk {
            if *id <= 0 {
                missing.push(*id);
                continue;
            }
            match map.get(id) {
                Some(track) => rows.push(track.clone()),
                None => missing.push(*id),
            }
        }
    }
    if !missing.is_empty() {
        return Err(ApiError::bad_request(format!(
            "所选曲目中有 {} 条已不存在或编号无效（例如 {:?}），请刷新选择后重新预览",
            missing.len(),
            missing.iter().take(10).collect::<Vec<_>>(),
        )));
    }
    Ok(rows)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn query(values: &[(&str, &str)]) -> RawQuery {
        RawQuery(
            values
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }

    #[test]
    fn job_history_filters_validate_without_turning_search_into_a_query() {
        let defaults = parse_job_history_query(&query(&[])).unwrap();
        assert_eq!((defaults.page, defaults.page_size), (1, 20));
        assert!(defaults.q.is_empty() && defaults.kind.is_empty() && defaults.state.is_empty());
        let parsed = parse_job_history_query(&query(&[
            ("q", " 100%_!' "),
            ("kind", " scan "),
            ("state", " running "),
            ("page", "-1"),
        ]))
        .unwrap();
        assert_eq!(parsed.q, "100%_!'");
        assert_eq!(parsed.kind, "scan");
        assert_eq!(parsed.state, "running");
        assert_eq!(parsed.page, -1);
        for pairs in [
            vec![("kind", "unknown")],
            vec![("state", "queued")],
            vec![("page_size", "0")],
            vec![("page_size", "101")],
            vec![("page", "abc")],
            vec![("page", "9223372036854775808")],
        ] {
            assert!(parse_job_history_query(&query(&pairs)).is_err());
        }
        assert!(parse_job_history_query(&query(&[("q", &"字".repeat(500))])).is_ok());
        assert!(parse_job_history_query(&query(&[("q", &"字".repeat(501))])).is_err());
    }

    #[test]
    fn plan_filters_validate_actions_and_escape_literal_searches() {
        let filter =
            PlanFilter::parse(&query(&[("q", "  100%_Mix!  "), ("action", "invalid")])).unwrap();
        assert_eq!(filter.q, "100%_Mix!");
        assert_eq!(filter.pattern(), "%100!%!_Mix!!%");
        assert_eq!(filter.action, "invalid");
        assert!(PlanFilter::parse(&query(&[("action", "move; DROP TABLE tracks")])).is_err());
        let oversized = "中".repeat(501);
        assert!(PlanFilter::parse(&query(&[("q", &oversized)])).is_err());
        assert!(PlanFilter::parse(&query(&[("q", &"中".repeat(500))])).is_ok());
    }

    #[test]
    fn plan_pages_clamp_without_overflow_and_preserve_empty_results() {
        assert_eq!(plan_page(1005, 1, 200), (1, 6, 0));
        assert_eq!(plan_page(1005, i64::MAX, 200), (6, 6, 1000));
        assert_eq!(plan_page(1005, -7, 200), (1, 6, 0));
        assert_eq!(plan_page(0, 999, 200), (1, 0, 0));
    }

    #[test]
    fn csv_quotes_multiline_values_and_blocks_formula_prefixes() {
        for raw in [
            "=1+1",
            " +SUM(A1)",
            "-1",
            "@foo",
            "\tcmd",
            " \tcmd",
            "\rvalue",
            "\u{feff}=1",
            "\u{feff}\tcmd",
        ] {
            assert_eq!(csv_cell(raw), format!("\"'{raw}\""));
        }
        assert_eq!(csv_cell("普通标题"), "\"普通标题\"");
        assert_eq!(csv_cell("a,\"b\"\r\nc"), "\"a,\"\"b\"\"\r\nc\"");
    }

    #[test]
    fn csv_report_is_a_plan_and_keeps_original_ordinals() {
        let report = json!({"token": "abc123", "items": [{
            "ordinal": 701, "track_id": 9001, "source": "/music/a.flac", "target": "/music/b.flac",
            "action": "conflict_skip", "reason": "目标存在", "filename": "a.flac",
            "artist": "测试歌手", "title": "=1+1", "warning": "一行\n二行"
        }]});
        let csv = plan_csv(&report);
        assert!(csv.starts_with("\u{feff}report_type,plan_token,ordinal,track_id,"));
        assert!(csv.contains("\"move_plan\",\"abc123\",\"701\",\"9001\""));
        assert!(csv.contains("\"'=1+1\""));
        assert!(csv.ends_with("\"一行\n二行\"\r\n"));
        assert!(!csv.contains("moved"));
    }
}
