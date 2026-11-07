//! 后台任务：任务行落 Postgres，实时进度同时写 Redis（Redis 是一等公民）。
//!
//! 与 Python 版（`app/jobs.py`）对齐的可观测行为：
//! - `job_id` = 12 位十六进制（前端只当不透明字符串，e2e 会拿它查 `/api/jobs/{id}`）
//! - 状态集合只有 `running` / `done` / `error`
//! - 进度写库做节流：≥0.4s 或 ≥20 项才落一次；任务结束时强制补齐 `done == total`
//! （`tests/test_api.py:307-313` 钉住完成态 `percent == 100.0`）
//! - 全局最多 2 个并发重任务（Python 是 `BoundedSemaphore(2)`），等不到超时就
//!   `state=error` + `error="等待其它任务超时"`
//!
//! 与 Python 版的结构差异（这是「用 Postgres + Redis」的必然结果）：
//! - 没有守护线程，任务跑在 tokio 任务里
//! - 进度除了节流写 Postgres，还**每次都写 Redis**（键 `metatidy:job:{id}`，TTL 7 天），
//!   `/api/jobs/{id}` 会优先用 Redis 里更新鲜的进度；Redis 不可用则只读 Postgres

use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sqlx::types::Json as SqlJson;
use sqlx::PgPool;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::{Semaphore, SemaphorePermit};
use uuid::Uuid;

/// 同时最多跑几个重任务（与 Python 的 `MAX_CONCURRENT_JOBS` 一致）。
pub const MAX_CONCURRENT_JOBS: usize = 2;
/// 等不到并发额度就报错（与 Python 的 `acquire(timeout=600)` 一致）。
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(600);
/// 进度落 Postgres 的最小间隔 / 最小步进（Python 默认值）。
const MIN_INTERVAL: Duration = Duration::from_millis(400);
const MIN_DELTA: i64 = 20;
/// Redis 里任务进度的存活时间。
const REDIS_TTL_SECS: i64 = 7 * 24 * 3600;

static SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(MAX_CONCURRENT_JOBS));

/// 生成一个新的任务号：12 位十六进制（外形与 Python 的 `uuid4().hex[:12]` 一致）。
pub fn new_job_id() -> String {
    let hex = Uuid::new_v4().simple().to_string();
    hex[..12].to_string()
}

/// 任务号 → 落库用的 UUID。
///
/// 为什么能这么干：`jobs.id` 在 schema 里是 `UUID`，而 12 位 hex 也是合法的 UUID 文本
/// （后面补 0 就是 32 位十六进制）。这样既不改表结构，又能让接口层对外始终给 12 位 hex。
pub fn job_uuid(job_id: &str) -> Option<Uuid> {
    let cleaned: String = job_id.trim().chars().filter(|c| *c != '-').collect();
    if cleaned.is_empty() || cleaned.len() > 32 || !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let padded = format!("{cleaned:0<32}");
    Uuid::parse_str(&padded).ok()
}

/// UUID → 12 位任务号。
pub fn job_id_of(uuid: &Uuid) -> String {
    uuid.simple().to_string()[..12].to_string()
}

/// 一个任务行（对外 JSON 的字段与顺序见 `JobRow::json`）。
#[derive(Debug, Clone)]
pub struct JobRow {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub total: i64,
    pub done: i64,
    pub message: String,
    pub error: String,
    /// 已序列化好的结果（响应里必须是字符串，不是对象！）
    pub result: String,
    pub created_at: f64,
    pub updated_at: f64,
}

impl JobRow {
    /// `/api/jobs/{id}` 与 `/api/jobs` 共用的 JSON。
    ///
    /// `percent` 只在单任务接口里出现（Python 版同样如此）。
    pub fn json(&self, with_percent: bool) -> Value {
        let mut out = json!({
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "total": self.total,
            "done": self.done,
            "message": self.message,
            "error": self.error,
            "result": self.result,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        });
        if with_percent {
            out["percent"] = json!(percent(self.done, self.total));
        }
        out
    }

