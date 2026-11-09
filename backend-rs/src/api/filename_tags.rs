//! A bounded immutable per-file proposal, claimed once and durably accounted for.

use std::collections::{HashMap, HashSet};
use std::path::Path as FsPath;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::pool::PoolConnection;
use sqlx::types::Json as SqlJson;
use sqlx::{Connection, PgConnection, Postgres};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::filename_tags::{digest, filename_and_stem, Template, FIELDS, LIMIT};
use crate::jobs::{job_id_of, job_uuid, new_job_id, JobStore};
use crate::{repo, scanner, tagio, AppState};

use super::{apply_aliases, changes_json, fields_json, tracks, ApiError, ApiResult};

// A running/queued plan owns one database session for its advisory lease.
// Bound those leases below the 16-connection pool so workers can still sync
// indexes and ordinary requests can obtain connections under queue pressure.
static PLAN_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(4)));
static PREVIEW_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParseRequest {
    ids: Vec<i64>,
    template: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {
    ids: Vec<i64>,
    template: String,
    analysis_revision: String,
    include_ids: Vec<i64>,
    #[serde(default)]
    overwrite: bool,
    #[serde(default)]
    normalize_artist: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyRequest {
    token: Uuid,
    revision: String,
    request_id: Uuid,
}

fn failure(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
    ApiError::StatusDetail(status, json!({"code":code,"message":message.into()}))
}

fn invalid(message: impl Into<String>) -> ApiError {
    failure(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn decode<T: serde::de::DeserializeOwned>(body: &Bytes) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|err| invalid(format!("请求参数不正确：{err}")))
}

fn validate_ids(ids: &[i64], allow_empty: bool) -> ApiResult<()> {
    if ids.len() > LIMIT {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "selection_limit_exceeded",
            "本轮最多选择 500 首，请缩小范围；不会截取前 500 首",
        ));
    }
    if !allow_empty && ids.is_empty() {
        return Err(invalid("至少选择一首曲目"));
    }
    let mut seen = HashSet::new();
    if ids
        .iter()
        .any(|id| *id <= 0 || *id > 9_007_199_254_740_991 || !seen.insert(*id))
    {
        return Err(invalid("曲目编号必须是唯一的安全正整数"));
    }
    Ok(())
}

fn template(source: &str) -> ApiResult<Template> {
    Template::compile(source)
        .map_err(|message| failure(StatusCode::BAD_REQUEST, "invalid_template", message))
}

fn counts(items: &[Value]) -> Value {
    let mut counts = Map::new();
    for item in items {
        let key = item["status"].as_str().unwrap_or("invalid");
        let count = counts.get(key).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(key.into(), json!(count + 1));
    }
    Value::Object(counts)
}

async fn analyze(
    state: &AppState,
    ids: &[i64],
    source: &str,
    template: &Template,
) -> ApiResult<Value> {
    // Index reads only: no stat, canonicalize, tag probe, lyrics or cover reads.
    #[derive(sqlx::FromRow)]
    struct IndexedName {
        id: i64,
        path: String,
        filename: String,
        index_revision: String,
    }
    // xmin changes for every committed index update, including A→B→A path
    // changes. Capture it in the same statement as the indexed names.
    let rows: Vec<IndexedName> = sqlx::query_as(
        "SELECT id,path,filename,xmin::text AS index_revision FROM tracks WHERE id=ANY($1)",
    )
    .bind(ids)
    .fetch_all(&state.db)
    .await
    .map_err(anyhow::Error::from)?;
    let indexed: HashMap<_, _> = rows.into_iter().map(|track| (track.id, track)).collect();
    let mut items = Vec::with_capacity(ids.len());
    let mut versions = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(track) = indexed.get(id) {
            let (filename, stem) = filename_and_stem(&track.path);
            let parsed = template.extract(&stem);
            items.push(json!({"track_id":id,"filename":filename,"path":track.path,
                "status":parsed.status,"parsed_fields":parsed.parsed_fields,"reason":parsed.reason}));
            versions.push(json!({"id":id,"indexed_filename":track.filename,"index_revision":track.index_revision}));
        } else {
            items.push(
                json!({"track_id":id,"filename":"","path":"","status":"index_missing",
                "parsed_fields":{},"reason":"这条曲目已不在索引中"}),
            );
            versions.push(Value::Null);
        }
    }
    let revision = digest(&json!({"template":source,"ids":ids,"items":items,"versions":versions}));
    let mut result_counts = counts(&items);
    for status in [
        "matched",
        "ambiguous",
        "unmatched",
        "invalid",
        "index_missing",
    ] {
        if result_counts.get(status).is_none() {
            result_counts[status] = json!(0);
        }
    }
    Ok(
        json!({"analysis_revision":revision,"limit":LIMIT,"total":ids.len(),"template":source,
        "counts":result_counts,"items":items}),
    )
}

