//! 文件变更监听（Linux inotify / Windows ReadDirectoryChangesW / macOS FSEvents）。
//!
//! ## 为什么需要它
//!
//! CloudDrive2 的「文件变更通知」**不是 webhook**：它是让挂载出来的云盘文件系统
//! 支持**操作系统级的变更通知**（官方文档原话：挂载盘里增删改名时，使用
//! `FileSystemWatcher` / `FileNotify` 的程序都会收到通知，Emby / Jellyfin 的
//! 「实时监控」就靠它）。所以监听由我们这一侧做，不需要 CD2 主动 POST 过来。
//!
//! ## 但文档同时写死了两条限制
//!
//! 1. **只有「经 CloudDrive2 发生」的改动才有事件** —— 云服务商不提供文件变更通知，
//!    所以在网盘官方 App / 网页里上传、删除、改名的文件，CD2 无从知晓，也发不出事件；
//! 2. 要让它发现，得在 CD2「我的文件」里**刷新那个网盘目录**（开了「目录缓存持久化」时，
//!    刷新会拿新读到的目录内容与缓存做 diff，差异照常生成事件）。
//!
//! 所以**不能凭文档就把自动增量扫描建在监听上**，先用 [`run_watch_probe`]
//! （`--watch-probe`）实测：① 目录数 vs 宿主机 inotify 上限；② 实时打印收到的每个事件；
//! ③ 可选自检 —— 自己造一个临时文件，用来区分「本机这一侧不通」和「CD2 那一侧不发事件」。
//!
//! ## 后续（自动增量扫描）的设计
//!
//! - 事件路径 → [`event_scan_root`] 收敛成「相对库根的目录」→ 只扫那个子树
//!   （复用 `scanner::resolve_scan_root` 的越界校验），秒级完成、零全库遍历；
//! - 去抖：一次拷歌会连发 create / modify / close_write，静默 N 秒后合并成一个任务；
//! - 防自激：我们自己写标签 / 移动文件也会产生事件，写入类任务运行期间要忽略；
//! - **删除不靠自动扫描的 prune**（挂载抖动时 prune 会把整库索引删掉，风险太高），
//!   而是按 Remove 事件里的**确切路径**定点删那一条索引；漏掉的事件由低频对账扫描兜底。

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{Event, RecursiveMode, Watcher};
use walkdir::WalkDir;

use crate::scanner;

/// 递归监听会建多少个 watch（每个目录一个），口径与扫描一致：
/// 跳过隐藏目录与 `scanner::SKIP_DIRS`，不跟随符号链接。
pub fn count_watch_dirs(root: &Path) -> usize {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(keep_dir)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .count()
}

/// 与 `scanner::keep_entry` 同口径（深度 0 永远保留）。
fn keep_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    if name.starts_with('.') {
        return false;
    }
    !scanner::SKIP_DIRS.contains(&name.as_str())
}

/// 宿主机的 inotify watch 上限；非 Linux 内核没有这个概念，返回 `None`。
#[cfg(target_os = "linux")]
pub fn inotify_limit() -> Option<u64> {
    std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

/// 宿主机的 inotify watch 上限；非 Linux 内核没有这个概念，返回 `None`。
#[cfg(not(target_os = "linux"))]
pub fn inotify_limit() -> Option<u64> {
    None
}

/// 把监听事件的路径收敛成「相对库根的目录」，给「只扫这个子树」用。
///
/// - 目录事件（或该路径现在仍是目录）→ 这个目录本身；
/// - 文件事件 → 它所在的目录（目录刚被删掉时 `is_dir()` 为假，于是退到父目录，
///   范围略大但**更安全**：不会漏掉那次删除的影响范围）；
/// - 就在库根 → 返回空串（`resolve_scan_root` 把空串理解成整个库）；
/// - 不在库内、或路径里带了 `..` → `None`，调用方应退化成整库增量或直接忽略。
// 下一阶段（自动增量扫描）用它把事件收敛成扫描范围；本阶段只被单测覆盖
#[allow(dead_code)]
pub fn event_scan_root(music_dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(music_dir).ok()?;
    let dir = if path.is_dir() {
        rel
    } else {
        rel.parent().unwrap_or(Path::new(""))
    };
    let mut parts: Vec<String> = Vec::new();
    for part in dir.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy().to_string()),
            Component::ParentDir => return None,
            _ => {}
        }
    }
    Some(parts.join("/"))
}

/// 单个事件的最小形状（后续自动扫描的事件源也用它）。
#[derive(Debug, Clone, PartialEq, Eq)]
// 自动增量扫描的事件源形状；本阶段只有探测器在用，先标注为「预留」
#[allow(dead_code)]
pub struct WatchEvent {
    pub kind: String,
    pub paths: Vec<PathBuf>,
}