    /// PostgreSQL owns lifecycle and saved results. Redis only improves the
    /// progress of a still-running row; stale keys cannot revive terminal jobs.
    fn overlay_progress(&mut self, live: &HashMap<String, String>) {
        if self.state != "running" || live.get("state").is_some_and(|state| state != "running") {
            return;
        }
        if let Some(value) = live
            .get("total")
            .and_then(|value| value.parse::<i64>().ok())
        {
            self.total = value.max(0);
        }
        if let Some(value) = live.get("done").and_then(|value| value.parse::<i64>().ok()) {
            self.done = value.max(0);
        }
        if let Some(value) = live.get("message") {
            self.message = value.clone();
        }
    }

    pub fn report(&self) -> Value {
        let parsed: Option<Value> = serde_json::from_str(&self.result).ok();
        let result = parsed.as_ref().unwrap_or(&Value::Null);
        let array_len = |key: &str| result.get(key).and_then(Value::as_array).map(Vec::len);
        let mut notes =
            vec!["报告仅包含已保存的任务汇总和明细，不保证包含每个文件的完整处理记录。"];
        if self.state == "running" {
            notes.push("任务仍在进行中，当前内容不是最终结果。");
        }
        if parsed.is_none() {
            notes.push("尚无可解析的已保存结果；任务原始 result 字符串仍保留在报告中。");
        }
        match self.kind.as_str() {
            "scrape" if result.get("details_truncated").and_then(Value::as_bool) == Some(true) => {
                notes.push(
                    "处理明细已截断；完整数量见 details_total，报告仅含 details_saved 条已存明细。",
                );
            }
            "scrape"
                if result
                    .get("details_truncated")
                    .and_then(Value::as_bool)
                    .is_none() =>
            {
                notes.push("旧版批量刮削最多保存前 500 条明细，未记录截断标记，不能据此推断其余曲目的处理结果。");
            }
            "scan" => {
                notes.push("扫描错误信息最多保存前 20 条；失败总数以已保存的 failed 汇总为准。")
            }
            "move" => notes.push("移动结果保存汇总和失败记录，不包含全部成功文件的最终目标路径。"),
            _ => {}
        }
        json!({
            "report_type": "job_result",
            "report_scope": "saved_result",
            "generated_at": epoch(chrono::Utc::now()),
            "job": self.json(true),
            "parsed_result": parsed,
            "completeness": {
                "scope": "saved_result",
                "details_saved": array_len("details"),
                "details_total": result.get("details_total").and_then(Value::as_u64),
                "details_truncated": result.get("details_truncated").and_then(Value::as_bool),
                "errors_saved": array_len("errors"),
                "failures_saved": array_len("failures"),
                "note": notes.join(" "),
            },
        })
    }
}

#[derive(Debug, Clone)]
pub struct JobHistoryQuery {
    pub q: String,
    pub kind: String,
    pub state: String,
    pub page: i64,
    pub page_size: i64,
}

