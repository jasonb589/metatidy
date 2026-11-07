//! Incremental library updates driven by filesystem notifications.
//!
//! Notifications are hints: coalesce them, wait for a quiet period and stable
//! file metadata, then reuse the ordinary scan job. Never prune from a watcher
//! event: an unmounted network share must not empty the user's library index.

use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::jobs::JobStore;
use crate::scanner::{self, ScanOptions};
use crate::AppState;

const EVENT_CAPACITY: usize = 1024;
const MAX_SCOPES: usize = 128;
const MAX_SAMPLES: usize = 512;
const STABILITY_INTERVAL: Duration = Duration::from_secs(2);
const ROOT_CHECK_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Default, Serialize)]
struct AutoScanStatus {
    enabled: bool,
    watching: bool,
    fast: bool,
    debounce_secs: u64,
    pending_scopes: usize,
    state: String,
    error: String,
    last_job_id: Option<String>,
    last_scan_at: Option<u64>,
    overflow_count: u64,
}

static STATUS: Lazy<Mutex<AutoScanStatus>> = Lazy::new(|| Mutex::new(AutoScanStatus::default()));

fn update_status(update: impl FnOnce(&mut AutoScanStatus)) {
    if let Ok(mut status) = STATUS.lock() {
        update(&mut status);
    }
}

/// A compact status object for `/api/status`; no filesystem work on requests.
pub fn status() -> Value {
    STATUS
        .lock()
        .ok()
        .and_then(|status| serde_json::to_value(&*status).ok())
        .unwrap_or_else(|| json!({ "enabled": false, "state": "unavailable" }))
}

/// Start once after service initialization. Dropping the handle does not stop
/// the actor; Tokio shuts it down with the server process.
pub fn start(state: AppState) -> tokio::task::JoinHandle<()> {
    update_status(|status| {
        *status = AutoScanStatus {
            enabled: state.config.auto_scan,
            fast: state.config.auto_scan_fast,
            debounce_secs: state.config.auto_scan_debounce_secs,
            state: if state.config.auto_scan {
                "starting"
            } else {
                "disabled"
            }
            .into(),
            ..Default::default()
        };
    });
    tokio::spawn(async move {
        if !state.config.auto_scan {
            return;
        }
        run(state).await;
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: Option<SystemTime>,
    tree_fingerprint: Option<(u64, u64)>,
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    let tree_fingerprint = if metadata.is_dir() {
        // A whole album may be moved into the library with no individual
        // Create events. Compare its audio metadata twice as well. Hash each
        // entry independently and combine commutatively: directory listing
        // order is not stable on every network filesystem, memory stays O(1).
        let mut count = 0u64;
        let mut fingerprint = 0u64;
        for entry in walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_type().is_dir() || {
                    let name = entry.file_name().to_string_lossy();
                    !name.starts_with('.') && !scanner::SKIP_DIRS.contains(&name.as_ref())
                }
            })
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() || !scanner::is_audio_file(entry.path()) {
                continue;
            }
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            entry.path().hash(&mut hash);
            if let Ok(meta) = entry.metadata() {
                meta.len().hash(&mut hash);
                meta.modified().ok().hash(&mut hash);
            }
            count += 1;
            fingerprint = fingerprint.wrapping_add(hash.finish());
        }
        Some((count, fingerprint))
    } else {
        None
    };
    Some(FileStamp {
        size: metadata.len(),
        modified: metadata.modified().ok(),
        tree_fingerprint,
    })
}

#[derive(Debug)]
struct Pending {
    scopes: BTreeSet<PathBuf>,
    samples: HashMap<PathBuf, Option<FileStamp>>,
    reconcile_root: bool,
    changed_at: Instant,
    sampled_at: Option<Instant>,
}

impl Pending {
    fn new() -> Self {
        Self {
            scopes: BTreeSet::new(),
            samples: HashMap::new(),
            reconcile_root: false,
            changed_at: Instant::now(),
            sampled_at: None,
        }
    }

    fn add(&mut self, scope: PathBuf, file: Option<PathBuf>) {
        // `Path::starts_with` compares components, so `album` never swallows
        // a distinct sibling such as `album-remastered`.
        if !self.scopes.iter().any(|parent| scope.starts_with(parent)) {
            self.scopes.retain(|child| !child.starts_with(&scope));
            self.scopes.insert(scope);
        }
        if let Some(file) = file {
            self.samples.insert(file, None);
        }
        if self.scopes.len() > MAX_SCOPES || self.samples.len() > MAX_SAMPLES {
            self.reconcile();
        }
        self.changed_at = Instant::now();
        self.sampled_at = None;
    }

