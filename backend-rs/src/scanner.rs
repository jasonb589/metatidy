//! 扫描器：枚举 → 增量判断 → 并行解析 → 写索引。
//!
//! 两种模式，这是本次重构针对「云盘上读一个文件要 10 秒」的核心解法：
//! - **完整模式**（默认）：真读标签，准确；但在云盘/慢盘上，一个文件要等十几秒，
//!   因为驱动器会把整个文件拉下来
//! - **快速模式**：只从目录结构建索引，**完全不打开文件**；一万首 ≈ 24 秒
//!
//! 两种模式共用同一套增量判断（mtime + size），所以之后每次扫描都只处理变动过的文件。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use sqlx::PgPool;
use walkdir::{DirEntry, WalkDir};

use crate::language::infer_language;
use crate::models::ScanSummary;
use crate::repo::{self, TrackUpsert};
use crate::tagio;

/// 支持的音频扩展名（与标签读写层保持一致）。
pub const AUDIO_EXTENSIONS: &[&str] = &[".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus"];

/// 一定要跳过的系统/缓存目录。
const SKIP_DIRS: &[&str] = &[
    "@eaDir",
    "#recycle",
    "$RECYCLE.BIN",
    "System Volume Information",
    "node_modules",
    "__pycache__",
];

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub root: PathBuf,
    /// 忽略 mtime/size，强制重新处理全部文件
    pub full: bool,
    /// 清理磁盘上已不存在的索引
    pub prune: bool,
    /// 快速模式：只从路径建索引，不打开文件
    pub fast: bool,
    /// 并行度：慢盘/云盘调大更有用（瓶颈是 IO 不是 CPU）
    pub workers: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            root: PathBuf::from("/music"),
            full: false,
            prune: true,
            fast: false,
            workers: 4,
        }
    }
}

fn keep_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    if name.starts_with('.') {
        return false;
    }
    !SKIP_DIRS.contains(&name.as_str())
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// 枚举库里的音频文件。
pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(keep_entry)
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_audio_file(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// 从路径推断出来的字段（快速模式用）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PathDerived {
    pub artist: String,
    pub album: String,
    pub title: String,
    pub track: String,
    pub language: String,
}

/// 从「库根下第一层是语言、接着是艺术家 / 专辑」这套常见结构推断字段。
///
/// 推断出来的内容会被标记为 path_derived，等你真正读标签或刮削时会被真值覆盖。
pub fn derive_from_path(path: &Path, root: &Path) -> PathDerived {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();

    let filename = parts.pop().unwrap_or_default();
    let stem = Path::new(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.clone());
    let (track, title) = split_track_prefix(&stem);

    let language = infer_language(path, root);
    let mut dirs = parts;
    if !language.is_empty() && dirs.first().map(|d| d == &language).unwrap_or(false) {
        dirs.remove(0);
    }

    PathDerived {
        artist: dirs.first().cloned().unwrap_or_default(),
        album: if dirs.len() >= 2 {
            dirs[1].clone()
        } else {
            String::new()
        },
        title: if title.is_empty() { stem } else { title },
        track,
        language,
    }
}

/// 从文件名里剥出前导音轨号：`01 - 稻香` → ("01", "稻香")。
fn split_track_prefix(stem: &str) -> (String, String) {
    let trimmed = stem.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 {
        return (String::new(), String::new());
    }
    let rest = &trimmed[digits.len()..];
    let rest_trimmed = rest.trim_start_matches(|c: char| {
        c == '.' || c == '-' || c == '_' || c == ' ' || c == '\u{3000}'
    });
    if rest_trimmed.is_empty() || rest_trimmed.len() == rest.len() {
        return (String::new(), String::new());
    }
    (digits, rest_trimmed.to_string())
}