impl JobHistoryQuery {
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

const HISTORY_WHERE: &str = "WHERE ($1 = '' OR kind = $1) AND ($2 = '' OR state = $2) AND (\
    left(replace(id::text, '-', ''), 12) ILIKE $3 ESCAPE '!' OR \
    kind ILIKE $3 ESCAPE '!' OR message ILIKE $3 ESCAPE '!' OR error ILIKE $3 ESCAPE '!')";

// Project only a bounded page before looking into JSONB results. Large arrays
// remain in PostgreSQL; history never transfers the full result to the browser.
const SUMMARY_COLUMNS: &str = "id, kind, state, total, done, message, error, created_at, updated_at, \
    (result IS NOT NULL AND result <> 'null'::jsonb) AS has_result, \
    (error <> '' OR \
        CASE WHEN jsonb_typeof(result->'failed') = 'number' THEN (result->>'failed')::numeric > 0 ELSE FALSE END OR \
        CASE WHEN jsonb_typeof(result->'errors') = 'array' THEN jsonb_array_length(result->'errors') > 0 ELSE FALSE END OR \
        CASE WHEN jsonb_typeof(result->'failures') = 'array' THEN jsonb_array_length(result->'failures') > 0 ELSE FALSE END OR \
        EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(result->'details') = 'array' \
            THEN result->'details' ELSE '[]'::jsonb END) AS detail(item) \
            WHERE jsonb_typeof(detail.item->'error') = 'string' AND detail.item->>'error' <> '') \
    ) AS has_errors, \
    COALESCE((SELECT jsonb_object_agg(field.key, field.value) \
        FROM jsonb_each(CASE WHEN jsonb_typeof(result) = 'object' THEN result ELSE '{}'::jsonb END) AS field \
        WHERE field.key IN ('added','updated','skipped','removed','failed','scanned','parsed', \
            'total_seconds','seconds','trigger','root','fast_mode','applied','search_only','moved','renamed', \
            'details_total','details_truncated') \
        AND jsonb_typeof(field.value) IN ('string','number','boolean')), '{}'::jsonb) AS summary";

#[derive(sqlx::FromRow)]
struct JobSummaryRow {
    id: Uuid,
    kind: String,
    state: String,
    total: i64,
    done: i64,
    message: String,
    error: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    has_result: bool,
    has_errors: bool,
    summary: SqlJson<Value>,
}

impl JobSummaryRow {
    fn json(self) -> Value {
        json!({
            "id": job_id_of(&self.id), "kind": self.kind, "state": self.state,
            "total": self.total, "done": self.done, "message": self.message, "error": self.error,
            "created_at": epoch(self.created_at), "updated_at": epoch(self.updated_at),
            "percent": percent(self.done, self.total), "has_result": self.has_result,
            "has_errors": self.has_errors, "summary": self.summary.0,
        })
    }
}

fn history_page(total: i64, requested: i64, size: i64) -> (i64, i64, i64) {
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    (page, pages, (page - 1) * size)
}

/// `round(done / total * 100, 1)`；`total = 0` 时是 `0.0`。
pub fn percent(done: i64, total: i64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    ((done as f64 / total as f64) * 1000.0).round() / 10.0
}

/// 任务读写入口（Postgres + 可选 Redis）。
#[derive(Clone)]
pub struct JobStore {
    pub pool: PgPool,
    pub redis: Option<redis::aio::ConnectionManager>,
}

/// 一次进度更新要写哪些字段（`None` = 不动这一列）。
#[derive(Debug, Clone, Default)]
pub struct JobPatch {
    pub state: Option<String>,
    pub total: Option<i64>,
    pub done: Option<i64>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub result: Option<Value>,
}

impl JobStore {
    pub fn new(pool: PgPool, redis: Option<redis::aio::ConnectionManager>) -> Self {
        Self { pool, redis }
    }

    /// 建任务行（`state=running`，与 Python 的 `job_create` 一致）。
    pub async fn create(&self, kind: &str) -> anyhow::Result<String> {
        let job_id = new_job_id();
        let uuid = job_uuid(&job_id).expect("12 位 hex 一定能转成 UUID");
        sqlx::query(
            "INSERT INTO jobs (id, kind, state, total, done, message, error, result)
             VALUES ($1, $2, 'running', 0, 0, '', '', NULL)",
        )
        .bind(uuid)
        .bind(kind)
        .execute(&self.pool)
        .await?;
        // 起任务就写一行日志：否则「日志里什么都没有」会被误读成「没在跑」
        tracing::info!("任务开始：kind={kind} id={job_id}");
        Ok(job_id)
    }

