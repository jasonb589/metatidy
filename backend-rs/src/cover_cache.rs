//! On-demand AVIF thumbnails. Index revisions invalidate caches without stat'ing
//! every audio file on a cloud mount. Disk/tag/codec work stays off Tokio workers.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{ensure, Context};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::{config::Config, cover_images, models::Track, tagio};

const CACHE_VERSION: u8 = 1;
const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
// Encoding is single-threaded. At most two files are read/decoded at a time,
// including after an HTTP client disconnects while spawn_blocking is running.
static WORKERS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));
// Bounded lock storage: a second request for the same track rechecks the cache
// after the first has published it, instead of repeating an expensive encode.
static TRACK_LOCKS: Lazy<Vec<Arc<Semaphore>>> =
    Lazy::new(|| (0..64).map(|_| Arc::new(Semaphore::new(1))).collect());

pub struct CoverData {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Serialize, Deserialize)]
struct CacheMeta {
    version: u8,
    fingerprint: String,
    digest: String,
    mime: String,
}

/// Positive legacy sizes (48/64 etc.) share a 128px cache. There are only three
/// bounded variants per track; zero keeps the original image bytes unchanged.
pub fn thumbnail_edge(size: i64) -> Option<u32> {
    match size {
        0 => Some(0),
        1..=128 => Some(128),
        129..=256 => Some(256),
        257..=512 => Some(512),
        _ => None,
    }
}

pub async fn load(
    config: Arc<Config>,
    track: Track,
    edge: u32,
) -> anyhow::Result<Option<CoverData>> {
    let slot = (track.id.unsigned_abs() % TRACK_LOCKS.len() as u64) as usize;
    let track_lock = TRACK_LOCKS[slot].clone().acquire_owned().await?;
    let worker = WORKERS.clone().acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _track_lock = track_lock;
        let _worker = worker;
        load_blocking(&config, &track, edge)
    })
    .await
    .context("封面处理任务失败")?
}

fn fingerprint(track: &Track, edge: u32) -> String {
    // indexed_at also invalidates after a forced rescan even when an external
    // tag editor preserves the audio file's size and modification timestamp.
    let value = serde_json::json!([
        CACHE_VERSION,
        track.id,
        track.path,
        track.mtime.to_bits(),
        track.size,
        track.indexed_at,
        track.edited_at,
        track.scraped_at,
        edge,
    ]);
    digest(value.to_string().as_bytes())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn cache_path(config: &Config, id: i64, edge: u32) -> PathBuf {
    if edge == 0 {
        config.cover_cache_dir().join(format!("{id}.original"))
    } else {
        config.thumb_cache_dir().join(format!("{id}-{edge}.avif"))
    }
}

fn meta_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.json",
        path.extension().unwrap_or_default().to_string_lossy()
    ))
}

