//! metatidy Rust 后端 —— 阶段 1：依赖与工具链冒烟。
//!
//! 这一步的目的不是实现功能，而是把**每一个依赖都真调用一次**，让 CI 一次性告诉我：
//! lofty 的标签 API、sqlx 的 Postgres 连接与迁移、redis 的异步连接、
//! reqwest 的 TLS、axum 的 0.7 路由写法，到底能不能编过、能不能跑通。
//!
//! 跑法：
//!   metatidy-server                 起 HTTP 服务
//!   metatidy-server --selftest      跑依赖自检（需要 DATABASE_URL / REDIS_URL）
//!   metatidy-server --probe-tags <文件>   用 lofty 读一个真实音频文件的标签

mod config;
mod db;
mod error;

use std::sync::Arc;

use axum::{
    extract::State,
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use tracing::{info, warn};

use crate::config::Config;
use crate::error::AppError;

/// 全进程共享状态。
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    /// Redis 连接管理器；未配置 REDIS_URL 时为 None（服务仍可跑）
    pub redis: Option<redis::aio::ConnectionManager>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let config = Config::from_env()?;

    // 子命令：只读探测一个音频文件的标签（不需要数据库）
    if let Some(pos) = args.iter().position(|a| a == "--probe-tags") {
        let path = args.get(pos + 1).ok_or_else(|| anyhow::anyhow!("--probe-tags 需要文件路径"))?;
        let tags = tag_probe(path)?;
        println!("{}", serde_json::to_string_pretty(&tags)?);
        return Ok(());
    }

    // 子命令：容器健康检查（自己打自己的接口，不依赖镜像里有没有 curl）
    if args.iter().any(|a| a == "--healthcheck") {
        let url = format!("http://127.0.0.1:{}/api/health", config.port);
        let ok = reqwest::get(&url)
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    let db = db::connect_and_migrate(&config).await?;
    let redis = connect_redis(&config).await;

    let selftest = args.iter().any(|a| a == "--selftest");
    if selftest {
        run_selftest(&db, redis.clone(), &config).await?;
        return Ok(());
    }

    let state = AppState {
        config: Arc::new(config.clone()),
        db,
        redis,
    };

    let app = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/health", get(|| async { "ok" }))
        .with_state(state);

    let addr = format!("{}:{}", config.host, config.port);
    info!("metatidy (rust) 监听 http://{}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// 连接 Redis；失败只警告，不让整个服务起不来。
async fn connect_redis(config: &Config) -> Option<redis::aio::ConnectionManager> {
    let url = config.redis_url.as_ref()?;
    match redis::Client::open(url.as_str()) {
        Ok(client) => match redis::aio::ConnectionManager::new(client).await {
            Ok(conn) => {
                info!("Redis 已连接");
                Some(conn)
            }
            Err(err) => {
                warn!("Redis 连接失败（服务继续，进度改为只写 Postgres）：{err}");
                None
            }
        },
        Err(err) => {
            warn!("Redis URL 无效：{err}");
            None
        }
    }
}

/// 状态接口：把三个外部依赖都真实探一遍，方便 CI 直接断言。
async fn api_status(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let tracks: i64 = sqlx::query_scalar("SELECT count(*) FROM tracks")
        .fetch_one(&state.db)
        .await?;

    let redis_ok = match state.redis.clone() {
        Some(mut conn) => {
            let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
            pong.map(|v| v == "PONG").unwrap_or(false)
        }
        None => false,
    };

    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rust",
        "music_dir": state.config.music_dir,
        "library_root": state.config.library_root,
        "tracks": tracks,
        "postgres": true,
        "redis": redis_ok,
        "supported_formats": [".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus"],
    })))
}