    pub async fn get(&self, job_id: &str) -> anyhow::Result<Option<JobRow>> {
        let Some(uuid) = job_uuid(job_id) else {
            return Ok(None);
        };
        let row: Option<(Uuid, String, String, i64, i64, String, String, Option<SqlJson<Value>>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> =
            sqlx::query_as(
                "SELECT id, kind, state, total, done, message, error, result, created_at, updated_at
                 FROM jobs WHERE id = $1",
            )
            .bind(uuid)
            .fetch_optional(&self.pool)
            .await?;
        let Some((id, kind, state, total, done, message, error, result, created_at, updated_at)) = row
        else {
            return Ok(None);
        };
        let mut job = JobRow {
            id: job_id_of(&id),
            kind,
            state,
            total,
            done,
            message,
            error,
            result: result
                .map(|j| j.0.to_string())
                .filter(|s| s != "null")
                .unwrap_or_default(),
            created_at: epoch(created_at),
            updated_at: epoch(updated_at),
        };
        if job.state == "running" {
            if let Some(live) = self.read_progress(&job.id).await {
                job.overlay_progress(&live);
            }
        }
        Ok(Some(job))
    }

    /// 最近任务（默认 20 条，按 `created_at DESC`）。
    pub async fn list(&self, limit: i64) -> anyhow::Result<Vec<JobRow>> {
        let rows: Vec<(Uuid, String, String, i64, i64, String, String, Option<SqlJson<Value>>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> =
            sqlx::query_as(
                "SELECT id, kind, state, total, done, message, error, result, created_at, updated_at
                 FROM jobs ORDER BY created_at DESC, id DESC LIMIT $1",
            )
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(id, kind, state, total, done, message, error, result, created_at, updated_at)| JobRow {
                id: job_id_of(&id),
                kind,
                state,
                total,
                done,
                message,
                error,
                result: result
                    .map(|j| j.0.to_string())
                    .filter(|s| s != "null")
                    .unwrap_or_default(),
                created_at: epoch(created_at),
                updated_at: epoch(updated_at),
            })
            .collect())
    }

    /// Global activity is independent of the history query. The bounded active
    /// preview shows the oldest running/queued work even after newer jobs finish.
    pub async fn overview(&self) -> anyhow::Result<Value> {
        const ACTIVE_LIMIT: i64 = 10;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *transaction)
            .await?;
        let (total, running, done, error): (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT count(*), count(*) FILTER (WHERE state = 'running'), \
                count(*) FILTER (WHERE state = 'done'), count(*) FILTER (WHERE state = 'error') FROM jobs",
        ).fetch_one(&mut *transaction).await?;
        let active: Vec<JobSummaryRow> = sqlx::query_as(&format!(
            "WITH page_rows AS MATERIALIZED (SELECT * FROM jobs WHERE state = 'running' \
                ORDER BY created_at ASC, id ASC LIMIT $1) \
             SELECT {SUMMARY_COLUMNS} FROM page_rows ORDER BY created_at ASC, id ASC"
        ))
        .bind(ACTIVE_LIMIT)
        .fetch_all(&mut *transaction)
        .await?;
        let latest: Option<(Uuid, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
            "SELECT id, updated_at FROM jobs WHERE kind = 'scan' AND state = 'done' \
                AND result->>'trigger' = 'watch' ORDER BY updated_at DESC, id DESC LIMIT 1",
        )
        .fetch_optional(&mut *transaction)
        .await?;
        transaction.commit().await?;
        let latest = latest.map(|(id, updated_at)| {
            json!({
                "id": job_id_of(&id), "updated_at": epoch(updated_at),
                "cursor": format!("{}:{}", updated_at.timestamp_micros(), id.simple()),
            })
        });
        Ok(json!({
            "counts": {"total": total, "running": running, "done": done, "error": error},
            "active": active.into_iter().map(JobSummaryRow::json).collect::<Vec<_>>(),
            "active_total": running, "active_limit": ACTIVE_LIMIT,
            "latest_completed_watch": latest,
        }))
    }