fn read_limited(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn read_cache(path: &Path, expected: &str, edge: u32) -> Option<CoverData> {
    let meta: CacheMeta = serde_json::from_slice(&read_limited(&meta_path(path), 4096)?).ok()?;
    if meta.version != CACHE_VERSION || meta.fingerprint != expected {
        return None;
    }
    let bytes = read_limited(path, MAX_CACHE_BYTES)?;
    if bytes.is_empty() || meta.digest != digest(&bytes) {
        return None;
    }
    let detected = cover_images::detected_mime(&bytes)?;
    if meta.mime != detected || (edge > 0 && detected != "image/avif") {
        return None;
    }
    Some(CoverData {
        bytes,
        mime: meta.mime,
    })
}

fn load_blocking(config: &Config, track: &Track, edge: u32) -> anyhow::Result<Option<CoverData>> {
    ensure!(matches!(edge, 0 | 128 | 256 | 512), "无效的缩略图尺寸");
    let path = cache_path(config, track.id, edge);
    let revision = fingerprint(track, edge);
    if let Some(hit) = read_cache(&path, &revision, edge) {
        return Ok(Some(hit));
    }

    let original_path = cache_path(config, track.id, 0);
    let original_revision = fingerprint(track, 0);
    let original = if let Some(hit) = read_cache(&original_path, &original_revision, 0) {
        hit
    } else {
        let Some((bytes, _tag_mime)) = tagio::read_cover(Path::new(&track.path)) else {
            return Ok(None);
        };
        let mime = cover_images::detected_mime(&bytes).context("无法识别内嵌封面的图片格式")?;
        ensure!(
            bytes.len() as u64 <= MAX_CACHE_BYTES,
            "封面超过 32 MiB，无法生成缓存"
        );
        CoverData {
            bytes,
            mime: mime.to_string(),
        }
    };
    let data = if edge == 0 {
        original
    } else {
        CoverData {
            bytes: cover_images::encode_thumbnail(&original.bytes, edge)?,
            mime: "image/avif".to_string(),
        }
    };
    // A read-only/full cache volume must not prevent displaying the image.
    // Only retire legacy mislabeled .jpg caches after a successful replacement.
    match write_cache(&path, &revision, &data) {
        Ok(()) => {
            let legacy_dir = if edge == 0 {
                config.cover_cache_dir()
            } else {
                config.thumb_cache_dir()
            };
            let _ = fs::remove_file(legacy_dir.join(format!("{}.jpg", track.id)));
        }
        Err(err) => tracing::warn!(track_id = track.id, "封面缓存写入失败（仍返回图片）：{err}"),
    }
    Ok(Some(data))
}

fn write_cache(path: &Path, fingerprint: &str, data: &CoverData) -> anyhow::Result<()> {
    let meta = CacheMeta {
        version: CACHE_VERSION,
        fingerprint: fingerprint.to_string(),
        digest: digest(&data.bytes),
        mime: data.mime.clone(),
    };
    fs::create_dir_all(path.parent().context("缓存路径缺少父目录")?)?;
    atomic_write(path, &data.bytes)?;
    // Publish metadata last. Digest verification rejects interrupted or mixed
    // image/metadata pairs, including concurrent processes sharing a data volume.
    atomic_write(&meta_path(path), &serde_json::to_vec(&meta)?)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| -> anyhow::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!("metatidy-cover-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn sizes_are_bounded_and_legacy_requests_share_a_variant() {
        for n in [1, 48, 64, 128] {
            assert_eq!(thumbnail_edge(n), Some(128));
        }
        assert_eq!(thumbnail_edge(0), Some(0));
        assert_eq!(thumbnail_edge(129), Some(256));
        assert_eq!(thumbnail_edge(512), Some(512));
        for n in [-1, 513, i64::MAX] {
            assert_eq!(thumbnail_edge(n), None);
        }
    }

    #[test]
    fn revisions_include_path_size_timestamps_and_variant() {
        let track = Track {
            id: 1,
            path: "/music/a.flac".into(),
            size: 12,
            mtime: 10.0,
            ..Default::default()
        };
        let original = fingerprint(&track, 128);
        assert_ne!(original, fingerprint(&track, 256));
        let mut changed = track.clone();
        changed.path = "/music/b.flac".into();
        assert_ne!(original, fingerprint(&changed, 128));
        changed = track.clone();
        changed.size += 1;
        assert_ne!(original, fingerprint(&changed, 128));
        changed = track.clone();
        changed.mtime += 1.0;
        assert_ne!(original, fingerprint(&changed, 128));
        changed = track.clone();
        changed.scraped_at = Some(chrono::Utc::now());
        assert_ne!(original, fingerprint(&changed, 128));
        changed = track;
        changed.indexed_at = Some(chrono::Utc::now());
        assert_ne!(original, fingerprint(&changed, 128));
    }

    #[test]
    fn cache_rejects_old_revision_corruption_and_incomplete_publish() {
        let root = scratch();
        let path = root.join("1-128.avif");
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12, 8)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bytes = cover_images::encode_thumbnail(png.get_ref(), 128).unwrap();
        let data = CoverData {
            bytes,
            mime: "image/avif".into(),
        };
        write_cache(&path, "revision-a", &data).unwrap();
        assert_eq!(
            read_cache(&path, "revision-a", 128).unwrap().bytes,
            data.bytes
        );
        assert!(read_cache(&path, "revision-b", 128).is_none());
        fs::write(&path, b"partial image").unwrap();
        assert!(read_cache(&path, "revision-a", 128).is_none());
        write_cache(&path, "revision-b", &data).unwrap();
        assert!(read_cache(&path, "revision-b", 128).is_some());
        fs::remove_file(meta_path(&path)).unwrap();
        assert!(read_cache(&path, "revision-b", 128).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