/// `--watch-probe <目录>` 的实现：只读地监听并打印事件。
///
/// `self_test` 为真时会**在监听目录里创建并删除一个隐藏临时文件**
/// （`.metatidy-watch-probe-*.tmp`，非音频、不参与扫描），用来确认本机这一侧的链路是通的。
pub async fn run_watch_probe(dir: &Path, self_test: bool) -> anyhow::Result<()> {
    if !dir.is_dir() {
        anyhow::bail!("监听目录不存在或不是目录：{}", dir.display());
    }

    println!("=== metatidy 文件变更监听探测器 ===");
    println!("监听目录 : {}", dir.display());
    println!("正在统计目录数（云盘挂载上可能要一会儿，每个目录都是一次网络列目录）…");
    let dirs = count_watch_dirs(dir);
    println!("目录数   : {dirs}（递归监听会为每个目录建一个 watch）");
    match inotify_limit() {
        Some(limit) => {
            println!("inotify  : max_user_watches = {limit}（宿主机内核参数，容器共享）");
            if dirs as u64 > limit {
                let suggest = (dirs as u64 * 2).max(65536);
                println!("⚠ 目录数超过上限：{dirs} > {limit}，建 watch 时会报 ENOSPC（MaxFilesWatch）");
                println!("  在宿主机执行：sysctl -w fs.inotify.max_user_watches={suggest}");
                println!("  NAS 上要写进 /etc/sysctl.conf 或开机任务，否则重启就丢");
            }
        }
        None => println!("inotify  : 非 Linux 内核，用系统自带的目录变更机制（没有这个上限）"),
    }

    let counter = Arc::new(AtomicUsize::new(0));
    let watched = Arc::clone(&counter);
    let started = Instant::now();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let secs = started.elapsed().as_secs();
        match res {
            Ok(event) => {
                watched.fetch_add(1, Ordering::SeqCst);
                let paths = event
                    .paths
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join("  |  ");
                println!("[t={secs:>5}s] {:<24} {paths}", format!("{:?}", event.kind));
            }
            Err(err) => {
                println!("[t={secs:>5}s] !! 监听错误：{err}");
                if matches!(err.kind, notify::ErrorKind::MaxFilesWatch) {
                    println!("        → watch 数超过 inotify 上限，调大 fs.inotify.max_user_watches 后重试");
                }
            }
        }
        let _ = std::io::Write::flush(&mut std::io::stdout());
    })?;
    watcher.watch(dir, RecursiveMode::Recursive)?;
    println!("已开始监听（递归）。收到事件会立刻打印，Ctrl+C 结束。");
    println!("--- 三个实测步骤 ---");
    println!("  ① 用 CD2 的 Web UI / WebDAV 往这个目录放个文件        → 期望：立刻有事件");
    println!("  ② 用网盘官方 App / 网页放一个（Google Drive 那边）    → 期望：没有事件（文档写死的限制）");
    println!("  ③ 再在 CD2「我的文件」里刷新这个目录                  → 看 ② 的文件是否这时候才出事件");
    println!("--------------------");

    if self_test {
        let probe = dir.join(format!(".metatidy-watch-probe-{}.tmp", std::process::id()));
        println!("自检：将在监听目录里创建并删除一个隐藏临时文件 {}", probe.display());
        println!("      （非音频文件，不参与索引；动作会在几秒内完成）");
        let before = counter.load(Ordering::SeqCst);
        std::fs::write(&probe, b"metatidy watch probe\n")?;
        println!("自检：已写入，等待自己产生的事件…");
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && counter.load(Ordering::SeqCst) == before {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let got = counter.load(Ordering::SeqCst) > before;
        if got {
            println!("自检结果：✔ 收到了自己产生的事件 —— 本机 / 容器这一侧的监听链路是通的");
            println!("          那么如果 ①②③ 里外部改动收不到事件，问题在 CD2 那一侧（见上面两条限制）");
        } else {
            println!("自检结果：✘ 连自己写的文件都没收到事件 —— 问题在本机这一侧，先修这个");
            println!("          常见原因：目录没挂进容器 / inotify 上限不足 / 该文件系统不支持变更通知");
        }
        let _ = std::fs::remove_file(&probe);
        println!("自检：临时文件已删除");
    }

    let mut tick = tokio::time::interval(Duration::from_secs(30));
    tick.tick().await;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("收到 Ctrl+C，结束。共收到 {} 个事件。", counter.load(Ordering::SeqCst));
                break;
            }
            _ = tick.tick() => {
                println!(
                    "[心跳] 已监听 {} 秒，收到 {} 个事件",
                    started.elapsed().as_secs(),
                    counter.load(Ordering::SeqCst)
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_scan_root_narrows_to_the_changed_directory() {
        let music = Path::new("/music");
        // 文件事件 → 它所在的目录
        assert_eq!(
            event_scan_root(music, Path::new("/music/中文/浅影阿/探故知/01 - 探故知.flac")).as_deref(),
            Some("中文/浅影阿/探故知")
        );
        // 库根本身 → 空串（= 整个库）
        assert_eq!(event_scan_root(music, Path::new("/music")).as_deref(), Some(""));
        // 深度 1
        assert_eq!(
            event_scan_root(music, Path::new("/music/中文/浅影阿")).as_deref(),
            Some("中文")
        );
    }

    #[test]
    fn event_scan_root_rejects_paths_outside_the_library() {
        let music = Path::new("/music");
        assert_eq!(event_scan_root(music, Path::new("/elsewhere/01.flac")), None);
        // 前缀像但不同名：/music2 不是 /music 的子路径
        assert_eq!(event_scan_root(music, Path::new("/music2/01.flac")), None);
        // 带 .. 的路径宁可退化成整库，也不给出一个可能越界的范围
        assert_eq!(
            event_scan_root(music, Path::new("/music/中文/../../etc/passwd")),
            None
        );
    }

    #[test]
    fn count_watch_dirs_skips_hidden_and_blacklisted_dirs() {
        let base = std::env::temp_dir().join(format!("metatidy-watch-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("中文/浅影阿")).unwrap();
        std::fs::create_dir_all(base.join("@eaDir/thumbnail")).unwrap();
        std::fs::create_dir_all(base.join(".hidden/deep")).unwrap();
        // 根 + 中文 + 浅影阿 = 3（@eaDir 与 .hidden 子树都不算）
        assert_eq!(count_watch_dirs(&base), 3);
        let _ = std::fs::remove_dir_all(&base);
    }
}