    pub async fn history(&self, query: &JobHistoryQuery) -> anyhow::Result<Value> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *transaction)
            .await?;
        let pattern = query.pattern();
        let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM jobs {HISTORY_WHERE}"))
            .bind(&query.kind)
            .bind(&query.state)
            .bind(&pattern)
            .fetch_one(&mut *transaction)
            .await?;
        let (page, pages, offset) = history_page(total, query.page, query.page_size);
        let rows: Vec<JobSummaryRow> = sqlx::query_as(&format!(
            "WITH page_rows AS MATERIALIZED (SELECT * FROM jobs {HISTORY_WHERE} \
                ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5) \
             SELECT {SUMMARY_COLUMNS} FROM page_rows ORDER BY created_at DESC, id DESC"
        ))
        .bind(&query.kind)
        .bind(&query.state)
        .bind(&pattern)
        .bind(query.page_size)
        .bind(offset)
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(json!({
            "items": rows.into_iter().map(JobSummaryRow::json).collect::<Vec<_>>(),
            "total": total, "page": page, "page_size": query.page_size, "pages": pages,
            "q": query.q, "kind": query.kind, "state": query.state,
        }))
    }

    pub async fn update(&self, job_id: &str, patch: &JobPatch) -> anyhow::Result<()> {
        let Some(uuid) = job_uuid(job_id) else {
            return Ok(());
        };
        let mut sets: Vec<String> = Vec::new();
        let mut binds: Vec<Bind> = Vec::new();
        if let Some(v) = &patch.state {
            sets.push("state = ?".to_string());
            binds.push(Bind::Text(v.clone()));
        }
        if let Some(v) = patch.total {
            sets.push("total = ?".to_string());
            binds.push(Bind::Int(v));
        }
        if let Some(v) = patch.done {
            sets.push("done = ?".to_string());
            binds.push(Bind::Int(v));
        }
        if let Some(v) = &patch.message {
            sets.push("message = ?".to_string());
            binds.push(Bind::Text(v.clone()));
        }
        if let Some(v) = &patch.error {
            sets.push("error = ?".to_string());
            binds.push(Bind::Text(v.clone()));
        }
        if let Some(v) = &patch.result {
            sets.push("result = ?".to_string());
            binds.push(Bind::Json(v.clone()));
        }
        if sets.is_empty() {
            return Ok(());
        }
        // 占位符统一在 SQL 里拼成 $n（这里只做一次字符串替换，参数按顺序绑定）
        let mut sql = String::from("UPDATE jobs SET ");
        for (i, set) in sets.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&set.replace('?', &format!("${}", i + 1)));
        }
        sql.push_str(&format!(", updated_at = now() WHERE id = ${}", sets.len() + 1));
        let mut query = sqlx::query(&sql);
        for b in &binds {
            query = match b {
                Bind::Text(v) => query.bind(v),
                Bind::Int(v) => query.bind(v),
                Bind::Json(v) => query.bind(SqlJson(v.clone())),
            };
        }
        query.bind(uuid).execute(&self.pool).await?;
        Ok(())
    }

    /// 进度写 Redis（失败只记日志，绝不影响任务本身）。
    pub async fn write_progress(&self, job_id: &str, patch: &JobPatch) {
        let Some(mut conn) = self.redis.clone() else {
            return;
        };
        let key = format!("metatidy:job:{job_id}");
        let mut cmd = redis::cmd("HSET");
        cmd.arg(&key);
        let mut wrote = false;
        if let Some(v) = &patch.state {
            cmd.arg("state").arg(v);
            wrote = true;
        }
        if let Some(v) = patch.total {
            cmd.arg("total").arg(v);
            wrote = true;
        }
        if let Some(v) = patch.done {
            cmd.arg("done").arg(v);
            wrote = true;
        }
        if let Some(v) = &patch.message {
            cmd.arg("message").arg(v);
            wrote = true;
        }
        if let Some(v) = &patch.error {
            cmd.arg("error").arg(v);
            wrote = true;
        }
        if !wrote {
            return;
        }
        let _: Result<i64, _> = cmd.query_async(&mut conn).await;
        let _: Result<i64, _> = redis::cmd("EXPIRE")
            .arg(&key)
            .arg(REDIS_TTL_SECS)
            .query_async(&mut conn)
            .await;
    }

    /// 读 Redis 里的进度（`None` = Redis 没这条或没配 Redis）。
    pub async fn read_progress(&self, job_id: &str) -> Option<std::collections::HashMap<String, String>> {
        let mut conn = self.redis.clone()?;
        let key = format!("metatidy:job:{job_id}");
        let flat: Vec<String> = redis::cmd("HGETALL").arg(&key).query_async(&mut conn).await.ok()?;
        if flat.is_empty() {
            return None;
        }
        let mut out = std::collections::HashMap::new();
        let mut it = flat.into_iter();
        while let (Some(k), Some(v)) = (it.next(), it.next()) {
            out.insert(k, v);
        }
        Some(out)
    }

    /// The caller retains the permit through work and result persistence. A
    /// bool would drop it on return and silently remove the concurrency bound.
    pub async fn acquire_slot() -> Option<SemaphorePermit<'static>> {
        acquire_slot_from(&SEMAPHORE, WAIT_TIMEOUT).await
    }
}

