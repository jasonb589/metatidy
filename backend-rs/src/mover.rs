//! 整理移动：**先出计划，确认后才动文件**。
//!
//! 安全底线（与 Python 版逐条对齐，都是从旧项目的血泪教训里来的）：
//! - 目标路径必须落在库根目录内，越界项标 `invalid` 且绝不执行
//! - **失败绝不删源**：跨盘先复制、校验字节数一致，才删源文件
//! - 同一计划内两首歌算出同一目标时自动错开，不会互相覆盖
//! - 可重试的 IO 错误退避重试 3 次

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::Track;
use crate::templates::target_path;

/// 一条计划项的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveAction {
    Move,
    InPlace,
    ConflictRename,
    ConflictSkip,
    ConflictOverwrite,
    Invalid,
}

impl MoveAction {
    pub fn as_str(self) -> &'static str {
        match self {
            MoveAction::Move => "move",
            MoveAction::InPlace => "in_place",
            MoveAction::ConflictRename => "conflict_rename",
            MoveAction::ConflictSkip => "conflict_skip",
            MoveAction::ConflictOverwrite => "conflict_overwrite",
            MoveAction::Invalid => "invalid",
        }
    }

    /// 是否真的需要动文件。
    fn is_executable(self) -> bool {
        matches!(
            self,
            MoveAction::Move | MoveAction::ConflictRename | MoveAction::ConflictOverwrite
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveItem {
    pub track_id: i64,
    pub source: String,
    pub target: String,
    pub action: String,
    pub reason: String,
    pub filename: String,
    pub artist: String,
    pub title: String,
    pub warning: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MovePlan {
    pub library_root: String,
    pub dir_template: String,
    pub filename_template: String,
    pub conflict_policy: String,
    pub total: usize,
    pub planned: usize,
    pub counts: HashMap<String, usize>,
    pub items: Vec<MoveItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveFailure {
    pub source: String,
    pub target: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MoveSummary {
    pub moved: usize,
    pub skipped: usize,
    pub failed: usize,
    pub renamed: usize,
    pub failures: Vec<MoveFailure>,
    /// 成功移动的 (track_id, 新路径)，供调用方同步索引
    #[serde(skip)]
    pub moved_paths: Vec<(i64, String)>,
}

/// 生成计划需要的配置。
pub struct PlanOptions<'a> {
    pub library_root: &'a Path,
    pub dir_template: &'a str,
    pub filename_template: &'a str,
    pub conflict_policy: &'a str,
    pub unknown_artist: &'a str,
    pub unknown_album: &'a str,
    pub unknown_other: &'a str,
}

fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    }
}

/// 目标是否在库根之内（纯词法判断，不做 canonicalize —— 慢盘上那是昂贵的 IO）。
fn is_inside(root: &Path, path: &Path) -> bool {
    absolute(path).starts_with(absolute(root))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// 目标被占用时追加 " (2)"、" (3)"…
fn unique_target(target: &Path, taken: &HashSet<String>) -> PathBuf {
    let busy = |p: &Path| p.exists() || taken.contains(&p.to_string_lossy().to_lowercase());
    if !busy(target) {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 2..1000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if !busy(&candidate) {
            return candidate;
        }
    }
    target.to_path_buf()
}

/// 生成移动计划（**只读文件系统，不移动任何东西**）。
pub fn plan_moves(tracks: &[Track], opts: &PlanOptions<'_>) -> MovePlan {
    let root = opts.library_root;
    let mut items: Vec<MoveItem> = Vec::with_capacity(tracks.len());
    let mut taken: HashSet<String> = HashSet::new();

    for track in tracks {
        let mut item = MoveItem {
            track_id: track.id,
            source: track.path.clone(),
            target: String::new(),
            action: MoveAction::Invalid.as_str().to_string(),
            reason: String::new(),
            filename: track.filename.clone(),
            artist: track.artist.clone(),
            title: track.title.clone(),
            warning: String::new(),
        };

        if track.path.trim().is_empty() {
            item.reason = "索引里没有路径".to_string();
            items.push(item);
            continue;
        }

        let source = PathBuf::from(&track.path);
        let target = target_path(
            track,
            root,
            opts.dir_template,
            opts.filename_template,
            opts.unknown_artist,
            opts.unknown_album,
            opts.unknown_other,
        );
        let target_key = target.to_string_lossy().to_lowercase();
        item.target = target.to_string_lossy().to_string();

        if !is_inside(root, &target) {
            item.reason = format!("目标不在库根目录内（{}）", root.display());
            items.push(item);
            continue;
        }
        if !source.exists() {
            item.reason = "源文件不存在（可能已被移动或删除）".to_string();
            items.push(item);
            continue;
        }
        if same_path(&source, &target) {
            item.action = MoveAction::InPlace.as_str().to_string();
            item.reason = "已在目标位置".to_string();
            taken.insert(target_key);
            items.push(item);
            continue;
        }
        if taken.contains(&target_key) {
            let staggered = unique_target(&target, &taken);
            item.target = staggered.to_string_lossy().to_string();
            item.action = MoveAction::ConflictRename.as_str().to_string();
            item.reason = "与计划中其它曲目目标重复，已自动错开".to_string();
            taken.insert(item.target.to_lowercase());
            items.push(item);
            continue;
        }
        if target.exists() {
            match opts.conflict_policy {
                "skip" => {
                    item.action = MoveAction::ConflictSkip.as_str().to_string();
                    item.reason = "目标已存在，按策略跳过".to_string();
                }
                "overwrite" => {
                    item.action = MoveAction::ConflictOverwrite.as_str().to_string();
                    item.reason = "目标已存在，按策略覆盖".to_string();
                }
                _ => {
                    let renamed = unique_target(&target, &taken);
                    item.target = renamed.to_string_lossy().to_string();
                    item.action = MoveAction::ConflictRename.as_str().to_string();
                    item.reason = "目标已存在，已改名避免覆盖".to_string();
                }
            }
            taken.insert(item.target.to_lowercase());
            items.push(item);
            continue;
        }

        item.action = MoveAction::Move.as_str().to_string();
        taken.insert(target_key);
        items.push(item);
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for item in &items {
        *counts.entry(item.action.clone()).or_insert(0) += 1;
    }

    MovePlan {
        library_root: root.to_string_lossy().to_string(),
        dir_template: opts.dir_template.to_string(),
        filename_template: opts.filename_template.to_string(),
        conflict_policy: opts.conflict_policy.to_string(),
        total: tracks.len(),
        planned: items.len(),
        counts,
        items,
    }
}

/// 执行计划。`dry_run = true` 只统计，不碰文件系统。
pub fn execute_plan(
    plan: &MovePlan,
    dry_run: bool,
    mut progress: impl FnMut(usize, usize, String),
) -> MoveSummary {
    let root = PathBuf::from(&plan.library_root);
    let mut summary = MoveSummary::default();
    let total = plan.items.len();

    for (index, item) in plan.items.iter().enumerate() {
        progress(index + 1, total, item.filename.clone());

        let action = match item.action.as_str() {
            "move" => MoveAction::Move,
            "in_place" => MoveAction::InPlace,
            "conflict_rename" => MoveAction::ConflictRename,
            "conflict_skip" => MoveAction::ConflictSkip,
            "conflict_overwrite" => MoveAction::ConflictOverwrite,
            _ => MoveAction::Invalid,
        };

        if !action.is_executable() {
            summary.skipped += 1;
            continue;
        }
        if dry_run {
            summary.moved += 1;
            continue;
        }

        let source = PathBuf::from(&item.source);
        let mut target = PathBuf::from(&item.target);

        // 安全底线：目标越界一律不执行
        if !is_inside(&root, &target) {
            summary.failed += 1;
            summary.failures.push(MoveFailure {
                source: item.source.clone(),
                target: item.target.clone(),
                error: "目标越出库根目录".to_string(),
            });
            continue;
        }
        // 计划生成到执行之间目标可能被别人占了
        if target.exists() && action != MoveAction::ConflictOverwrite {
            target = unique_target(&target, &HashSet::new());
        }

        match move_with_retry(&source, &target) {
            Ok(()) => {
                summary.moved += 1;
                let final_path = target.to_string_lossy().to_string();
                if action == MoveAction::ConflictRename || final_path != item.target {
                    summary.renamed += 1;
                }
                if item.track_id > 0 {
                    summary.moved_paths.push((item.track_id, final_path));
                }
            }
            Err(err) => {
                summary.failed += 1;
                summary.failures.push(MoveFailure {
                    source: item.source.clone(),
                    target: target.to_string_lossy().to_string(),
                    error: err.to_string(),
                });
            }
        }
    }

    summary
}

/// 带退避重试的移动（Windows 上文件被占用是常态）。
fn move_with_retry(source: &Path, target: &Path) -> anyhow::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("创建目标目录失败 {}：{e}", parent.display()))?;
    }
    let source_size = fs::metadata(source)
        .map_err(|e| anyhow::anyhow!("读取源文件失败 {}：{e}", source.display()))?
        .len();

    let mut last_error: Option<anyhow::Error> = None;
    for attempt in 0..3u32 {
        match try_move(source, target, source_size) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(400 * (1 << attempt)));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("移动失败（原因未知）")))
}

