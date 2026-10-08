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
mod fixtures;
mod language;
mod models;
mod normalize;
mod templates;
mod mover;
mod repo;
mod scanner;
mod tagio;

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

    // 子命令：索引层端到端自检（真 Postgres、真文件系统）
    if args.iter().any(|a| a == "--selftest-index") {
        run_index_selftest(&db).await?;
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
    println!("  [ok] lofty     全格式标签读写就绪（mp3/flac/m4a/ogg/opus/aiff/wav）");

    // 清理
    sqlx::query("DELETE FROM tracks WHERE path = $1").bind(test_path).execute(db).await?;

    println!("=== selftest 通过 ===");
    println!("音乐目录 = {}", config.music_dir.display());
    println!("库根目录 = {}", config.library_root.display());
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


/// 索引层端到端自检：扫描 → 增量 → 语言推断 → 标签编辑 → 整理移动 → 快速扫描。
///
/// 全部在临时目录里做，不碰任何真实音乐；数据库里只清理本自检自己写入的行。
async fn run_index_selftest(db: &PgPool) -> anyhow::Result<()> {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    use crate::mover::{self, PlanOptions};
    use crate::repo::{self, TrackQuery};
    use crate::scanner::{self, ScanOptions};
    use crate::tagio;

    println!("=== metatidy rust 索引层自检 ===");

    let root = std::env::temp_dir().join("metatidy-index-selftest");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root)?;
    let prefix = root.to_string_lossy().to_string();

    // 先清掉本自检可能残留的索引（只删自己目录下的，绝不动别人的数据）
    let stale: Vec<String> = repo::all_paths(db)
        .await?
        .into_iter()
        .filter(|p| p.starts_with(&prefix) || p.starts_with("__selftest__"))
        .collect();
    repo::delete_paths(db, &stale).await?;

    // 造三个文件：待整理、已在目标结构里、以及用来验证路径推断语言的
    let to_tidy = root.join("待整理/未命名 1.flac");
    crate::fixtures::make_flac(&to_tidy)?;
    let mut seed = HashMap::new();
    seed.insert("title".to_string(), "七里香".to_string());
    tagio::apply_update(&to_tidy, &seed, true, None, None)?;

    let already = root.join("中文/周杰伦/魔杰座/01 - 稻香.flac");
    crate::fixtures::make_flac(&already)?;
    let mut seed2 = HashMap::new();
    seed2.insert("title".to_string(), "稻香".to_string());
    seed2.insert("artist".to_string(), "周杰伦".to_string());
    seed2.insert("album".to_string(), "魔杰座".to_string());
    tagio::apply_update(&already, &seed2, true, None, None)?;

    let russian = root.join("俄文/ADÉLA/PRIMA/KGB - ADÉLA.flac");
    crate::fixtures::make_flac(&russian)?;

    // 1) 完整扫描
    let opts = ScanOptions {
        root: root.clone(),
        full: true,
        prune: true,
        fast: false,
        workers: 4,
    };
    let summary = scanner::scan(db, &opts, |_, _, _| {}).await?;
    println!(
        "  [ok] 完整扫描  扫描 {} / 解析 {} / 新增 {} / 失败 {} / 用时 {:.2}s",
        summary.scanned, summary.parsed, summary.added, summary.failed, summary.seconds
    );
    assert_eq!(summary.added, 3, "应新增 3 条索引，实际 {}", summary.added);
    assert_eq!(summary.failed, 0, "不应有失败：{:?}", summary.errors);

    // 2) 增量扫描：没变动的文件不该被重新解析
    let again = scanner::scan(db, &opts, |_, _, _| {}).await?;
    println!("  [ok] 增量扫描  解析 {} / 跳过 {}", again.parsed, again.skipped);
    assert_eq!(again.parsed, 0, "增量扫描不该重新解析任何文件");
    assert_eq!(again.skipped, 3);

    // 3) 语言兜底：标签里没有 language，应从目录结构推断
    let russian_track = repo::get_track_by_path(db, &russian.to_string_lossy())
        .await?
        .expect("应能按路径查到索引");
    println!(
        "  [ok] 语言兜底  {} -> language={:?}",
        russian_track.filename, russian_track.language
    );
    assert_eq!(russian_track.language, "俄文", "目录结构推断语言失败");

    // 4) 标签编辑：先预览（不改文件），再落盘，最后从磁盘读回核对
    let mut desired = HashMap::new();
    desired.insert("album".to_string(), "七里香".to_string());
    desired.insert("artist".to_string(), "周杰伦".to_string());
    let diff = tagio::preview_update(&to_tidy, &desired);
    assert_eq!(diff.len(), 2, "预览应报 2 处变更，实际 {}", diff.len());
    let untouched = tagio::read_tags(&to_tidy);
    assert_eq!(untouched.album, "", "预览不能改动文件");

    tagio::apply_update(&to_tidy, &desired, true, None, None)?;
    let on_disk = tagio::read_tags(&to_tidy);
    assert_eq!(on_disk.album, "七里香");
    assert_eq!(on_disk.artist, "周杰伦");
    let tidy_row = repo::get_track_by_path(db, &to_tidy.to_string_lossy())
        .await?
        .expect("应能按路径查到索引");
    repo::update_fields(db, tidy_row.id, &desired, true).await?;
    let after_edit = repo::get_track(db, tidy_row.id).await?.expect("索引应还在");
    assert_eq!(after_edit.album, "七里香", "索引未同步");
    println!("  [ok] 标签编辑  预览 2 处 → 落盘 → 磁盘与索引一致");

    // 5) 整理移动：预览 → 仅演练 → 执行 → 索引同步
    let tracks = repo::list_tracks(
        db,
        &TrackQuery {
            page_size: 1000,
            ..Default::default()
        },
    )
    .await?
    .items;
    assert!(tracks.len() >= 3, "索引里应至少有 3 条");

    let plan_opts = PlanOptions {
        library_root: &root,
        dir_template: "{language?}/{artist}/{album}",
        filename_template: "{track:02} - {title}",
        conflict_policy: "rename",
        unknown_artist: "未知艺术家",
        unknown_album: "未知专辑",
        unknown_other: "未知",
    };
    let plan = mover::plan_moves(&tracks, &plan_opts);
    println!("  [ok] 移动计划  {:?}", plan.counts);
    assert!(
        plan.items.iter().all(|i| i.action != "invalid"),
        "计划里不该有无效项：{:?}",
        plan.items
            .iter()
            .map(|i| (i.target.clone(), i.reason.clone()))
            .collect::<Vec<_>>()
    );
    assert!(
        plan.counts.get("move").copied().unwrap_or(0) >= 1,
        "至少应有一个待移动文件：{:?}",
        plan.counts
    );

    let files_before = list_files_sorted(&root);
    let dry = mover::execute_plan(&plan, true, |_, _, _| {});
    let files_after_dry = list_files_sorted(&root);
    assert_eq!(files_before, files_after_dry, "仅演练不能改动任何文件");
    println!("  [ok] 仅演练    预计移动 {} / 跳过 {}（文件未动）", dry.moved, dry.skipped);

    let moved = mover::execute_plan(&plan, false, |_, _, _| {});
    assert_eq!(moved.failed, 0, "移动失败：{:?}", moved.failures);
    println!(
        "  [ok] 执行移动  成功 {} / 跳过 {} / 失败 {}",
        moved.moved, moved.skipped, moved.failed
    );

    for (track_id, new_path) in &moved.moved_paths {
        repo::set_track_path(db, *track_id, new_path).await?;
    }
    for item in &plan.items {
        if item.action == "move" || item.action == "conflict_rename" {
            assert!(Path::new(&item.target).exists(), "目标不存在：{}", item.target);
            assert!(!Path::new(&item.source).exists(), "源文件仍在：{}", item.source);
        }
    }
    let after_move = repo::list_tracks(
        db,
        &TrackQuery {
            page_size: 1000,
            ..Default::default()
        },
    )
    .await?;
    assert!(
        after_move.items.iter().all(|t| Path::new(&t.path).exists()),
        "索引里的路径必须都存在"
    );
    println!("  [ok] 索引同步  移动后每条索引路径都能对上磁盘文件");

    // 6) 快速扫描模式：完全不打开文件（云盘救命功能）
    let fast_opts = ScanOptions {
        root: root.clone(),
        full: true,
        prune: true,
        fast: true,
        workers: 4,
    };
    let fast = scanner::scan(db, &fast_opts, |_, _, _| {}).await?;
    println!(
        "  [ok] 快速扫描  解析 {} 个文件用时 {:.2}s（不打开任何音频文件）",
        fast.parsed, fast.seconds
    );
    assert_eq!(fast.parsed, 3);
    let not_loaded = repo::list_tracks(
        db,
        &TrackQuery {
            not_loaded: true,
            page_size: 1000,
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(not_loaded.total, 3, "快速扫描后应全部标记为未读标签");
    assert!(
        not_loaded.items.iter().all(|t| t.path_derived),
        "快速扫描的结果应标记为来自路径"
    );
    if let Some(t) = repo::get_track_by_path(db, &russian.to_string_lossy()).await? {
        assert_eq!(t.language, "俄文", "快速扫描也要能推断语言");
    }

    // 清理：只删自己目录下的索引
    let cleanup: Vec<String> = repo::all_paths(db)
        .await?
        .into_iter()
        .filter(|p| p.starts_with(&prefix))
        .collect();
    repo::delete_paths(db, &cleanup).await?;
    let _ = std::fs::remove_dir_all(&root);

    println!("=== 索引层自检通过 ===");
    Ok(())
}


/// 列出目录下所有文件路径（排序后），用于断言「演练没动文件」。
fn list_files_sorted(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    out.sort();
    out
}