async fn acquire_slot_from(semaphore: &Semaphore, wait: Duration) -> Option<SemaphorePermit<'_>> {
    tokio::time::timeout(wait, semaphore.acquire())
        .await
        .ok()?
        .ok()
}

enum Bind {
    Text(String),
    Int(i64),
    Json(Value),
}

fn epoch(dt: chrono::DateTime<chrono::Utc>) -> f64 {
    dt.timestamp_millis() as f64 / 1000.0
}

/// 带节流的进度上报器（节流语义与 Python 的 `Progress` 一致）。
pub struct Progress {
    store: JobStore,
    job_id: String,
    total: i64,
    done: i64,
    last_write: Instant,
    last_done: i64,
}

impl Progress {
    pub fn new(store: JobStore, job_id: String) -> Self {
        Self {
            store,
            job_id,
            total: 0,
            done: 0,
            last_write: Instant::now(),
            last_done: 0,
        }
    }

    /// 总项数（扫描 = 枚举到的文件数、批量刮削 = 曲目数、移动 = 可移动项数）。
    pub async fn set_total(&mut self, total: i64) {
        self.total = total;
        let patch = JobPatch {
            total: Some(total),
            ..Default::default()
        };
        let _ = self.store.update(&self.job_id, &patch).await;
        self.store.write_progress(&self.job_id, &patch).await;
        self.last_write = Instant::now();
        self.last_done = self.done;
    }

    /// 直接设定绝对进度（扫描层给的就是绝对值）。
    pub async fn set_progress(&mut self, done: i64, total: i64, message: Option<String>) {
        self.done = done;
        self.total = total;
        let due = self.last_write.elapsed() >= MIN_INTERVAL || (done - self.last_done) >= MIN_DELTA;
        if !due {
            return;
        }
        self.flush(message).await;
    }

    /// 前进 n 项。
    pub async fn step(&mut self, n: i64, message: Option<String>) {
        self.done += n;
        let due = self.last_write.elapsed() >= MIN_INTERVAL || (self.done - self.last_done) >= MIN_DELTA;
        if !due {
            return;
        }
        self.flush(message).await;
    }

    /// 立即写一次（忽略节流）。
    pub async fn flush(&mut self, message: Option<String>) {
        let message = message.unwrap_or_default();
        let patch = JobPatch {
            total: Some(self.total),
            done: Some(self.done),
            message: Some(message),
            ..Default::default()
        };
        let _ = self.store.update(&self.job_id, &patch).await;
        self.store.write_progress(&self.job_id, &patch).await;
        self.last_write = Instant::now();
        self.last_done = self.done;
    }

    /// 只更新文本提示。
    pub async fn note(&mut self, message: impl Into<String>) {
        let patch = JobPatch {
            message: Some(message.into()),
            ..Default::default()
        };
        let _ = self.store.update(&self.job_id, &patch).await;
        self.store.write_progress(&self.job_id, &patch).await;
    }

    /// 任务成功结束：强制 `done == total`、`state=done`、`message=完成`，结果写库。
    pub async fn finish(&mut self, result: Option<Value>) {
        let final_total = if self.total > 0 { self.total } else { self.done };
        let patch = JobPatch {
            state: Some("done".to_string()),
            total: Some(final_total),
            done: Some(final_total),
            message: Some("完成".to_string()),
            result,
            ..Default::default()
        };
        let _ = self.store.update(&self.job_id, &patch).await;
        self.store.write_progress(&self.job_id, &patch).await;
    }