pub async fn parse(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request: ParseRequest = decode(&body)?;
    validate_ids(&request.ids, false)?;
    let template = template(&request.template)?;
    Ok(Json(
        analyze(&state, &request.ids, &request.template, &template).await?,
    ))
}

pub async fn preview(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request: PreviewRequest = decode(&body)?;
    validate_ids(&request.ids, false)?;
    validate_ids(&request.include_ids, true)?;
    let template = template(&request.template)?;
    let selection: HashSet<_> = request.ids.iter().copied().collect();
    let included: HashSet<_> = request.include_ids.iter().copied().collect();
    if !included.is_subset(&selection) {
        return Err(invalid("纳入曲目必须属于本轮固定选择"));
    }
    let slot = PREVIEW_SLOTS.clone().try_acquire_owned().map_err(|_| {
        failure(
            StatusCode::TOO_MANY_REQUESTS,
            "preview_busy",
            "正在读取其它标签预览，请稍后重试",
        )
    })?;
    // Own the guard inside the task: client cancellation must not release the
    // library lock while a spawn_blocking read is still accessing the files.
    let task = tokio::spawn(async move {
        let _slot = slot;
        let _library = scanner::lock_library_scan().await;
        let analysis = analyze(&state, &request.ids, &request.template, &template).await?;
        if analysis["analysis_revision"].as_str() != Some(&request.analysis_revision) {
            return Err(failure(
                StatusCode::CONFLICT,
                "analysis_changed",
                "选择中的文件名或索引已改变，请重新分析",
            ));
        }
        let artist_alias = repo::aliases(&state.db, "artist").await?;
        let album_alias = repo::aliases(&state.db, "album").await?;
        let mut items = analysis["items"]
            .as_array()
            .expect("analysis items")
            .clone();
        for item in &mut items {
            let include = included.contains(&item["track_id"].as_i64().expect("track id"));
            let matched = item["status"] == "matched";
            if include && !matched {
                return Err(invalid("只有唯一匹配的曲目可以纳入真实标签预览"));
            }
            let object = item.as_object_mut().expect("item");
            object.extend(
                json!({"included":include,"processed_fields":{},"current":{},"effective_fields":{},
                "changes":{},"skipped":[],"stage":null,"file_changed":false})
                .as_object()
                .unwrap()
                .clone(),
            );
            if !matched {
                continue;
            }
            if !include {
                item["status"] = json!("excluded");
                item["reason"] = json!("本轮已排除");
                continue;
            }
            let raw: HashMap<String, String> =
                serde_json::from_value(item["parsed_fields"].clone())
                    .map_err(anyhow::Error::from)?;
            let prepared = tracks::prepare_update_fields(&raw, request.normalize_artist);
            let fields = apply_aliases(&prepared, &artist_alias, &album_alias);
            item["processed_fields"] = fields_json(&fields);
            let path = item["path"].as_str().unwrap().to_owned();
            let overwrite = request.overwrite;
            let desired = fields.clone();
            let read = tokio::task::spawn_blocking(move || {
                tagio::preview_guarded(FsPath::new(&path), &desired, overwrite)
            })
            .await;
            match read {
                Ok(Ok((plan, baseline))) => {
                    let current: HashMap<String, String> = fields
                        .keys()
                        .map(|key| (key.clone(), plan.current.field(key).trim().to_owned()))
                        .collect();
                    item["current"] = fields_json(&current);
                    item["effective_fields"] = fields_json(&plan.effective_fields);
                    item["changes"] = changes_json(&plan.changes);
                    item["skipped"] = json!(plan.skipped);
                    item["status"] = json!(if plan.changes.is_empty() {
                        "unchanged"
                    } else {
                        "ready"
                    });
                    item["_baseline"] =
                        serde_json::to_value(baseline).map_err(anyhow::Error::from)?;
                }
                other => {
                    item["status"] = json!("unreadable");
                    item["stage"] = json!("read");
                    item["reason"] = json!(match other {
                        Ok(Err(err)) => err.message,
                        Err(err) => format!("读取标签任务失败：{err}"),
                        _ => unreachable!(),
                    });
                }
            }
        }
        let token = Uuid::new_v4();
        let expires = Utc::now() + chrono::Duration::minutes(30);
        let ready_total = items
            .iter()
            .filter(|item| item["status"] == "ready")
            .count();
        let changed_fields: usize = items
            .iter()
            .map(|item| item["changes"].as_object().map_or(0, Map::len))
            .sum();
        let snapshot = json!({"token":token,"expires_at":expires.timestamp_millis() as f64 / 1000.0,
            "total":items.len(),"included_total":included.len(),"ready_total":ready_total,"changed_fields":changed_fields,
            "template":request.template,"overwrite":request.overwrite,"normalize_artist":request.normalize_artist,
            "analysis_revision":request.analysis_revision,"items":items});
        let revision = digest(&snapshot);
        let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO filename_tag_plans(token,revision,snapshot,expires_at) VALUES($1,$2,$3,$4)")
            .bind(token).bind(&revision).bind(SqlJson(&snapshot)).bind(expires).execute(&mut *tx).await.map_err(anyhow::Error::from)?;
        for (position, item) in items.iter().enumerate() {
            sqlx::query("INSERT INTO filename_tag_plan_items(token,track_id,position,result) VALUES($1,$2,$3,$4)")
                .bind(token).bind(item["track_id"].as_i64().unwrap()).bind(position as i32)
                .bind(SqlJson(public_item(item))).execute(&mut *tx).await.map_err(anyhow::Error::from)?;
        }
        tx.commit().await.map_err(anyhow::Error::from)?;
        load_public(&state, token).await
    });
    Ok(Json(task.await.map_err(anyhow::Error::from)??))
}