/// 扫一遍库。`progress(已完成, 总数, 当前文件名)` 由调用方决定怎么展示。
pub async fn scan(
    pool: &PgPool,
    opts: &ScanOptions,
    mut progress: impl FnMut(usize, usize, String),
) -> anyhow::Result<ScanSummary> {
    let started = Instant::now();
    let root = opts.root.clone();
    if !root.exists() {
        anyhow::bail!("音乐目录不存在：{}", root.display());
    }

    let walk_root = root.clone();
    let files = tokio::task::spawn_blocking(move || collect_audio_files(&walk_root)).await?;
    let total = files.len();
    progress(0, total, format!("枚举完成：{total} 个音频文件"));

    let known: HashMap<String, (f64, i64)> = if opts.full {
        HashMap::new()
    } else {
        repo::existing_state(pool).await?
    };

    // 增量判断：mtime 与 size 都没变就不碰这个文件
    let mut pending: Vec<(PathBuf, f64, i64)> = Vec::new();
    for path in &files {
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let size = meta.len() as i64;
        let key = crate::models::path_key(path);
        let unchanged = known
            .get(&key)
            .map(|(prev_mtime, prev_size)| (prev_mtime - mtime).abs() < 1e-6 && *prev_size == size)
            .unwrap_or(false);
        if unchanged {
            continue;
        }
        pending.push((path.clone(), mtime, size));
    }

    let skipped = total - pending.len();
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut done = skipped;
    let mut parse_seconds = 0f64;

    // 分批并行解析：每批 workers 个文件同时在处理，批内并行、批间串行写库
    let workers = opts.workers.max(1);
    for chunk in pending.chunks(workers) {
        let mut handles = Vec::with_capacity(chunk.len());
        for (path, mtime, size) in chunk {
            let path = path.clone();
            let task_root = root.clone();
            let (mtime, size) = (*mtime, *size);
            let fast = opts.fast;
            handles.push(tokio::task::spawn_blocking(move || {
                let t0 = Instant::now();
                let row = build_upsert(&path, mtime, size, &task_root, fast);
                (row, t0.elapsed().as_secs_f64())
            }));
        }

        for handle in handles {
            done += 1;
            match handle.await {
                Ok((Ok(row), secs)) => {
                    parse_seconds += secs;
                    let existed = known.contains_key(&row.path);
                    let filename = row.filename.clone();
                    match repo::upsert_track(pool, &row).await {
                        Ok(()) => {
                            if existed {
                                updated += 1;
                            } else {
                                added += 1;
                            }
                        }
                        Err(err) => {
                            failed += 1;
                            if errors.len() < 20 {
                                errors.push(format!("{}：{err}", row.path));
                            }
                        }
                    }
                    progress(done, total, filename);
                }
                Ok((Err(err), _)) => {
                    failed += 1;
                    if errors.len() < 20 {
                        errors.push(err.to_string());
                    }
                    progress(done, total, String::new());
                }
                Err(join_err) => {
                    failed += 1;
                    if errors.len() < 20 {
                        errors.push(format!("解析任务异常：{join_err}"));
                    }
                    progress(done, total, String::new());
                }
            }
        }
    }

    let mut removed = 0u64;
    if opts.prune {
        let on_disk: HashSet<String> =
            files.iter().map(|p| crate::models::path_key(p)).collect();
        let indexed = repo::all_paths(pool).await?;
        let gone: Vec<String> = indexed.into_iter().filter(|p| !on_disk.contains(p)).collect();
        removed = repo::delete_paths(pool, &gone).await?;
    }

    progress(
        total,
        total,
        format!("完成：新增 {added}，更新 {updated}，移除 {removed}，失败 {failed}"),
    );

    Ok(ScanSummary {
        root: root.to_string_lossy().to_string(),
        scanned: total,
        parsed: pending.len(),
        skipped,
        added,
        updated,
        removed: removed as usize,
        fast_mode: opts.fast,
        seconds: started.elapsed().as_secs_f64(),
        parse_seconds,
        failed,
        errors,
    })
}