    /// 任务失败：`state=error`，错误文本是「异常类名: 消息」（Python 同样格式）。
    pub async fn fail(&mut self, kind_name: &str, message: &str) {
        let patch = JobPatch {
            state: Some("error".to_string()),
            error: Some(format!("{kind_name}: {message}")),
            message: Some(tail(message, 500)),
            ..Default::default()
        };
        let _ = self.store.update(&self.job_id, &patch).await;
        self.store.write_progress(&self.job_id, &patch).await;
    }
}

fn tail(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    chars[chars.len() - limit..].iter().collect()
}

/// 进度事件：扫描/移动这类同步回调只能把事件发进通道，由异步侧落库。
#[derive(Debug, Clone)]
pub enum ProgressEvent {
    Set { done: i64, total: i64, message: String },
    Step(i64, Option<String>),
}

/// 起一个消费进度事件的异步任务，返回的 `JoinHandle` 结束后能拿回 `Progress`
/// （发送端 drop 之后它才会结束，所以调用方要保证先 drop 发送端）。
pub fn spawn_progress_drain(
    mut progress: Progress,
    mut rx: UnboundedReceiver<ProgressEvent>,
) -> tokio::task::JoinHandle<Progress> {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                ProgressEvent::Set { done, total, message } => {
                    let msg = if message.is_empty() { None } else { Some(message) };
                    progress.set_progress(done, total, msg).await;
                }
                ProgressEvent::Step(n, message) => progress.step(n, message).await,
            }
        }
        progress
    })
}

