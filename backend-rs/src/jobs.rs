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

use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sqlx::types::Json as SqlJson;
use sqlx::PgPool;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Semaphore;
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
        // Redis 里的进度比 Postgres 新（Postgres 是节流写的）
        if let Some(live) = self.read_progress(&job.id).await {
            if let Some(v) = live.get("state") {
                job.state = v.clone();
            }
            if let Some(v) = live.get("total").and_then(|v| v.parse::<i64>().ok()) {
                job.total = v;
            }
            if let Some(v) = live.get("done").and_then(|v| v.parse::<i64>().ok()) {
                job.done = v;
            }
            if let Some(v) = live.get("message") {
                job.message = v.clone();
            }
            if let Some(v) = live.get("error") {
                job.error = v.clone();
            }
        }
        Ok(Some(job))
    }

    /// 最近任务（默认 20 条，按 `created_at DESC`）。
    pub async fn list(&self, limit: i64) -> anyhow::Result<Vec<JobRow>> {
        let rows: Vec<(Uuid, String, String, i64, i64, String, String, Option<SqlJson<Value>>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> =
            sqlx::query_as(
                "SELECT id, kind, state, total, done, message, error, result, created_at, updated_at
                 FROM jobs ORDER BY created_at DESC LIMIT $1",
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

    /// 抢并发额度；超时返回 false（调用方写 `state=error`）。
    pub async fn acquire_slot() -> bool {
        tokio::time::timeout(WAIT_TIMEOUT, SEMAPHORE.acquire())
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }
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