fn public_item(item: &Value) -> Value {
    let mut item = item.clone();
    if let Some(object) = item.as_object_mut() {
        object.retain(|key, _| !key.starts_with('_'));
    }
    item
}

#[derive(sqlx::FromRow)]
struct PlanRow {
    revision: String,
    snapshot: SqlJson<Value>,
    state: String,
    expires_at: DateTime<Utc>,
    request_id: Option<Uuid>,
    job_id: Option<Uuid>,
}

const PLAN_COLUMNS: &str = "revision,snapshot,state,expires_at,request_id,job_id";

async fn load_public(state: &AppState, token: Uuid) -> ApiResult<Value> {
    let mut conn = state.db.acquire().await.map_err(anyhow::Error::from)?;
    load_public_on(&mut conn, token).await
}

async fn load_public_on(conn: &mut PgConnection, token: Uuid) -> ApiResult<Value> {
    // One statement yields a coherent mutable-state + ordered-items snapshot.
    let row: Option<(SqlJson<Value>, String, String, Option<Uuid>, Option<Uuid>, SqlJson<Value>)> = sqlx::query_as(
        "SELECT snapshot,revision,state,request_id,job_id,COALESCE((SELECT jsonb_agg(result ORDER BY position) \
         FROM filename_tag_plan_items i WHERE i.token=p.token),'[]'::jsonb) FROM filename_tag_plans p WHERE token=$1")
        .bind(token).fetch_optional(conn).await.map_err(anyhow::Error::from)?;
    let Some((SqlJson(mut snapshot), revision, status, request, job, SqlJson(items))) = row else {
        return Err(failure(
            StatusCode::NOT_FOUND,
            "plan_missing",
            "计划不存在，请重新预览",
        ));
    };
    snapshot["revision"] = json!(revision);
    snapshot["state"] = json!(status);
    snapshot["request_id"] = json!(request);
    snapshot["job_id"] = json!(job.as_ref().map(job_id_of));
    snapshot["items"] = items;
    snapshot["counts"] = counts(snapshot["items"].as_array().unwrap());
    Ok(snapshot)
}

fn path_token(raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| invalid("计划编号格式不正确"))
}

