"""整理移动执行器（功能 3 的落盘部分）。

安全原则（来自旧项目的血泪教训）：
- **先预览再执行**：`plan_moves()` 只算不动，`execute_plan()` 才动文件。
- **只在库根目录内移动**：目标路径必须落在 `library_root` 之下，否则拒绝。
- **失败绝不删源**：跨盘/云盘搬运时先复制、校验大小一致，才删源；任何异常都保留源文件。
- **抗抖动重试**：Windows 上云盘常见 WinError 1450/32/33（资源不足/占用），退避重试 3 次。
- **同计划内冲突**：两首歌算出同一目标时自动错开，避免互相覆盖。
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from . import db
from .templates import path_length_warning, target_path

# 可重试的 Windows 错误码（资源不足 / 占用 / 共享冲突）
RETRYABLE_WINERRORS = {5, 32, 33, 1450}

MAX_RETRY = 3
RETRY_BACKOFF = 0.4


@dataclass
class MoveItem:
    """一条移动计划。"""

    track_id: int
    source: str
    target: str
    action: str  # move | in_place | conflict_rename | conflict_skip | conflict_overwrite | invalid
    reason: str = ""
    filename: str = ""
    artist: str = ""
    title: str = ""
    warning: str = ""

    def as_dict(self) -> dict:
        return {
            "track_id": self.track_id,
            "source": self.source,
            "target": self.target,
            "action": self.action,
            "reason": self.reason,
            "filename": self.filename,
            "artist": self.artist,
            "title": self.title,
            "warning": self.warning,
        }


@dataclass
class MoveSummary:
    moved: int = 0
    skipped: int = 0
    failed: int = 0
    renamed: int = 0
    failures: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "moved": self.moved,
            "skipped": self.skipped,
            "failed": self.failed,
            "renamed": self.renamed,
            "failures": self.failures,
        }


def _is_inside(root: Path, path: Path) -> bool:
    try:
        p = path.resolve(strict=False)
        r = root.resolve(strict=False)
        return p == r or r in p.parents
    except OSError:
        return False


def _unique_target(target: Path, taken: set[str]) -> Path:
    """目标已存在（磁盘上或本计划内）时追加 " (2)"、" (3)"…"""
    def busy(p: Path) -> bool:
        return p.exists() or str(p).lower() in taken

    if not busy(target):
        return target
    stem, suffix, parent = target.stem, target.suffix, target.parent
    for n in range(2, 1000):
        cand = parent / f"{stem} ({n}){suffix}"
        if not busy(cand):
            return cand
    return parent / f"{stem} ({int(time.time())}){suffix}"


def plan_moves(
    rows: Iterable[dict],
    *,
    library_root: Path | str,
    dir_template: str,
    filename_template: str,
    conflict_policy: str = "rename",
    unknown_artist: str = "未知艺术家",
    unknown_album: str = "未知专辑",
    unknown_other: str = "未知",
    artist_normalizer: Callable[[str], str] | None = None,
    limit: int | None = None,
) -> dict:
    """生成移动计划（不触碰文件系统，只读 exists 判断）。"""
    root = Path(library_root)
    items: list[MoveItem] = []
    taken: set[str] = set()
    rows = list(rows)
    truncated = False

    for row in rows:
        if limit is not None and len(items) >= limit:
            truncated = True
            break
        source = Path(row.get("path") or "")
        item = MoveItem(
            track_id=int(row.get("id") or 0),
            source=str(source),
            target="",
            action="invalid",
            filename=row.get("filename") or source.name,
            artist=row.get("artist") or "",
            title=row.get("title") or "",
        )
        if not row.get("path"):
            item.reason = "索引里没有路径"
            items.append(item)
            continue
        try:
            target = target_path(
                row,
                root,
                dir_template,
                filename_template,
                unknown_artist=unknown_artist,
                unknown_album=unknown_album,
                unknown_other=unknown_other,
                artist_normalizer=artist_normalizer,
            )
        except Exception as exc:  # 模板问题不能让整个计划崩掉
            item.reason = f"模板渲染失败：{exc}"
            items.append(item)
            continue

        item.target = str(target)
        warn = path_length_warning(target)
        if warn:
            item.warning = warn

        if not _is_inside(root, target):
            item.action = "invalid"
            item.reason = f"目标不在库根目录内（{root}）"
            items.append(item)
            continue
        if not source.exists():
            item.action = "invalid"
            item.reason = "源文件不存在（可能已被移动或删除）"
            items.append(item)
            continue
        if source.resolve(strict=False) == target.resolve(strict=False):
            item.action = "in_place"
            item.reason = "已在目标位置"
            taken.add(str(target).lower())
            items.append(item)
            continue

        # 同计划内两首歌撞同一目标：先错开，避免执行时互相覆盖
        if str(target).lower() in taken:
            target = _unique_target(target, taken)
            item.target = str(target)
            item.action = "conflict_rename"
            item.reason = "与计划中其它曲目目标重复，已自动错开"
            taken.add(str(target).lower())
            items.append(item)
            continue

        if target.exists():
            if conflict_policy == "skip":
                item.action = "conflict_skip"
                item.reason = "目标已存在，按策略跳过"
            elif conflict_policy == "overwrite":
                item.action = "conflict_overwrite"
                item.reason = "目标已存在，按策略覆盖"
            else:
                target = _unique_target(target, taken)
                item.target = str(target)
                item.action = "conflict_rename"
                item.reason = "目标已存在，已改名避免覆盖"
            taken.add(str(target).lower())
            items.append(item)
            continue

        item.action = "move"
        taken.add(str(target).lower())
        items.append(item)

    counts: dict[str, int] = {}
    for it in items:
        counts[it.action] = counts.get(it.action, 0) + 1

    return {
        "library_root": str(root),
        "dir_template": dir_template,
        "filename_template": filename_template,
        "conflict_policy": conflict_policy,
        "total": len(rows),
        "planned": len(items),
        "truncated": truncated,
        "counts": counts,
        "items": [it.as_dict() for it in items],
    }


def _move_with_retry(source: Path, target: Path) -> None:
    """同盘用 os.replace（零拷贝）；跨盘退化为 复制->校验->删源。失败时源文件保持不动。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    src_size = source.stat().st_size
    last_exc: Exception | None = None

    for attempt in range(1, MAX_RETRY + 1):
        try:
            same_device = True
            try:
                same_device = os.stat(source).st_dev == os.stat(target.parent).st_dev
            except OSError:
                same_device = True
            if same_device:
                os.replace(str(source), str(target))
            else:
                shutil.copy2(str(source), str(target))
                if target.stat().st_size != src_size:
                    raise OSError(f"复制校验失败：源 {src_size} 字节，目标 {target.stat().st_size} 字节")
                os.remove(str(source))
            return
        except OSError as exc:
            last_exc = exc
            winerr = getattr(exc, "winerror", None)
            if winerr not in RETRYABLE_WINERRORS or attempt == MAX_RETRY:
                raise
            # 跨盘复制失败时清掉半成品，避免留下坏文件
            try:
                if target.exists() and target.stat().st_size != src_size:
                    target.unlink()
            except OSError:
                pass
            time.sleep(RETRY_BACKOFF * (2 ** (attempt - 1)))
    if last_exc:
        raise last_exc