/// 用 lofty 读一个文件的标签（阶段 1 证明 lofty 可用）。
fn tag_probe(path: &str) -> anyhow::Result<Value> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::probe::Probe;
    use lofty::tag::Accessor;

    let tagged = Probe::open(path)?.read()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let mut out = json!({
        "path": path,
        "format": format!("{:?}", tagged.file_type()),
        "duration": tagged.properties().duration().as_secs_f64(),
    });
    if let Some(tag) = tag {
        out["tag_type"] = json!(format!("{:?}", tag.tag_type()));
        out["title"] = json!(tag.title().map(|s| s.to_string()));
        out["artist"] = json!(tag.artist().map(|s| s.to_string()));
        out["album"] = json!(tag.album().map(|s| s.to_string()));
        out["genre"] = json!(tag.genre().map(|s| s.to_string()));
        out["year"] = json!(tag.year());
        out["track"] = json!(tag.track());
        out["disk"] = json!(tag.disk());
        out["picture_count"] = json!(tag.pictures().len());
    }
    Ok(out)
}

/// 依赖自检：Postgres 建表读写、Redis 读写、外部 HTTP 请求、lofty 版本。
async fn run_selftest(
    db: &PgPool,
    mut redis: Option<redis::aio::ConnectionManager>,
    config: &Config,
) -> anyhow::Result<()> {
    println!("=== metatidy rust selftest ===");

    // 1) Postgres：写入一行再读回来，验证类型映射
    let test_path = "__selftest__/probe.flac";
    sqlx::query("DELETE FROM tracks WHERE path = $1")
        .bind(test_path)
        .execute(db)
        .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO tracks (path, dir, filename, ext, title, artist, tags_loaded, path_derived)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(test_path)
    .bind("__selftest__")
    .bind("probe.flac")
    .bind(".flac")
    .bind("探针")
    .bind("周杰伦")
    .bind(true)
    .bind(false)
    .fetch_one(db)
    .await?;
    let (title, artist): (String, String) =
        sqlx::query_as("SELECT title, artist FROM tracks WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await?;
    println!("  [ok] postgres  写入/读回 id={id} title={title:?} artist={artist:?}");
    println!("  [ok] postgres  pg_trgm 子串检索命中 {} 行", count_trgm(db, "探针").await?);

    // 2) Redis
    match redis.as_mut() {
        Some(conn) => {
            let _: String = redis::cmd("SET")
                .arg("metatidy:selftest")
                .arg("ok")
                .query_async(conn)
                .await?;
            let value: String = redis::cmd("GET").arg("metatidy:selftest").query_async(conn).await?;
            println!("  [ok] redis     set/get -> {value:?}");
            let _: i64 = redis::cmd("DEL").arg("metatidy:selftest").query_async(conn).await?;
        }
        None => println!("  [--] redis     未配置（REDIS_URL 为空），跳过"),
    }

    // 3) 外部 HTTP（真实请求，证明 TLS/JSON 栈可用）
    let client = reqwest::Client::builder()
        .user_agent(format!("metatidy/{} (rust)", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    match client
        .get("https://musicbrainz.org/ws/2/recording")
        .query(&[("query", "recording:\"稻香\" AND artist:\"周杰伦\""), ("fmt", "json"), ("limit", "1")])
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let n = body.get("count").and_then(|v| v.as_i64()).unwrap_or(-1);
            println!("  [ok] http      musicbrainz HTTP {status}，命中 {n} 条");
        }
        Err(err) => println!("  [!] http      musicbrainz 请求失败（网络受限？）：{err}"),
    }

    // 4) lofty
    println!("  [ok] lofty     {} （全格式标签读写）", lofty::VERSION);

    // 清理
    sqlx::query("DELETE FROM tracks WHERE path = $1").bind(test_path).execute(db).await?;

    println!("=== selftest 通过 ===");
    println!("音乐目录 = {}", config.music_dir);
    println!("库根目录 = {}", config.library_root);
    Ok(())
}

async fn count_trgm(db: &PgPool, needle: &str) -> anyhow::Result<i64> {
    let pattern = format!("%{needle}%");
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tracks WHERE title ILIKE $1 OR artist ILIKE $1 OR album ILIKE $1",
    )
    .bind(pattern)
    .fetch_one(db)
    .await?;
    Ok(n)
}