/// 进度通道的发送端（同步回调里用）。
pub fn progress_channel() -> (UnboundedSender<ProgressEvent>, UnboundedReceiver<ProgressEvent>) {
    unbounded_channel()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(state: &str) -> JobRow {
        JobRow {
            id: "9a1c4d2f7b30".into(),
            kind: "scrape".into(),
            state: state.into(),
            total: 10,
            done: 4,
            message: "数据库消息".into(),
            error: String::new(),
            result: String::new(),
            created_at: 1.0,
            updated_at: 2.0,
        }
    }

    #[tokio::test]
    async fn held_job_permits_limit_work_until_completion_or_early_return() {
        let semaphore = Semaphore::new(2);
        let first = acquire_slot_from(&semaphore, Duration::from_millis(50))
            .await
            .unwrap();
        let second = acquire_slot_from(&semaphore, Duration::from_millis(50))
            .await
            .unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        assert!(acquire_slot_from(&semaphore, Duration::from_millis(10))
            .await
            .is_none());
        drop(first);
        let failed: Result<(), ()> = async {
            let _guard = acquire_slot_from(&semaphore, Duration::from_millis(50))
                .await
                .unwrap();
            assert_eq!(semaphore.available_permits(), 0);
            Err(())
        }
        .await;
        assert!(failed.is_err());
        assert_eq!(semaphore.available_permits(), 1);
        let replacement = acquire_slot_from(&semaphore, Duration::from_millis(50))
            .await
            .unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        drop((replacement, second));
        assert_eq!(semaphore.available_permits(), 2);
    }

    #[test]
    fn postgres_terminal_state_and_results_survive_stale_redis() {
        let live = HashMap::from([
            ("state".into(), "running".into()),
            ("total".into(), "999".into()),
            ("done".into(), "998".into()),
            ("message".into(), "过期消息".into()),
            ("error".into(), String::new()),
        ]);
        for state in ["error", "done"] {
            let mut row = job(state);
            row.error = "容器重启导致任务中断".into();
            row.result = json!({"failed": 2}).to_string();
            let before = row.json(true);
            row.overlay_progress(&live);
            assert_eq!(row.json(true), before);
        }
        let mut running = job("running");
        running.overlay_progress(&live);
        assert_eq!(running.state, "running");
        assert_eq!((running.total, running.done), (999, 998));
        assert_eq!(running.updated_at, 2.0);
        assert!(running.result.is_empty());
        let before = running.json(true);
        let terminal_cache = HashMap::from([
            ("state".into(), "done".into()),
            ("done".into(), "1234".into()),
        ]);
        running.overlay_progress(&terminal_cache);
        assert_eq!(running.json(true), before);
    }

    #[test]
    fn saved_reports_preserve_raw_values_and_expose_known_truncation() {
        let mut row = job("done");
        row.result = json!({"failed": 1, "details": [{"track_id": 1, "error": "无法写入"}],
            "details_total": 700, "details_truncated": true})
        .to_string();
        let report = row.report();
        assert_eq!(report["job"]["result"], row.result);
        assert_eq!(report["report_scope"], "saved_result");
        assert_eq!(report["completeness"]["details_saved"], 1);
        assert_eq!(report["completeness"]["details_total"], 700);
        assert_eq!(report["completeness"]["details_truncated"], true);
        row.result = json!({"details": vec![json!({"status": "仅搜索"}); 500]}).to_string();
        let legacy = row.report();
        assert_eq!(legacy["completeness"]["details_saved"], 500);
        assert!(legacy["completeness"]["details_total"].is_null());
        assert!(legacy["completeness"]["details_truncated"].is_null());
        row.result = "unparseable old result".into();
        let invalid = row.report();
        assert_eq!(invalid["job"]["result"], row.result);
        assert!(invalid["parsed_result"].is_null());
        row.result = "[1,2,3]".into();
        assert_eq!(row.report()["parsed_result"], json!([1, 2, 3]));
        row.kind = "move".into();
        row.result = json!({"moved": 5, "failures": []}).to_string();
        let moved = row.report();
        assert!(moved["completeness"]["note"]
            .as_str()
            .unwrap()
            .contains("不包含全部成功文件"));
        assert!(moved["parsed_result"].get("moved_paths").is_none());
    }

    #[test]
    fn history_bounds_and_literal_patterns_are_safe() {
        assert_eq!(history_page(41, i64::MAX, 20), (3, 3, 40));
        assert_eq!(history_page(0, -1, 20), (1, 0, 0));
        assert_eq!(
            history_page(i64::MAX, i64::MAX, 100),
            (92233720368547759, 92233720368547759, 9223372036854775800)
        );
        let query = JobHistoryQuery {
            q: "100%_Mix!'".into(),
            kind: String::new(),
            state: String::new(),
            page: 1,
            page_size: 20,
        };
        assert_eq!(query.pattern(), "%100!%!_Mix!!'%");
    }

    #[test]
    fn job_id_is_12_hex_and_round_trips() {
        let id = new_job_id();
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        let uuid = job_uuid(&id).expect("12 位 hex 必须是合法任务号");
        assert_eq!(job_id_of(&uuid), id);
    }

    #[test]
    fn job_uuid_accepts_dashed_and_simple_forms() {
        let id = "9a1c4d2f7b30";
        let uuid = job_uuid(id).unwrap();
        assert_eq!(job_uuid(&uuid.to_string()).unwrap(), uuid);
        assert_eq!(job_uuid(&uuid.simple().to_string()).unwrap(), uuid);
        assert!(job_uuid("不是hex").is_none());
        assert!(job_uuid("").is_none());
        assert!(job_uuid(&"f".repeat(33)).is_none());
    }

    #[test]
    fn percent_matches_python_rounding() {
        assert_eq!(percent(0, 0), 0.0);
        assert_eq!(percent(340, 1200), 28.3);
        assert_eq!(percent(5, 5), 100.0);
        assert_eq!(percent(0, 7), 0.0);
    }

    #[test]
    fn job_row_json_has_percent_only_when_asked() {
        let row = JobRow {
            id: "9a1c4d2f7b30".into(),
            kind: "scan".into(),
            state: "running".into(),
            total: 10,
            done: 5,
            message: "稻香.flac".into(),
            error: String::new(),
            result: String::new(),
            created_at: 1.0,
            updated_at: 2.0,
        };
        assert_eq!(row.json(true)["percent"], json!(50.0));
        assert!(row.json(false).get("percent").is_none());
        // result 必须是字符串（前端与 e2e 都会二次 JSON.parse）
        assert!(row.json(true)["result"].is_string());
    }
}