/// 生成一条索引记录（在阻塞线程里跑）。
fn build_upsert(
    path: &Path,
    mtime: f64,
    size: i64,
    root: &Path,
    fast: bool,
) -> anyhow::Result<TrackUpsert> {
    let dir = path
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();

    let mut row = TrackUpsert {
        path: crate::models::path_key(path),
        dir,
        filename: filename.clone(),
        ext,
        mtime,
        size,
        ..Default::default()
    };

    if fast {
        let derived = derive_from_path(path, root);
        row.title = derived.title;
        row.artist = derived.artist;
        row.album = derived.album;
        row.track = derived.track;
        row.language = derived.language;
        row.tags_loaded = false;
        row.path_derived = true;
        return Ok(row);
    }

    let tags = tagio::read_tags(path);
    let fallback_title = Path::new(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.clone());

    row.title = if tags.title.trim().is_empty() {
        fallback_title
    } else {
        tags.title.trim().to_string()
    };
    row.artist = tags.artist.trim().to_string();
    row.album = tags.album.trim().to_string();
    row.albumartist = tags.albumartist.trim().to_string();
    row.genre = tags.genre.trim().to_string();
    row.year = tags.year.trim().to_string();
    row.track = tags.track.trim().to_string();
    row.disc = tags.disc.trim().to_string();
    row.composer = tags.composer.trim().to_string();
    row.lyricist = tags.lyricist.trim().to_string();
    row.copyright = tags.copyright.trim().to_string();
    row.albumtype = tags.albumtype.trim().to_string();
    row.comment = tags.comment.trim().to_string();
    row.mb_artist_id = tags.mb_artist_id.trim().to_string();
    row.release_group_id = tags.release_group_id.trim().to_string();
    row.has_cover = tags.has_cover;
    row.has_lyrics = tags.has_lyrics;
    row.duration = tags.duration;
    // 标签里没有语言就用目录结构兜底，避免整理时把语言目录压平
    row.language = if tags.language.trim().is_empty() {
        infer_language(path, root)
    } else {
        tags.language.trim().to_string()
    };
    row.tags_loaded = tags.error.is_none();
    row.path_derived = false;

    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_fields_from_library_layout() {
        let root = PathBuf::from("/lib");
        let d = derive_from_path(Path::new("/lib/中文/周杰伦/魔杰座/03 - 稻香.flac"), &root);
        assert_eq!(d.language, "中文");
        assert_eq!(d.artist, "周杰伦");
        assert_eq!(d.album, "魔杰座");
        assert_eq!(d.title, "稻香");
        assert_eq!(d.track, "03");
    }

    #[test]
    fn derives_without_language_layer() {
        let root = PathBuf::from("/lib");
        let d = derive_from_path(Path::new("/lib/周杰伦/魔杰座/稻香.flac"), &root);
        assert_eq!(d.language, "");
        assert_eq!(d.artist, "周杰伦");
        assert_eq!(d.album, "魔杰座");
        assert_eq!(d.title, "稻香");
    }

    #[test]
    fn derives_from_loose_file() {
        let root = PathBuf::from("/lib");
        let d = derive_from_path(Path::new("/lib/未命名 1.flac"), &root);
        assert_eq!(d.artist, "");
        assert_eq!(d.album, "");
        assert_eq!(d.title, "未命名 1");
    }

    #[test]
    fn detects_audio_extensions() {
        assert!(is_audio_file(Path::new("/x/a.flac")));
        assert!(is_audio_file(Path::new("/x/a.MP3")));
        assert!(!is_audio_file(Path::new("/x/a.wav")));
        assert!(!is_audio_file(Path::new("/x/a.txt")));
    }

    #[test]
    fn splits_track_prefix_conservatively() {
        assert_eq!(split_track_prefix("01 - 稻香"), ("01".into(), "稻香".into()));
        assert_eq!(split_track_prefix("3. 夜曲"), ("3".into(), "夜曲".into()));
        // 没有分隔符时不拆，避免把 "2008" 这种标题拆坏
        assert_eq!(split_track_prefix("2008"), (String::new(), String::new()));
        // 纯英文标题不拆
        assert_eq!(split_track_prefix("Hello"), (String::new(), String::new()));
    }

    #[test]
    fn collects_only_audio_files() {
        let root = std::env::temp_dir().join("metatidy-scan-test");
        let _ = std::fs::remove_dir_all(&root);
        crate::fixtures::make_flac(&root.join("中文/周杰伦/魔杰座/01 - 稻香.flac")).unwrap();
        crate::fixtures::make_mp3(&root.join("待整理/x.mp3"), 4).unwrap();
        std::fs::write(root.join("note.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("@eaDir")).unwrap();
        crate::fixtures::make_flac(&root.join("@eaDir/skip.flac")).unwrap();

        let files = collect_audio_files(&root);
        assert_eq!(files.len(), 2, "应为 2 个音频文件，实际 {files:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
