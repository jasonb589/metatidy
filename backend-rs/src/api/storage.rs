//! On-demand storage diagnostics. Never expose connection strings or change
//! permissions. Only the explicit POST probe creates and removes test files.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::Json;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::AppState;

use super::ApiResult;

const MAX_ENTRIES: usize = 50_000;
const STATS_BUDGET: Duration = Duration::from_secs(2);
static WORKER: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

#[derive(Debug, Serialize)]
struct CacheStats {
    path: String,
    exists: bool,
    files: u64,
    bytes: u64,
    truncated: bool,
    error: String,
}

fn cache_stats(path: &Path, deadline: Instant, limit: usize) -> CacheStats {
    let mut stats = CacheStats {
        path: path.to_string_lossy().into_owned(),
        exists: false,
        files: 0,
        bytes: 0,
        truncated: false,
        error: String::new(),
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return stats,
        Err(error) => {
            stats.error = error.to_string();
            return stats;
        }
    };
    stats.exists = true;
    // Cache files are flat; do not traverse audio storage or follow symlinks.
    // The budget bounds enumeration, not the duration of an individual OS call.
    for (index, entry) in entries.enumerate() {
        if index >= limit || Instant::now() >= deadline {
            stats.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                stats.error = error.to_string();
                stats.truncated = true;
                continue;
            }
        };
        let path = entry.path();
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !matches!(
            extension,
            "avif" | "original" | "jpg" | "jpeg" | "png" | "webp" | "gif"
        ) {
            continue;
        }
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => {
                stats.files += 1;
                stats.bytes = stats.bytes.saturating_add(meta.len());
            }
            Ok(_) => {}
            Err(error) => {
                stats.error = error.to_string();
                stats.truncated = true;
            }
        }
    }
    stats
}

#[derive(Debug, Serialize)]
struct WriteCheck {
    path: String,
    state: &'static str,
    error: String,
}

fn check_write(path: &Path) -> WriteCheck {
    let probe = path.join(format!(".metatidy-probe-{}", uuid::Uuid::new_v4().simple()));
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        fs::create_dir_all(path)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        created = true;
        file.write_all(b"1")?;
        file.sync_all()?;
        Ok(())
    })();
    // Cleanup is attempted even when the write failed (e.g. disk full).
    let cleanup = if created {
        fs::remove_file(&probe)
    } else {
        Ok(())
    };
    let error = match (result, cleanup) {
        (Ok(()), Ok(())) => String::new(),
        (Err(error), Ok(())) => error.to_string(),
        (Ok(()), Err(error)) => format!("测试文件清理失败：{error}"),
        (Err(write), Err(cleanup)) => format!("写入失败：{write}；测试文件清理失败：{cleanup}"),
    };
    WriteCheck {
        path: path.to_string_lossy().into_owned(),
        state: if error.is_empty() { "ok" } else { "error" },
        error,
    }
}

pub async fn info(State(state): State<AppState>) -> ApiResult {
    inspect(state, false).await
}

pub async fn check(State(state): State<AppState>) -> ApiResult {
    inspect(state, true).await
}

async fn inspect(state: AppState, write_probe: bool) -> ApiResult {
    let connected = matches!(
        tokio::time::timeout(
            Duration::from_secs(3),
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db)
        )
        .await,
        Ok(Ok(1))
    );
    let worker = WORKER
        .clone()
        .acquire_owned()
        .await
        .map_err(anyhow::Error::from)?;
    let config = state.config;
    let report = tokio::task::spawn_blocking(move || {
        let _worker = worker;
        let covers = config.cover_cache_dir();
        let thumbs = config.thumb_cache_dir();
        let write_checks = write_probe.then(|| {
            [&config.data_dir, &covers, &thumbs]
                .into_iter()
                .map(|path| check_write(path))
                .collect::<Vec<_>>()
        });
        let music_exists = config.music_dir.is_dir();
        let deadline = Instant::now() + STATS_BUDGET;
        json!({
            "checked_at": chrono::Utc::now().timestamp(),
            "database": {
                "engine": "PostgreSQL", "connected": connected,
                "stores": ["曲库索引", "应用设置", "别名", "任务记录"],
            },
            "music": { "path": config.music_dir, "exists": music_exists },
            "cache": {
                "root": config.data_dir, "format": "AVIF", "on_demand": true,
                "originals": cache_stats(&covers, deadline, MAX_ENTRIES),
                "thumbnails": cache_stats(&thumbs, deadline, MAX_ENTRIES),
            },
            "runtime": { "container": Path::new("/.dockerenv").exists() },
            "write_checks": write_checks,
        })
    })
    .await
    .map_err(anyhow::Error::from)?;
    Ok(Json(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_are_read_only_and_count_only_flat_cache_images() {
        let root = std::env::temp_dir().join(format!("metatidy-storage-{}", uuid::Uuid::new_v4()));
        let missing = cache_stats(&root, Instant::now() + STATS_BUDGET, MAX_ENTRIES);
        assert!(!missing.exists);
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        fs::write(root.join("1-128.avif"), b"avif bytes").unwrap();
        fs::write(root.join("1-128.avif.json"), b"sidecar").unwrap();
        fs::write(root.join("unfinished.tmp"), b"partial").unwrap();
        fs::create_dir(root.join("nested.avif")).unwrap();
        let stats = cache_stats(&root, Instant::now() + STATS_BUDGET, MAX_ENTRIES);
        assert!(stats.exists);
        assert_eq!(stats.files, 1);
        assert_eq!(stats.bytes, 10);
        assert!(stats.error.is_empty());
        assert!(cache_stats(&root, Instant::now() + STATS_BUDGET, 0).truncated);
        fs::remove_file(root.join("1-128.avif")).unwrap();
        fs::remove_file(root.join("1-128.avif.json")).unwrap();
        fs::remove_file(root.join("unfinished.tmp")).unwrap();
        fs::remove_dir(root.join("nested.avif")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn probe_cleans_up_and_reports_non_directory_errors() {
        let root =
            std::env::temp_dir().join(format!("metatidy-probe-test-{}", uuid::Uuid::new_v4()));
        let checked = check_write(&root);
        assert_eq!(checked.state, "ok");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let file = root.join("blocked");
        fs::write(&file, b"existing file").unwrap();
        let failed = check_write(&file);
        assert_eq!(failed.state, "error");
        assert!(!failed.error.is_empty());
        assert_eq!(fs::read(&file).unwrap(), b"existing file");
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