pub async fn detail(
    State(state): State<AppState>,
    Path(token): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult {
    if query.is_some_and(|query| !query.is_empty()) {
        return Err(invalid("计划始终完整返回，不接受筛选或分页参数"));
    }
    Ok(Json(load_public(&state, path_token(&token)?).await?))
}

pub async fn items(
    State(state): State<AppState>,
    Path(token): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult {
    if query.is_some_and(|query| !query.is_empty()) {
        return Err(invalid("计划明细始终完整返回，请在界面分页查看"));
    }
    let plan = load_public(&state, path_token(&token)?).await?;
    Ok(Json(
        json!({"token":plan["token"],"revision":plan["revision"],"state":plan["state"],
        "total":plan["total"],"items":plan["items"]}),
    ))
}

fn lock_key(token: Uuid) -> i64 {
    i64::from_be_bytes(token.as_bytes()[..8].try_into().expect("uuid prefix")) ^ 0x46544c414e303031
}

fn validate_snapshot(snapshot: &Value, revision: &str) -> ApiResult<()> {
    let valid = digest(snapshot) == revision
        && snapshot["items"].as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= LIMIT
                && snapshot["total"].as_u64() == Some(items.len() as u64)
                && snapshot["ready_total"].as_u64()
                    == Some(
                        items
                            .iter()
                            .filter(|item| item["status"] == "ready")
                            .count() as u64,
                    )
                && items
                    .iter()
                    .filter(|item| item["status"] == "ready")
                    .all(|item| {
                        item.get("_baseline").is_some()
                            && item["changes"]
                                .as_object()
                                .is_some_and(|changes| !changes.is_empty())
                            && item["processed_fields"].as_object().is_some_and(|fields| {
                                fields.iter().all(|(key, value)| {
                                    FIELDS.contains(&key.as_str()) && value.is_string()
                                })
                            })
                    })
        });
    if !valid {
        return Err(failure(
            StatusCode::CONFLICT,
            "invalid_plan_snapshot",
            "计划内容不完整，请重新预览",
        ));
    }
    Ok(())
}

fn submitted_response(token: Uuid, row: &PlanRow) -> Value {
    json!({"token":token,"revision":row.revision,"state":row.state,"job_id":row.job_id.as_ref().map(job_id_of)})
}

pub async fn apply(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request: ApplyRequest = decode(&body)?;
    // The session lock stays owned by the worker even after the HTTP caller
    // disconnects. Closing (never pooling) releases it after crashes/panics too.
    let mut conn = state.db.acquire().await.map_err(anyhow::Error::from)?;
    conn.close_on_drop();
    let mut tx = conn.begin().await.map_err(anyhow::Error::from)?;
    let row: Option<PlanRow> = sqlx::query_as(&format!(
        "SELECT {PLAN_COLUMNS} FROM filename_tag_plans WHERE token=$1 FOR UPDATE"
    ))
    .bind(request.token)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let Some(row) = row else {
        return Err(failure(
            StatusCode::NOT_FOUND,
            "plan_missing",
            "计划不存在，请重新预览",
        ));
    };
    if request.revision != row.revision {
        return Err(failure(
            StatusCode::CONFLICT,
            "plan_changed",
            "计划版本不一致，请重新预览",
        ));
    }
    if let Some(existing) = row.request_id {
        return if existing == request.request_id {
            Ok(Json(submitted_response(request.token, &row)))
        } else {
            Err(failure(
                StatusCode::CONFLICT,
                "already_submitted",
                "这份计划已提交，请查看原任务结果",
            ))
        };
    }
    if row.expires_at <= Utc::now() {
        return Err(failure(
            StatusCode::CONFLICT,
            "plan_expired",
            "预览已超过 30 分钟，请重新读取标签预览",
        ));
    }
    validate_snapshot(&row.snapshot.0, &row.revision)?;
    if row.snapshot.0["ready_total"].as_u64().unwrap_or(0) == 0 {
        return Err(failure(
            StatusCode::CONFLICT,
            "no_changes",
            "本轮没有需要写入的变更",
        ));
    }
    let claimed_elsewhere: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM filename_tag_plans WHERE request_id=$1)")
            .bind(request.request_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;
    if claimed_elsewhere {
        return Err(failure(
            StatusCode::CONFLICT,
            "request_id_reused",
            "这个提交编号已用于另一份计划",
        ));
    }
    let slot = PLAN_SLOTS.clone().try_acquire_owned().map_err(|_| {
        failure(
            StatusCode::TOO_MANY_REQUESTS,
            "queue_full",
            "等待中的文件名标签任务已满，请稍后重试",
        )
    })?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(lock_key(request.token))
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    if !locked {
        return Err(failure(
            StatusCode::CONFLICT,
            "already_submitted",
            "这份计划正在执行或核对，请查看原任务",
        ));
    }
    let job_id = new_job_id();
    let job = job_uuid(&job_id).unwrap();
    sqlx::query("INSERT INTO jobs(id,kind,state,total,done,message,error,result) VALUES($1,'filename_tags','running',$2,0,'文件名标签已排队','',$3)")
        .bind(job).bind(row.snapshot.0["ready_total"].as_i64().unwrap())
        .bind(SqlJson(json!({"token":request.token,"revision":row.revision})))
        .execute(&mut *tx).await.map_err(anyhow::Error::from)?;
    let claim = sqlx::query("UPDATE filename_tag_plans SET state='running',request_id=$2,job_id=$3,updated_at=now() WHERE token=$1")
        .bind(request.token).bind(request.request_id).bind(job).execute(&mut *tx).await;
    if let Err(err) = claim {
        if err
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation())
        {
            return Err(failure(
                StatusCode::CONFLICT,
                "request_id_reused",
                "这个提交编号已用于另一份计划",
            ));
        }
        return Err(anyhow::Error::from(err).into());
    }
    let pending = sqlx::query("UPDATE filename_tag_plan_items SET result=jsonb_set(result,'{status}','\"pending\"') WHERE token=$1 AND result->>'status'='ready'")
        .bind(request.token).execute(&mut *tx).await.map_err(anyhow::Error::from)?;
    if pending.rows_affected() != row.snapshot.0["ready_total"].as_u64().unwrap() {
        return Err(failure(
            StatusCode::CONFLICT,
            "invalid_plan_snapshot",
            "计划的待写明细不完整，请重新预览",
        ));
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    let token = request.token;
    let revision = row.revision;
    let snapshot = row.snapshot.0;
    let response = json!({"token":token,"revision":revision,"job_id":job_id,"state":"running"});
    tokio::spawn(async move {
        let _slot = slot;
        if let Err(err) = run(&state, token, &revision, &job_id, &snapshot, &mut conn).await {
            tracing::error!(%token, "文件名标签任务中断：{err}");
            // The durable writing marker is deliberately not reset here.
            if let Err(recovery) = recover_owned(&mut conn, token, &job_id).await {
                tracing::error!(%token, "保存中断结果失败：{recovery}");
            }
        }
        let _ = conn.close().await;
    });
    Ok(Json(response))
}