/// 同盘用 rename（零拷贝）；跨盘退化成 复制 → 校验 → 删源。
///
/// 任何一步失败都**不会删除源文件**。
fn try_move(source: &Path, target: &Path, source_size: u64) -> anyhow::Result<()> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(source, target).map_err(|copy_error| {
                anyhow::anyhow!("搬移失败：rename 报 {rename_error}，复制也失败：{copy_error}")
            })?;
            let copied = fs::metadata(target)?.len();
            if copied != source_size {
                let _ = fs::remove_file(target);
                anyhow::bail!("复制校验失败：源 {source_size} 字节，目标 {copied} 字节（源文件已保留）");
            }
            fs::remove_file(source)?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("metatidy-mover-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn track_with(id: i64, path: &Path, title: &str, track_no: &str) -> Track {
        Track {
            id,
            path: path.to_string_lossy().to_string(),
            filename: path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            ext: ".flac".to_string(),
            title: title.to_string(),
            artist: "周杰伦".to_string(),
            albumartist: "周杰伦".to_string(),
            album: "魔杰座".to_string(),
            track: track_no.to_string(),
            language: "中文".to_string(),
            ..Default::default()
        }
    }

    fn opts<'a>(root: &'a Path) -> PlanOptions<'a> {
        PlanOptions {
            library_root: root,
            dir_template: "{language}/{artist}/{album}",
            filename_template: "{track:02} - {title}",
            conflict_policy: "rename",
            unknown_artist: "未知艺术家",
            unknown_album: "未知专辑",
            unknown_other: "未知",
        }
    }

    #[test]
    fn plan_and_execute_moves_files() {
        let root = temp_root("plan");
        let source = root.join("待整理/未命名 1.flac");
        fixtures::make_flac(&source).unwrap();
        let track = track_with(1, &source, "稻香", "3");
        let plan = plan_moves(std::slice::from_ref(&track), &opts(&root));

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].action, "move");
        assert!(plan.items[0].target.ends_with("中文/周杰伦/魔杰座/03 - 稻香.flac"));
        assert!(source.exists(), "预览阶段不能移动文件");

        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.moved, 1);
        assert_eq!(summary.failed, 0);
        assert!(!source.exists(), "源文件应已移走");
        assert!(PathBuf::from(&plan.items[0].target).exists());
        assert_eq!(summary.moved_paths.len(), 1);
        assert_eq!(summary.moved_paths[0].0, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dry_run_touches_nothing() {
        let root = temp_root("dryrun");
        let source = root.join("待整理/a.flac");
        fixtures::make_flac(&source).unwrap();
        let track = track_with(1, &source, "稻香", "1");
        let plan = plan_moves(&[track], &opts(&root));
        let summary = execute_plan(&plan, true, |_, _, _| {});
        assert_eq!(summary.moved, 1);
        assert!(source.exists(), "dry_run 不能移动文件");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn in_place_detected() {
        let root = temp_root("inplace");
        let target = root.join("中文/周杰伦/魔杰座/01 - 稻香.flac");
        fixtures::make_flac(&target).unwrap();
        let track = track_with(1, &target, "稻香", "1");
        let plan = plan_moves(&[track], &opts(&root));
        assert_eq!(plan.items[0].action, "in_place");
        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.moved, 0);
        assert_eq!(summary.skipped, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn conflict_renames_instead_of_overwriting() {
        let root = temp_root("conflict");
        let existing = root.join("中文/周杰伦/魔杰座/01 - 稻香.flac");
        fixtures::make_flac(&existing).unwrap();
        let source = root.join("待整理/a.flac");
        fixtures::make_flac(&source).unwrap();

        let track = track_with(1, &source, "稻香", "1");
        let plan = plan_moves(&[track], &opts(&root));
        assert_eq!(plan.items[0].action, "conflict_rename");
        assert!(plan.items[0].target.ends_with("01 - 稻香 (2).flac"));

        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.moved, 1);
        assert!(existing.exists(), "原有文件不能被覆盖");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn conflict_skip_policy() {
        let root = temp_root("skip");
        fixtures::make_flac(&root.join("中文/周杰伦/魔杰座/01 - 稻香.flac")).unwrap();
        let source = root.join("待整理/a.flac");
        fixtures::make_flac(&source).unwrap();
        let track = track_with(1, &source, "稻香", "1");
        let mut o = opts(&root);
        o.conflict_policy = "skip";
        let plan = plan_moves(&[track], &o);
        assert_eq!(plan.items[0].action, "conflict_skip");
        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.moved, 0);
        assert!(source.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_targets_are_staggered() {
        let root = temp_root("dup");
        let a = root.join("待整理/a.flac");
        let b = root.join("待整理/b.flac");
        fixtures::make_flac(&a).unwrap();
        fixtures::make_flac(&b).unwrap();
        let tracks = vec![
            track_with(1, &a, "同一首", "1"),
            track_with(2, &b, "同一首", "1"),
        ];
        let plan = plan_moves(&tracks, &opts(&root));
        assert_ne!(plan.items[0].target, plan.items[1].target);
        assert_eq!(plan.items[1].action, "conflict_rename");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_is_invalid() {
        let root = temp_root("missing");
        let track = track_with(1, &root.join("nope.flac"), "稻香", "1");
        let plan = plan_moves(&[track], &opts(&root));
        assert_eq!(plan.items[0].action, "invalid");
        assert!(plan.items[0].reason.contains("源文件不存在"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn foreign_root_is_rejected_at_execution() {
        let root = temp_root("guard");
        let elsewhere = std::env::temp_dir().join("metatidy-mover-outside");
        let _ = fs::create_dir_all(&elsewhere);
        let source = root.join("a.flac");
        fixtures::make_flac(&source).unwrap();

        // 手工构造一个越界计划，验证执行阶段的安全底线
        let plan = MovePlan {
            library_root: root.to_string_lossy().to_string(),
            dir_template: "{artist}".to_string(),
            filename_template: "{title}".to_string(),
            conflict_policy: "rename".to_string(),
            total: 1,
            planned: 1,
            counts: HashMap::new(),
            items: vec![MoveItem {
                track_id: 1,
                source: source.to_string_lossy().to_string(),
                target: elsewhere.join("escaped.flac").to_string_lossy().to_string(),
                action: "move".to_string(),
                reason: String::new(),
                filename: "a.flac".to_string(),
                artist: String::new(),
                title: String::new(),
                warning: String::new(),
            }],
        };
        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.failed, 1);
        assert!(summary.failures[0].error.contains("越出库根目录"));
        assert!(source.exists(), "越界时绝不能动源文件");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_keeps_source_file() {
        let root = temp_root("keep");
        let source = root.join("a.flac");
        fixtures::make_flac(&source).unwrap();
        // 目标父路径是一个已经存在的文件 → create_dir_all 必然失败
        let blocker = root.join("blocker");
        fs::write(&blocker, b"x").unwrap();

        let plan = MovePlan {
            library_root: root.to_string_lossy().to_string(),
            dir_template: String::new(),
            filename_template: String::new(),
            conflict_policy: "rename".to_string(),
            total: 1,
            planned: 1,
            counts: HashMap::new(),
            items: vec![MoveItem {
                track_id: 1,
                source: source.to_string_lossy().to_string(),
                target: blocker.join("sub/a.flac").to_string_lossy().to_string(),
                action: "move".to_string(),
                reason: String::new(),
                filename: "a.flac".to_string(),
                artist: String::new(),
                title: String::new(),
                warning: String::new(),
            }],
        };
        let summary = execute_plan(&plan, false, |_, _, _| {});
        assert_eq!(summary.failed, 1);
        assert!(source.exists(), "失败必须保留源文件");
        let _ = fs::remove_dir_all(&root);
    }
}