    fn reconcile(&mut self) {
        self.scopes.clear();
        self.scopes.insert(PathBuf::new());
        self.samples.clear();
        self.reconcile_root = true;
        self.changed_at = Instant::now();
        self.sampled_at = None;
    }

    fn quiet(&self, quiet: Duration) -> bool {
        !self.scopes.is_empty() && self.changed_at.elapsed() >= quiet
    }
}

/// Paths under hidden / system directories and symlink subtrees never become
/// direct scan roots (WalkDir otherwise follows a symlink passed as its root).
fn allowed_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let name = part.to_string_lossy();
                if name.starts_with('.') || scanner::SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
                current.push(part);
                if std::fs::symlink_metadata(&current)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return false;
                }
            }
            Component::CurDir => {}
            _ => return false,
        }
    }
    true
}

/// Called on a blocking worker: checking a mounted path can be slow.
fn affected_scopes(root: &Path, event: &Event) -> Vec<(PathBuf, Option<PathBuf>)> {
    let directories = matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Any
            | EventKind::Other
    );
    if matches!(
        event.kind,
        EventKind::Access(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(RenameMode::From))
    ) {
        return Vec::new();
    }
    let paths: &[PathBuf] = if matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
    ) {
        // A rename contains [old, new]. Only the destination is a scan hint.
        event.paths.last().map(std::slice::from_ref).unwrap_or(&[])
    } else {
        &event.paths
    };
    paths
        .iter()
        .filter_map(|path| {
            if !allowed_path(root, path) {
                return None;
            }
            let relative = path.strip_prefix(root).ok()?;
            if directories && path.is_dir() {
                return Some((relative.to_path_buf(), Some(path.clone())));
            }
            if scanner::is_audio_file(path) {
                return Some((
                    relative.parent().unwrap_or(Path::new("")).to_path_buf(),
                    Some(path.clone()),
                ));
            }
            None
        })
        .collect()
}

/// An unmounted Unix mount point remains a directory, and inotify can lose its
/// watch without producing a useful error. Compare directory identity so the
/// 30-second health check reconnects after a mount or root replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RootIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    created: u64,
    #[cfg(not(any(unix, windows)))]
    created: Option<SystemTime>,
}

