"""整理移动测试：计划生成、冲突策略、越界拒绝、执行落盘、失败不删源。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import mover
from app.templates import target_path
from tests.audiofix import make_flac


@pytest.fixture()
def library(tmp_path):
    """一个能用的临时库：两首歌放在乱目录里。"""
    root = tmp_path / "lib"
    root.mkdir()
    (root / "incoming").mkdir()
    (root / "incoming" / "a.flac").parent.mkdir(parents=True, exist_ok=True)
    make_flac(root / "incoming" / "a.flac")
    make_flac(root / "incoming" / "b.flac")
    return root


def _row(track_id, path, **kw):
    base = {
        "id": track_id,
        "path": str(path),
        "filename": Path(path).name,
        "ext": ".flac",
        "title": f"歌{track_id}",
        "artist": "周杰伦",
        "albumartist": "周杰伦",
        "album": "魔杰座",
        "year": "2008",
        "track": str(track_id),
        "language": "中文",
    }
    base.update(kw)
    return base


def test_plan_marks_in_place(library):
    row = _row(1, library / "incoming" / "a.flac")
    target = target_path(row, library, "{artist}/{album}", "{title}")
    target.parent.mkdir(parents=True, exist_ok=True)
    make_flac(target)
    row["path"] = str(target)

    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    assert plan["items"][0]["action"] == "in_place"


def test_import_from_outside_root_is_allowed(library, tmp_path):
    """源在库外（例如待导入目录）、目标在库内 —— 允许，属于「导入」场景。"""
    outside = tmp_path / "incoming-elsewhere"
    outside.mkdir()
    make_flac(outside / "x.flac")
    row = _row(1, outside / "x.flac")
    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    assert plan["items"][0]["action"] == "move"
    assert str(library) in plan["items"][0]["target"]


def test_plan_rejects_target_outside_root(library, tmp_path, monkeypatch):
    """即使模板被绕过，目标越界也必须拒绝（安全底线）。"""
    make_flac(library / "incoming" / "a.flac")
    row = _row(1, library / "incoming" / "a.flac")
    escaped = tmp_path / "escaped" / "x.flac"
    monkeypatch.setattr(mover, "target_path", lambda *a, **k: escaped)
    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    assert plan["items"][0]["action"] == "invalid"
    assert "库根目录" in plan["items"][0]["reason"]


def test_plan_conflict_rename(library):
    # 目标位置已经有同名文件
    existing = library / "周杰伦" / "魔杰座" / "歌1.flac"
    make_flac(existing)
    row = _row(1, library / "incoming" / "a.flac")
    plan = mover.plan_moves(
        [row],
        library_root=library,
        dir_template="{artist}/{album}",
        filename_template="{title}",
        conflict_policy="rename",
    )
    item = plan["items"][0]
    assert item["action"] == "conflict_rename"
    assert item["target"].endswith("歌1 (2).flac")


def test_plan_conflict_skip(library):
    make_flac(library / "周杰伦" / "魔杰座" / "歌1.flac")
    row = _row(1, library / "incoming" / "a.flac")
    plan = mover.plan_moves(
        [row],
        library_root=library,
        dir_template="{artist}/{album}",
        filename_template="{title}",
        conflict_policy="skip",
    )
    assert plan["items"][0]["action"] == "conflict_skip"


def test_two_tracks_same_target_are_staggered(library):
    rows = [
        _row(1, library / "incoming" / "a.flac", title="同一首"),
        _row(2, library / "incoming" / "b.flac", title="同一首"),
    ]
    plan = mover.plan_moves(rows, library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    targets = [i["target"] for i in plan["items"]]
    assert len(set(targets)) == 2, "同一计划内的目标不能重复"


def test_execute_moves_and_updates_callback(library, clean_db):
    source = library / "incoming" / "a.flac"
    clean_db.upsert_track({**_row(0, source), "dir": str(source.parent), "mtime": 1.0, "size": source.stat().st_size})
    row = _row(clean_db.get_track_by_path(str(source))["id"], source)

    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    assert plan["items"][0]["action"] == "move"
    summary = mover.execute_plan(plan)

    assert summary["moved"] == 1
    assert summary["failed"] == 0
    assert not source.exists(), "源文件应已移走"
    assert Path(plan["items"][0]["target"]).exists()
    # 索引里的路径同步更新
    assert clean_db.get_track(row["id"])["path"] == plan["items"][0]["target"]


def test_execute_dry_run_touches_nothing(library):
    source = library / "incoming" / "a.flac"
    row = _row(1, source)
    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")
    summary = mover.execute_plan(plan, dry_run=True)
    assert summary["moved"] == 1
    assert source.exists(), "dry_run 不能移动文件"


def test_execute_keeps_source_on_failure(library, monkeypatch):
    source = library / "incoming" / "a.flac"
    row = _row(1, source)
    plan = mover.plan_moves([row], library_root=library, dir_template="{artist}/{album}", filename_template="{title}")

    def boom(*_a, **_kw):
        raise OSError("模拟磁盘错误")

    monkeypatch.setattr(mover, "_move_with_retry", boom)
    summary = mover.execute_plan(plan)
    assert summary["failed"] == 1
    assert summary["moved"] == 0
    assert source.exists(), "失败必须保留源文件"
    assert "模拟磁盘错误" in summary["failures"][0]["error"]


def test_unknown_artist_falls_back(library):
    row = _row(1, library / "incoming" / "a.flac", artist="", albumartist="")
    plan = mover.plan_moves(
        [row],
        library_root=library,
        dir_template="{artist}/{album}",
        filename_template="{title}",
        unknown_artist="未知艺术家",
    )
    assert "未知艺术家" in plan["items"][0]["target"]


def test_optional_language_segment_dropped(library):
    row = _row(1, library / "incoming" / "a.flac", language="")
    plan = mover.plan_moves(
        [row],
        library_root=library,
        dir_template="{language?}/{artist}/{album}",
        filename_template="{title}",
    )
    assert "未知" not in plan["items"][0]["target"].split("lib")[-1]