async fn save_item(conn: &mut PgConnection, token: Uuid, item: &Value) -> anyhow::Result<()> {
    let result = sqlx::query(
        "UPDATE filename_tag_plan_items SET result=$3 WHERE token=$1 AND track_id=$2 \
            AND result->>'status' IN ('pending','writing') \
            AND EXISTS(SELECT 1 FROM filename_tag_plans WHERE token=$1 AND state='running')",
    )
    .bind(token)
    .bind(item["track_id"].as_i64().unwrap())
    .bind(SqlJson(item))
    .execute(conn)
    .await?;
    anyhow::ensure!(result.rows_affected() == 1, "逐项结果记录丢失，任务停止");
    Ok(())
}

fn terminal(
    item: &mut Value,
    status: &str,
    stage: Option<&str>,
    changed: bool,
    reason: Option<String>,
) {
    item["status"] = json!(status);
    item["stage"] = json!(stage);
    item["file_changed"] = json!(changed);
    item["reason"] = json!(reason);
}

async fn run(
    state: &AppState,
    token: Uuid,
    revision: &str,
    job_id: &str,
    snapshot: &Value,
    lease: &mut PoolConnection<Postgres>,
) -> anyhow::Result<()> {
    let _slot = JobStore::acquire_slot()
        .await
        .ok_or_else(|| anyhow::anyhow!("等待其它任务超时"))?;
    let _library = scanner::lock_library_scan().await;
    let overwrite = snapshot["overwrite"].as_bool().unwrap_or(false);
    let mut done = 0;
    for original in snapshot["items"].as_array().unwrap() {
        if original["status"] != "ready" {
            continue;
        }
        // A failed lease prevents starting another write. Loss during an active
        // save remains an uncertain item and never starts an automatic retry.
        sqlx::query("SELECT 1").execute(&mut **lease).await?;
        let mut item = public_item(original);
        let id = item["track_id"].as_i64().unwrap();
        let track = repo::get_track(&state.db, id).await?;
        match track {
            None => terminal(
                &mut item,
                "stale",
                Some("index"),
                false,
                Some("曲目已从索引删除，请重新扫描和预览".into()),
            ),
            Some(track)
                if track.path != item["path"].as_str().unwrap_or("")
                    || filename_and_stem(&track.path).0
                        != item["filename"].as_str().unwrap_or("") =>
            {
                terminal(
                    &mut item,
                    "stale",
                    Some("index"),
                    false,
                    Some("曲目路径或文件名已改变，请重新预览".into()),
                );
            }
            Some(track) => {
                let baseline: tagio::GuardedBaseline =
                    serde_json::from_value(original["_baseline"].clone())?;
                let desired: HashMap<String, String> =
                    serde_json::from_value(original["processed_fields"].clone())?;
                terminal(&mut item, "writing", None, false, None);
                // Must commit before entering any operation that can save bytes.
                save_item(lease, token, &item).await?;
                let path = track.path.clone();
                let outcome = tokio::task::spawn_blocking(move || {
                    tagio::apply_guarded(FsPath::new(&path), &desired, overwrite, &baseline)
                })
                .await;
                // If this session died while the blocking writer was saving,
                // recovery owns the uncertain item. Do not publish a late
                // successful result or synchronize its index through a new
                // unrelated connection.
                sqlx::query("SELECT 1").execute(&mut **lease).await?;
                match outcome {
                    Ok(Ok(outcome)) => {
                        if let Err(err) =
                            tracks::sync_update_outcome(state, &track, &outcome, false).await
                        {
                            terminal(
                                &mut item,
                                "needs_verification",
                                Some("index"),
                                outcome.file_changed,
                                Some(err.to_string()),
                            );
                        } else {
                            terminal(
                                &mut item,
                                if outcome.file_changed {
                                    "written"
                                } else {
                                    "unchanged"
                                },
                                None,
                                outcome.file_changed,
                                None,
                            );
                        }
                    }
                    Ok(Err(err)) => {
                        let status = if err.stage == "stale" {
                            "stale"
                        } else if err.file_changed {
                            "needs_verification"
                        } else {
                            "failed"
                        };
                        terminal(
                            &mut item,
                            status,
                            Some(err.stage),
                            err.file_changed,
                            Some(err.message),
                        );
                    }
                    Err(err) => terminal(
                        &mut item,
                        "needs_verification",
                        Some("write"),
                        true,
                        Some(format!("写入任务意外中断，需要核对文件：{err}")),
                    ),
                }
            }
        }
        save_item(lease, token, &item).await?;
        done += 1;
        sqlx::query(
            "UPDATE jobs SET done=$2,message=$3,updated_at=now() WHERE id=$1 AND state='running'",
        )
        .bind(job_uuid(job_id).unwrap())
        .bind(done)
        .bind(format!("文件名标签已处理 {done} 首"))
        .execute(&mut **lease)
        .await?;
    }
    finish(lease, token, revision, job_id, false).await
}