def execute_plan(
    plan: dict,
    *,
    dry_run: bool = False,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> dict:
    """执行计划。返回汇总；失败明细在 failures 里，源文件永不删除。"""
    items = plan.get("items") or []
    root = Path(plan.get("library_root") or ".")
    summary = MoveSummary()
    total = len(items)
    executed: list[tuple[MoveItem, Path]] = [MoveItem(**{k: it.get(k) for k in MoveItem.__dataclass_fields__}) for it in items]
    executed = [(it, Path(it.target)) for it in executed]

    for idx, (item, target) in enumerate(executed, start=1):
        if on_progress:
            on_progress(idx, total, item.filename)
        if item.action in {"in_place", "conflict_skip", "invalid"}:
            summary.skipped += 1
            continue
        if dry_run:
            summary.moved += 1
            continue
        source = Path(item.source)
        if not _is_inside(root, target):
            summary.failed += 1
            summary.failures.append({"source": item.source, "target": item.target, "error": "目标越出库根目录"})
            continue
        final_target = target
        if final_target.exists() and item.action != "conflict_overwrite":
            final_target = _unique_target(final_target, set())
        try:
            _move_with_retry(source, final_target)
        except Exception as exc:  # noqa: BLE001 —— 单文件失败不影响整批
            summary.failed += 1
            summary.failures.append({
                "source": item.source,
                "target": str(final_target),
                "error": f"{type(exc).__name__}: {exc}",
            })
            continue
        summary.moved += 1
        if item.action == "conflict_rename" or str(final_target) != item.target:
            summary.renamed += 1
        if item.track_id:
            try:
                db.set_track_path(item.track_id, str(final_target))
            except Exception:  # 索引更新失败不影响文件已移动的事实
                pass

    return summary.as_dict()
