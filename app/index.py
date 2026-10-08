"""库扫描：把磁盘上的音频文件索引进 SQLite。

这是「歌一多就卡」的解药：
- 全量扫描只做一次，之后**按 mtime + size 增量**，没变的文件直接跳过，不打开文件
- 解析多线程并行，但写入集中在主线程，避免 SQLite 锁争用
- 一次扫描结束顺手清理已消失的文件索引
- 所有进度上报给 jobs 层，前端能实时看到「已扫 N/M」
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Iterator

from . import db, tagio
from .language import infer_language
from .config import SUPPORTED_EXTENSIONS

log = logging.getLogger("metatidy.index")

SKIP_DIRS = {
    "@eaDir",
    "#recycle",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
}


def iter_audio_files(root: Path) -> Iterator[Path]:
    """遍历库根目录下的音频文件（跳过系统/缓存目录）。"""
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: log.warning("遍历失败: %s", e)):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix.lower() in SUPPORTED_EXTENSIONS:
                yield Path(dirpath) / name


def _indexed_state() -> dict[str, tuple[float, float]]:
    """已索引文件的 (mtime, size) 快照，用于增量判断。"""
    rows = db.conn().execute("SELECT path, mtime, size FROM tracks").fetchall()
    return {r["path"]: (r["mtime"] or 0.0, r["size"] or 0.0) for r in rows}


def _parse_one(path: Path, stat_result: os.stat_result, root: Path) -> tuple[Path, os.stat_result, dict, float]:
    started = time.perf_counter()
    tags = tagio.read_tags(path)
    elapsed = time.perf_counter() - started
    ext = path.suffix.lower()
    row = {
        "path": str(path),
        "dir": str(path.parent),
        "filename": path.name,
        "ext": ext,
        "mtime": stat_result.st_mtime,
        "size": stat_result.st_size,
        # 标签缺失时用文件名兜底，保证列表里不出现空白行
        "title": tags.get("title") or path.stem,
        "artist": tags.get("artist") or "",
        "album": tags.get("album") or "",
        "albumartist": tags.get("albumartist") or "",
        "genre": tags.get("genre") or "",
        "year": tags.get("year") or "",
        "track": tags.get("track") or "",
        "disc": tags.get("disc") or "",
        "language": tags.get("language") or infer_language(path, root),
        "composer": tags.get("composer") or "",
        "lyricist": tags.get("lyricist") or "",
        "copyright": tags.get("copyright") or "",
        "albumtype": tags.get("albumtype") or "",
        "comment": tags.get("comment") or "",
        "mb_artist_id": tags.get("mb_artist_id") or "",
        "release_group_id": tags.get("release_group_id") or "",
        "has_cover": int(tags.get("has_cover") or 0),
        "has_lyrics": int(tags.get("has_lyrics") or 0),
        "duration": float(tags.get("duration") or 0.0),
    }
    return path, stat_result, row, elapsed


def scan(
    progress,
    *,
    root: str | Path | None = None,
    full: bool = False,
    prune: bool = True,
    workers: int = 4,
) -> dict:
    """扫描库。full=True 时忽略 mtime/size，强制重新解析全部文件。"""
    from .config import load_settings

    settings = load_settings()
    root_path = Path(root) if root else settings.music_dir
    if not root_path.exists():
        raise FileNotFoundError(f"音乐目录不存在：{root_path}")

    progress.note(f"枚举 {root_path} …")
    files: list[Path] = []
    for path in iter_audio_files(root_path):
        files.append(path)
    total = len(files)
    progress.set_total(total)

    known = {} if full else _indexed_state()
    pending: list[tuple[Path, os.stat_result]] = []
    for path in files:
        try:
            st = path.stat()
        except OSError:
            continue
        prev = known.get(str(path))
        if prev is not None and abs(prev[0] - st.st_mtime) < 1e-6 and prev[1] == st.st_size:
            continue
        pending.append((path, st))

    skipped = total - len(pending)
    progress.note(f"共 {total} 个文件，其中 {len(pending)} 个需要解析（跳过 {skipped} 个未变动）")
    progress.done = skipped
    progress.step(0, force=True)

    added = updated = failed = 0
    parse_seconds = 0.0
    if pending:
        with ThreadPoolExecutor(max_workers=max(1, int(workers)), thread_name_prefix="scan") as pool:
            for _, _, row, elapsed in pool.map(lambda item: _parse_one(*item, root_path), pending, chunksize=4):
                parse_seconds += elapsed
                existed = db.get_track_by_path(row["path"]) is not None
                db.upsert_track(row)
                if existed:
                    updated += 1
                else:
                    added += 1
                progress.step(1, message=f"{row['filename']}")

    on_disk = {str(p) for p in files}
    removed = 0
    if prune:
        gone = [p for p in db.all_paths() if p not in on_disk]
        removed = db.delete_tracks(gone)

    result = {
        "root": str(root_path),
        "scanned": total,
        "parsed": len(pending),
        "skipped": skipped,
        "added": added,
        "updated": updated,
        "removed": removed,
        "failed": failed,
        "seconds": round(parse_seconds, 2),
    }
    progress.step(0, message=f"完成：新增 {added}，更新 {updated}，移除 {removed}", force=True)
    return result