async fn finish(
    conn: &mut PgConnection,
    token: Uuid,
    revision: &str,
    job_id: &str,
    interrupted: bool,
) -> anyhow::Result<()> {
    let plan = load_public_on(conn, token)
        .await
        .map_err(|err| anyhow::anyhow!(err.detail_text()))?;
    let details = plan["items"].clone();
    let counters = plan["counts"].clone();
    let count = |key: &str| counters[key].as_i64().unwrap_or(0);
    let failures =
        count("failed") + count("needs_verification") + count("stale") + count("not_started");
    let result = json!({"token":token,"revision":revision,"details":details,"details_total":plan["total"],
        "details_truncated":false,"counts":counters,"written":count("written"),"unchanged":count("unchanged"),
        "failed":failures,"needs_verification":count("needs_verification"),"stale":count("stale"),"not_started":count("not_started")});
    let status = if interrupted || failures > 0 {
        "error"
    } else {
        "done"
    };
    let message = if interrupted {
        "服务中断；尚未开始的项目未执行，写入中的项目需要核对"
    } else if failures > 0 {
        "处理完成；部分项目需要核对或重新预览"
    } else {
        "文件名标签写入完成"
    };
    let mut tx = conn.begin().await?;
    sqlx::query("UPDATE filename_tag_plans SET state=$2,updated_at=now() WHERE token=$1")
        .bind(token)
        .bind(status)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE jobs SET state=$2,done=total,message=$3,error=$4,result=$5,updated_at=now() WHERE id=$1")
        .bind(job_uuid(job_id).unwrap()).bind(status).bind(message)
        .bind(if status == "error" { message } else { "" }).bind(SqlJson(&result)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn recover_owned(conn: &mut PgConnection, token: Uuid, job_id: &str) -> anyhow::Result<()> {
    // A possibly saved file is never reset to pending. Untouched items remain
    // explicitly unstarted; only a newly previewed plan may write them later.
    sqlx::query("UPDATE filename_tag_plan_items SET result=result || \
        CASE WHEN result->>'status'='writing' THEN \
          '{\"status\":\"needs_verification\",\"stage\":\"interrupted\",\"file_changed\":true,\"reason\":\"写入期间任务中断，文件可能已改变，请核对现状\"}'::jsonb \
        ELSE '{\"status\":\"not_started\",\"stage\":\"interrupted\",\"file_changed\":false,\"reason\":\"任务中断，本项尚未开始；需要重新预览\"}'::jsonb END \
        WHERE token=$1 AND result->>'status' IN ('writing','pending')")
        .bind(token).execute(&mut *conn).await?;
    let revision: String =
        sqlx::query_scalar("SELECT revision FROM filename_tag_plans WHERE token=$1")
            .bind(token)
            .fetch_one(&mut *conn)
            .await?;
    finish(conn, token, &revision, job_id, true).await
}

pub(crate) async fn recover(state: &AppState) -> anyhow::Result<()> {
    let running: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT token,job_id FROM filename_tag_plans WHERE state='running' AND job_id IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await?;
    for (token, job) in running {
        let mut conn = state.db.acquire().await?;
        conn.close_on_drop();
        let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
            .bind(lock_key(token))
            .fetch_one(&mut *conn)
            .await?;
        if locked {
            let active: bool =
                sqlx::query_scalar("SELECT state='running' FROM filename_tag_plans WHERE token=$1")
                    .bind(token)
                    .fetch_one(&mut *conn)
                    .await?;
            if active {
                recover_owned(&mut conn, token, &job_id_of(&job)).await?;
            }
        }
        let _ = conn.close().await;
    }
    Ok(())
}

pub(crate) fn start_recovery(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(err) = recover(&state).await {
                tracing::warn!("恢复文件名标签任务失败：{err}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_strict_and_selection_is_never_truncated() {
        assert!(decode::<ParseRequest>(&Bytes::from_static(
            br#"{"ids":[1],"template":"{title}","path":"/etc/other"}"#
        ))
        .is_err());
        assert!(decode::<ParseRequest>(&Bytes::from_static(
            br#"{"ids":[1.0],"template":"{title}"}"#
        ))
        .is_err());
        assert!(decode::<PreviewRequest>(&Bytes::from_static(br#"{"ids":[1],"template":"{title}","analysis_revision":"a","include_ids":[1],"overwrite":"false"}"#)).is_err());
        assert!(validate_ids(&(1..=500).collect::<Vec<_>>(), false).is_ok());
        assert!(validate_ids(&(1..=501).collect::<Vec<_>>(), false).is_err());
        for ids in [
            vec![],
            vec![1, 1],
            vec![0],
            vec![-1],
            vec![9_007_199_254_740_992],
        ] {
            assert!(validate_ids(&ids, false).is_err());
        }
        let preview: PreviewRequest = decode(&Bytes::from_static(
            br#"{"ids":[1],"template":"{title}","analysis_revision":"a","include_ids":[1]}"#,
        ))
        .unwrap();
        assert!(!preview.overwrite && !preview.normalize_artist);
    }

    #[test]
    fn private_baselines_never_escape_and_counts_cover_all_items() {
        let item = json!({"track_id":1,"status":"ready","_baseline":{"private":"x"}});
        assert!(public_item(&item).get("_baseline").is_none());
        let items = vec![
            item,
            json!({"status":"excluded"}),
            json!({"status":"ready"}),
        ];
        assert_eq!(counts(&items), json!({"ready":2,"excluded":1}));
        let changed = json!({"items":items,"total":3,"ready_total":2});
        assert!(validate_snapshot(&changed, "wrong").is_err());
    }

    #[test]
    fn digest_covers_order_values_and_every_scope_member() {
        let first = json!({"template":"{title}","ids":[1,2],"items":[{"path":"a"},{"path":"b"}]});
        let mut other = first.clone();
        other["ids"] = json!([2, 1]);
        assert_ne!(digest(&first), digest(&other));
        other = first.clone();
        other["items"][1]["path"] = json!("changed");
        assert_ne!(digest(&first), digest(&other));
    }
}
