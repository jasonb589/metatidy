//! 运行时配置：全部走环境变量，**与 Python 版同名**，这样同一份 compose 能直接复用。

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Postgres 连接串，例如 postgres://user:pass@host:5432/metatidy
    pub database_url: String,
    /// Redis 连接串；为空则不用 Redis（服务照常跑）
    pub redis_url: Option<String>,
    /// 要扫描的音乐目录
    pub music_dir: PathBuf,
    /// 整理移动的库根（默认同 music_dir）
    pub library_root: PathBuf,
    pub host: String,
    pub port: u16,
    /// 扫描并发：云盘/机械盘场景调大更有用（IO 延迟占主导）
    pub scan_workers: usize,
    /// 单文件标签读取超时（秒），防止卡在慢存储上
    pub read_timeout_secs: u64,
    // ── 可选密钥：不配也不影响主要功能 ──
    pub spotify_client_id: String,
    pub spotify_client_secret: String,
    pub genius_token: String,
    pub discogs_token: String,
    pub lastfm_api_key: String,
    pub siliconflow_key: String,
}

fn env_or(key: &str, default: &str) -> String {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn env_opt(key: &str) -> Option<String> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let music_dir = PathBuf::from(env_or("METATIDY_MUSIC_DIR", "/music"));
        let library_root = PathBuf::from(env_or(
            "METATIDY_LIBRARY_ROOT",
            music_dir.to_string_lossy().as_ref(),
        ));

        let database_url = env_or(
            "DATABASE_URL",
            "postgres://metatidy:metatidy@localhost:5432/metatidy",
        );

        let port: u16 = env_or("METATIDY_PORT", "8080")
            .parse()
            .map_err(|_| anyhow::anyhow!("METATIDY_PORT 不是合法端口"))?;
        let scan_workers: usize = env_or("METATIDY_SCAN_WORKERS", "4")
            .parse()
            .map_err(|_| anyhow::anyhow!("METATIDY_SCAN_WORKERS 不是合法数字"))?;
        let read_timeout_secs: u64 = env_or("METATIDY_READ_TIMEOUT", "60")
            .parse()
            .unwrap_or(60);

        Ok(Self {
            database_url,
            redis_url: env_opt("REDIS_URL").or_else(|| env_opt("METATIDY_REDIS_URL")),
            music_dir,
            library_root,
            host: env_or("METATIDY_HOST", "0.0.0.0"),
            port,
            scan_workers: scan_workers.max(1),
            read_timeout_secs,
            spotify_client_id: env_or("SPOTIFY_CLIENT_ID", ""),
            spotify_client_secret: env_or("SPOTIFY_CLIENT_SECRET", ""),
            genius_token: env_or("GENIUS_TOKEN", ""),
            discogs_token: env_or("DISCOGS_TOKEN", ""),
            lastfm_api_key: env_or("LASTFM_API_KEY", ""),
            siliconflow_key: env_or("SILICONFLOW_KEY", ""),
        })
    }

    /// 数据源是否需要密钥、要不要跳过（给刮削层用）。
    pub fn source_skip_reason(&self, source: &str) -> Option<&'static str> {
        match source {
            "spotify" if self.spotify_client_id.is_empty() || self.spotify_client_secret.is_empty() => {
                Some("Spotify 需要 SPOTIFY_CLIENT_ID 与 SPOTIFY_CLIENT_SECRET，未配置 → 已跳过")
            }
            "genius" if self.genius_token.is_empty() => {
                Some("Genius 需要 GENIUS_TOKEN，未配置 → 已跳过")
            }
            "discogs" if self.discogs_token.is_empty() => {
                Some("Discogs 需要 DISCOGS_TOKEN，未配置 → 已跳过")
            }
            "lastfm" if self.lastfm_api_key.is_empty() => {
                Some("Last.fm 需要 LASTFM_API_KEY，未配置 → 已跳过")
            }
            _ => None,
        }
    }
}
