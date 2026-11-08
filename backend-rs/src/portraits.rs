//! Immutable portrait artifacts and lazy external clients. No audio files or
//! Navidrome databases are opened by this feature.
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{ensure, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::Config;
use crate::lastfm_portraits::{LastfmPortraitClient, ProviderError};
use crate::navidrome_portraits;

pub const MAX_PORTRAIT_BYTES: usize = 8 * 1024 * 1024;
pub const CACHE_DAYS: i64 = 7;

pub struct PortraitServices {
    data_dir: PathBuf,
    settings: navidrome_portraits::Settings,
    lastfm: OnceLock<Result<LastfmPortraitClient, ProviderError>>,
    navidrome: OnceLock<Result<navidrome_portraits::Client, String>>,
    pub fetch_lock: Mutex<()>,
}

impl PortraitServices {
    pub fn new(config: &Config) -> Self {
        Self {
            data_dir: config.data_dir.clone(),
            settings: navidrome_portraits::Settings {
                url: config.navidrome_url.clone(),
                username: config.navidrome_username.clone(),
                password: config.navidrome_password.clone(),
            },
            lastfm: OnceLock::new(),
            navidrome: OnceLock::new(),
            fetch_lock: Mutex::new(()),
        }
    }

    pub fn lastfm(&self) -> Result<&LastfmPortraitClient, ProviderError> {
        self.lastfm
            .get_or_init(|| LastfmPortraitClient::new(&self.data_dir))
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn configured(&self) -> bool {
        !self.settings.url.trim().is_empty()
            && !self.settings.username.trim().is_empty()
            && !self.settings.password.is_empty()
    }

    pub fn navidrome(&self) -> anyhow::Result<&navidrome_portraits::Client> {
        ensure!(self.configured(), "请配置 METATIDY_NAVIDROME_URL、METATIDY_NAVIDROME_USERNAME 和 METATIDY_NAVIDROME_PASSWORD 后重启服务");
        self.navidrome
            .get_or_init(|| {
                navidrome_portraits::Client::new(self.settings.clone())
                    .map_err(|error| error.to_string())
            })
            .as_ref()
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    pub fn public_url(&self) -> Option<String> {
        let mut url = reqwest::Url::parse(&self.settings.url).ok()?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        url.set_query(None);
        Some(url.to_string().trim_end_matches('/').to_string())
    }

    pub fn destination(&self) -> String {
        digest(
            format!(
                "{}\n{}",
                self.settings.url.trim_end_matches('/'),
                self.settings.username
            )
            .as_bytes(),
        )
    }

    pub fn artifact_dir(&self) -> PathBuf {
        self.data_dir.join("artist-portraits")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Portrait {
    pub id: Uuid,
    pub artist: String,
    pub source_page: String,
    pub source_image: String,
    pub width: i32,
    pub height: i32,
    pub created_at: f64,
    pub preview_url: String,
    pub preview_format: String,
    pub upload_format: String,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn cache_key(artist: &str, image: Option<&str>) -> String {
    digest(
        serde_json::to_string(&(artist, image))
            .expect("string tuple")
            .as_bytes(),
    )
}

pub fn normalize_artist(value: &str) -> anyhow::Result<String> {
    let artist = value.trim();
    ensure!(
        !artist.is_empty()
            && artist.chars().count() <= 200
            && !artist.chars().any(char::is_control),
        "歌手名称须为 1–200 个字符，不能含控制字符"
    );
    Ok(artist.to_owned())
}

/// Names are generated UUIDs, never source URLs, artist names or target IDs.
pub fn save_artifacts(directory: &Path, id: Uuid, jpeg: &[u8], avif: &[u8]) -> anyhow::Result<()> {
    fs::create_dir_all(directory).context("无法创建歌手头像缓存目录")?;
    for (extension, bytes) in [("jpg", jpeg), ("avif", avif)] {
        ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_PORTRAIT_BYTES,
            "头像缓存大小不合法"
        );
        let path = directory.join(format!("{id}.{extension}"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .context("无法写入歌手头像缓存")?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    Ok(())
}

pub fn read_artifact(
    directory: &Path,
    id: Uuid,
    preview: bool,
    expected: &str,
) -> anyhow::Result<Vec<u8>> {
    let path = directory.join(format!("{id}.{}", if preview { "avif" } else { "jpg" }));
    let metadata = fs::symlink_metadata(&path).context("头像缓存已丢失，请重新获取")?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() <= MAX_PORTRAIT_BYTES as u64,
        "头像缓存文件不合法"
    );
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((MAX_PORTRAIT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_PORTRAIT_BYTES && digest(&bytes) == expected,
        "头像缓存校验失败，请重新获取后预览"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_identity_distinguishes_names_and_manual_sources() {
        assert_ne!(cache_key("A", Some("B")), cache_key("AB", None));
        assert_ne!(cache_key("A", None), cache_key("a", None));
        assert_eq!(normalize_artist(" Radiohead ").unwrap(), "Radiohead");
        for value in ["", "x\ny"] {
            assert!(normalize_artist(value).is_err());
        }
        assert!(normalize_artist(&"字".repeat(201)).is_err());
    }

    #[test]
    fn artifact_integrity_rejects_changes_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("metatidy-portrait-{}", Uuid::new_v4()));
        let id = Uuid::new_v4();
        save_artifacts(&dir, id, b"jpeg", b"avif").unwrap();
        assert_eq!(
            read_artifact(&dir, id, false, &digest(b"jpeg")).unwrap(),
            b"jpeg"
        );
        assert!(save_artifacts(&dir, id, b"new", b"new").is_err());
        fs::write(dir.join(format!("{id}.jpg")), b"changed").unwrap();
        assert!(read_artifact(&dir, id, false, &digest(b"jpeg")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