fn root_identity(path: &Path) -> Option<RootIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(RootIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Some(RootIdentity {
            created: metadata.creation_time(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Some(RootIdentity {
            created: metadata.created().ok(),
        })
    }
}

fn attach_watcher(
    root: &Path,
    tx: mpsc::Sender<notify::Result<Event>>,
    overflow: Arc<AtomicBool>,
    fault: Arc<AtomicBool>,
    overflow_count: Arc<AtomicU64>,
) -> anyhow::Result<(RecommendedWatcher, RootIdentity)> {
    let identity = root_identity(root)
        .ok_or_else(|| anyhow::anyhow!("音乐目录不存在或尚未挂载：{}", root.display()))?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if matches!(&event, Ok(event) if matches!(event.kind, EventKind::Access(_))) {
            return;
        }
        if event.is_err() {
            fault.store(true, Ordering::Release);
        }
        if matches!(&event, Ok(event) if event.need_rescan()) {
            overflow.store(true, Ordering::Release);
        }
        if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(event) {
            overflow.store(true, Ordering::Release);
            overflow_count.fetch_add(1, Ordering::Relaxed);
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, identity))
}

async fn run(state: AppState) {
    let root = if state.config.music_dir.is_absolute() {
        state.config.music_dir.clone()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(&state.config.music_dir),
            Err(error) => {
                update_status(|s| {
                    s.state = "error".into();
                    s.error = error.to_string();
                });
                return;
            }
        }
    };
    let quiet = Duration::from_secs(state.config.auto_scan_debounce_secs.max(1));
    let store = JobStore::new(state.db.clone(), state.redis.clone());
    let (tx, mut rx) = mpsc::channel::<notify::Result<Event>>(EVENT_CAPACITY);
    let overflow = Arc::new(AtomicBool::new(false));
    let fault = Arc::new(AtomicBool::new(false));
    let overflow_count = Arc::new(AtomicU64::new(0));
    let mut watcher = None;
    let mut watched_identity = None;
    let mut pending = Pending::new();
    let mut active: Option<(String, PathBuf)> = None;
    let mut retry_at = Instant::now();
    let mut retry_delay = Duration::from_secs(5);
    let mut scan_retry_at = Instant::now();
    let mut last_root_check = Instant::now();
    let mut last_job_check = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            message = rx.recv() => {
                match message {
                    Some(Ok(event)) => {
                        if matches!(event.kind, EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From))) && event.paths.iter().any(|path| path == &root) {
                            fault.store(true, Ordering::Release);
                        }
                        let scope_root = root.clone();
                        match tokio::task::spawn_blocking(move || affected_scopes(&scope_root, &event)).await {
                            Ok(scopes) => for (scope, file) in scopes { pending.add(scope, file); },
                            Err(error) => {
                                tracing::warn!("自动扫描解析事件失败，将补做增量扫描：{error}");
                                pending.reconcile();
                            }
                        }
                    }
                    Some(Err(error)) => {
                        tracing::warn!("音乐目录监听错误，将重新连接：{error}");
                        update_status(|s| { s.error = error.to_string(); });
                        fault.store(true, Ordering::Release);
                    }
                    None => return,
                }
            }
            _ = tick.tick() => {}
        }

        if overflow.swap(false, Ordering::AcqRel) {
            pending.reconcile();
            tracing::warn!("音乐目录通知溢出，将在静默后补做整库增量扫描（不清理索引）");
        }
        if fault.swap(false, Ordering::AcqRel) {
            watcher = None;
            watched_identity = None;
            retry_at = Instant::now() + retry_delay;
            update_status(|s| {
                s.watching = false;
                s.state = "retrying".into();
            });
        }

        if watcher.is_none() && Instant::now() >= retry_at {
            let watch_root = root.clone();
            let watch_tx = tx.clone();
            let watch_overflow = Arc::clone(&overflow);
            let watch_fault = Arc::clone(&fault);
            let watch_overflow_count = Arc::clone(&overflow_count);
            let attached = tokio::task::spawn_blocking(move || {
                attach_watcher(
                    &watch_root,
                    watch_tx,
                    watch_overflow,
                    watch_fault,
                    watch_overflow_count,
                )
            })
            .await;
            match attached {
                Ok(Ok((attached, identity))) => {
                    watcher = Some(attached);
                    watched_identity = Some(identity);
                    retry_delay = Duration::from_secs(5);
                    last_root_check = Instant::now();
                    // Catch files added while this process or the mount was
                    // offline. It is incremental and never removes records.
                    pending.reconcile();
                    update_status(|s| {
                        s.watching = true;
                        s.state = "watching".into();
                        s.error.clear();
                    });
                    tracing::info!(
                        "已启用音乐库自动增量扫描：{}，静默 {} 秒后处理，不自动删除索引",
                        root.display(),
                        quiet.as_secs()
                    );
                }
                result => {
                    let error = match result {
                        Ok(Err(error)) => error.to_string(),
                        Err(error) => error.to_string(),
                        Ok(Ok(_)) => unreachable!(),
                    };
                    tracing::warn!("暂时无法监听音乐目录，将重试：{error}");
                    update_status(|s| {
                        s.watching = false;
                        s.state = "retrying".into();
                        s.error = error;
                    });
                    retry_at = Instant::now() + retry_delay;
                    retry_delay = (retry_delay * 2).min(Duration::from_secs(120));
                }
            }
        }

        if watcher.is_some() && last_root_check.elapsed() >= ROOT_CHECK_INTERVAL {
            last_root_check = Instant::now();
            let check_root = root.clone();
            let observed_identity = tokio::task::spawn_blocking(move || root_identity(&check_root))
                .await
                .unwrap_or(None);
            if observed_identity.is_none() || observed_identity != watched_identity {
                watcher = None;
                watched_identity = None;
                retry_at = Instant::now() + Duration::from_secs(5);
                update_status(|s| {
                    s.watching = false;
                    s.state = "retrying".into();
                    s.error = if observed_identity.is_some() {
                        "音乐目录挂载已变化，正在重新连接监听"
                    } else {
                        "音乐目录暂不可用，等待重新挂载"
                    }
                    .into();
                });
            }
        }

        if active.is_some() && last_job_check.elapsed() >= Duration::from_secs(2) {
            last_job_check = Instant::now();
            let (id, scope) = active.as_ref().unwrap();
            match store.get(id).await {
                Ok(Some(job)) if job.state == "done" => {
                    active = None;
                    update_status(|s| {
                        s.last_scan_at = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .ok()
                            .map(|time| time.as_secs());
                        s.state = if s.watching { "watching" } else { "retrying" }.into();
                        s.error.clear();
                    });
                }
                Ok(Some(job)) if job.state == "error" => {
                    pending.add(scope.clone(), None);
                    scan_retry_at = Instant::now() + Duration::from_secs(60);
                    update_status(|s| {
                        s.state = "retrying".into();
                        s.error = job.error;
                    });
                    active = None;
                }
                Ok(None) => {
                    pending.add(scope.clone(), None);
                    active = None;
                    scan_retry_at = Instant::now() + Duration::from_secs(30);
                }
                Err(error) => {
                    update_status(|s| {
                        s.error = format!("读取自动扫描任务状态失败：{error}");
                    });
                }
                _ => {}
            }
        }

        update_status(|s| {
            s.pending_scopes = pending.scopes.len();
            s.overflow_count = overflow_count.load(Ordering::Relaxed);
        });
        if pending.reconcile_root {
            // Startup and notification overflow can have no individual file
            // hints. Also wait for a stable metadata snapshot before that
            // catch-up scan, without reading any audio bytes.
            pending.samples.clear();
            pending.samples.insert(root.clone(), None);
            pending.reconcile_root = false;
        }
        if watcher.is_none()
            || active.is_some()
            || Instant::now() < scan_retry_at
            || !pending.quiet(quiet)
            || !rx.is_empty()
        {
            continue;
        }

        if !pending.samples.is_empty() {
            if pending
                .sampled_at
                .is_some_and(|time| time.elapsed() < STABILITY_INTERVAL)
            {
                continue;
            }
            let paths: Vec<PathBuf> = pending.samples.keys().cloned().collect();
            let sample_root = root.clone();
            let sampled = tokio::task::spawn_blocking(move || {
                paths
                    .into_iter()
                    .map(|path| {
                        let value = allowed_path(&sample_root, &path)
                            .then(|| stamp(&path))
                            .flatten();
                        (path, value)
                    })
                    .collect::<HashMap<_, _>>()
            })
            .await;
            let Ok(sampled) = sampled else {
                pending.changed_at = Instant::now();
                continue;
            };
            let stable = pending.sampled_at.is_some() && sampled == pending.samples;
            pending.samples = sampled;
            pending.sampled_at = Some(Instant::now());
            if !stable || !rx.is_empty() || overflow.load(Ordering::Acquire) {
                continue;
            }
            pending.samples.clear();
        }

        let Some(scope) = pending.scopes.pop_first() else {
            continue;
        };
        let check_root = root.clone();
        let check_scope = root.join(&scope);
        // A create/rename hint may no longer exist by the time copying settles.
        // Validate again here to avoid following a newly introduced symlink.
        let usable = tokio::task::spawn_blocking(move || {
            allowed_path(&check_root, &check_scope) && check_scope.is_dir()
        })
        .await
        .unwrap_or(false);
        if !usable {
            continue;
        }
        let options = ScanOptions {
            root: root.join(&scope),
            full: false,
            prune: false,
            fast: state.config.auto_scan_fast,
            workers: state.config.scan_workers,
            ..Default::default()
        };
        match crate::api::start_scan_job(state.clone(), options, true).await {
            Ok(id) => {
                update_status(|s| {
                    s.last_job_id = Some(id.clone());
                    s.state = "scanning".into();
                    s.error.clear();
                });
                tracing::info!("自动增量扫描已排队：job={} scope={}", id, scope.display());
                active = Some((id, scope));
                last_job_check = Instant::now();
            }
            Err(error) => {
                // ApiError intentionally does not implement Display.
                tracing::warn!("无法建立自动扫描任务，将稍后重试：{error:?}");
                pending.add(scope, None);
                scan_retry_at = Instant::now() + Duration::from_secs(60);
                update_status(|s| {
                    s.state = "retrying".into();
                    s.error = "建立扫描任务失败，将自动重试".into();
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, RemoveKind};

    #[test]
    fn coalesces_parent_scopes_without_swallowing_sibling_prefixes() {
        let mut pending = Pending::new();
        pending.add(PathBuf::from("artist/album/disc1"), None);
        pending.add(PathBuf::from("artist/album-remastered"), None);
        pending.add(PathBuf::from("artist/album"), None);
        assert_eq!(
            pending.scopes,
            BTreeSet::from([
                PathBuf::from("artist/album"),
                PathBuf::from("artist/album-remastered")
            ])
        );
        pending.reconcile();
        pending.add(PathBuf::from("new/album"), None);
        assert_eq!(pending.scopes, BTreeSet::from([PathBuf::new()]));
    }

    #[test]
    fn bounded_pending_work_falls_back_to_one_safe_incremental_scan() {
        let mut pending = Pending::new();
        for index in 0..=MAX_SCOPES {
            pending.add(PathBuf::from(format!("artist-{index}")), None);
        }
        assert_eq!(pending.scopes, BTreeSet::from([PathBuf::new()]));
        assert!(pending.reconcile_root);
    }

    #[test]
    fn new_events_reset_debounce_and_stability_observation() {
        let mut pending = Pending::new();
        pending.add(PathBuf::from("album"), None);
        pending.changed_at = Instant::now() - Duration::from_secs(20);
        pending.sampled_at = Some(Instant::now() - STABILITY_INTERVAL);
        assert!(pending.quiet(Duration::from_secs(10)));
        pending.add(
            PathBuf::from("album"),
            Some(PathBuf::from("album/song.flac")),
        );
        assert!(!pending.quiet(Duration::from_secs(10)));
        assert!(pending.sampled_at.is_none());
    }

    #[test]
    fn root_identity_detects_directory_replacement_without_a_missing_path() {
        let scratch =
            std::env::temp_dir().join(format!("metatidy-root-identity-{}", uuid::Uuid::new_v4()));
        let root = scratch.join("music");
        let previous = scratch.join("previous");
        std::fs::create_dir_all(&root).unwrap();
        let before = root_identity(&root).unwrap();
        assert_eq!(Some(before), root_identity(&root));
        std::fs::rename(&root, &previous).unwrap();
        // On Windows, creation time identifies the directory. Separate the
        // two creations even on filesystems with coarse timestamp updates.
        #[cfg(windows)]
        std::thread::sleep(Duration::from_millis(25));
        std::fs::create_dir(&root).unwrap();
        assert!(root.is_dir());
        assert_ne!(Some(before), root_identity(&root));
        std::fs::remove_dir(&root).unwrap();
        assert!(root_identity(&root).is_none());
        std::fs::remove_dir(&previous).unwrap();
        std::fs::remove_dir(&scratch).unwrap();
    }

    #[test]
    fn filters_events_and_uses_only_rename_destination() {
        let root =
            std::env::temp_dir().join(format!("metatidy-event-filter-{}", uuid::Uuid::new_v4()));
        let old = root.join("old/01.flac");
        let new = root.join("new/01.flac");
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old.clone())
            .add_path(new.clone());
        assert_eq!(
            affected_scopes(&root, &rename),
            vec![(PathBuf::from("new"), Some(new.clone()))]
        );
        let created = Event::new(EventKind::Create(CreateKind::File)).add_path(new.clone());
        assert_eq!(affected_scopes(&root, &created).len(), 1);
        for kind in [
            EventKind::Access(AccessKind::Any),
            EventKind::Remove(RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            assert!(affected_scopes(&root, &Event::new(kind).add_path(new.clone())).is_empty());
        }
        for path in [
            root.join("cover.jpg"),
            root.join(".incoming/song.flac"),
            root.join("@eaDir/song.flac"),
            root.join("../outside.flac"),
        ] {
            assert!(affected_scopes(
                &root,
                &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any))).add_path(path)
            )
            .is_empty());
        }
    }

    #[test]
    fn directory_create_and_rename_scan_the_directory_itself() {
        let root =
            std::env::temp_dir().join(format!("metatidy-event-dir-{}", uuid::Uuid::new_v4()));
        let album = root.join("artist/album");
        std::fs::create_dir_all(&album).unwrap();
        let event = Event::new(EventKind::Create(CreateKind::Folder)).add_path(album.clone());
        assert_eq!(
            affected_scopes(&root, &event),
            vec![(PathBuf::from("artist/album"), Some(album.clone()))]
        );
        let before = stamp(&album).unwrap();
        let song = album.join("track.flac");
        std::fs::write(&song, b"sample audio").unwrap();
        assert_ne!(Some(before), stamp(&album));
        std::fs::remove_file(&song).unwrap();
        std::fs::remove_dir(&album).unwrap();
        std::fs::remove_dir(root.join("artist")).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn file_stability_uses_size_and_modification_time() {
        let path = std::env::temp_dir().join(format!(
            "metatidy-event-stamp-{}.flac",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"first").unwrap();
        let first = stamp(&path).unwrap();
        assert_eq!(Some(first), stamp(&path));
        std::fs::write(&path, b"second write has a different length").unwrap();
        assert_ne!(Some(first), stamp(&path));
        std::fs::remove_file(&path).unwrap();
        assert!(stamp(&path).is_none());
    }
}
