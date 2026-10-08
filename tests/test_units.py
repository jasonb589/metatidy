"""单元测试：多歌手归一化、模板引擎、路径安全。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.normalize import normalize_artist_credit, normalize_filename_artist_credit
from app.templates import (
    render_filename,
    render_relative_dir,
    sanitize_filename,
    target_path,
    validate_template,
)


# --------------------------------------------------------------------------- 歌手归一化


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("A & B", "A & B"),
        ("A/B", "A & B"),
        ("A、B", "A & B"),
        ("A feat. B", "A & B"),
        ("A ft. B", "A & B"),
        ("A featuring B", "A & B"),
        ("A with B", "A & B"),
        ("周杰伦 五月天", "周杰伦 & 五月天"),
        ("Jay Chou", "Jay Chou"),  # 全拉丁空格不拆
        ("Jay Chou 周杰伦", "Jay Chou & 周杰伦"),  # 拉丁↔CJK 拆
        ("周杰伦 Jay Chou", "周杰伦 & Jay Chou"),
        ("A & A", "A"),  # 去重
        ("", ""),
        ("   陈奕迅   ", "陈奕迅"),
    ],
)
def test_normalize_artist_credit(raw, expected):
    assert normalize_artist_credit(raw) == expected


def test_normalize_filename_keeps_single_separator():
    assert normalize_filename_artist_credit("稻香 - 周杰伦/费玉清") == "稻香 - 周杰伦 & 费玉清"
    # 多个 " - " 不动（无法判断哪段是歌手）
    assert normalize_filename_artist_credit("A - B - C") == "A - B - C"


# --------------------------------------------------------------------------- 文件名安全


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('a/b\\c:d*e?f"g<h>i|j', "a_b_c_d_e_f_g_h_i_j"),
        ("  trailing.  ", "trailing"),
        ("CON", "_CON"),
        ("", "Unknown"),
        ("   ", "Unknown"),
    ],
)
def test_sanitize_filename(raw, expected):
    assert sanitize_filename(raw) == expected


# --------------------------------------------------------------------------- 模板引擎


def _track(**kw):
    base = {
        "id": 1,
        "path": r"D:\lib\稻香.flac",
        "filename": "稻香.flac",
        "ext": ".flac",
        "title": "稻香",
        "artist": "周杰伦",
        "albumartist": "周杰伦",
        "album": "魔杰座",
        "year": "2008",
        "track": "3/12",
        "disc": "1/1",
        "genre": "流行",
        "language": "中文",
        "albumtype": "专辑",
    }
    base.update(kw)
    return base


def test_render_dir_basic():
    values = _values(_track())
    assert render_relative_dir("{language}/{artist}/{album}", values) == "中文/周杰伦/魔杰座"


def _values(track):
    from app.templates import build_values

    return build_values(track, unknown_artist="未知艺术家", unknown_album="未知专辑", unknown_other="未知")


def test_track_number_splits_and_pads():
    values = _values(_track())
    assert render_filename("{track:02} - {title}", values, ".flac") == "03 - 稻香.flac"
    assert render_filename("{disc:02}.{track:03}", values, ".mp3") == "01.003.mp3"


def test_optional_segment_dropped_when_empty():
    from app.templates import build_values

    values = build_values(
        _track(language=""),
        unknown_artist="未知艺术家",
        unknown_album="未知专辑",
        unknown_other="未知",
    )
    # 无回退文案的字段渲染为空 -> 整段丢弃，不会留下 "未知/" 空壳
    assert render_relative_dir("{language?}/{artist}/{album}", values) == "周杰伦/魔杰座"
    assert render_relative_dir("{language}/{artist}", values) == "周杰伦"
    # 有回退文案的字段为空则用回退值，文件不会散在库根目录
    assert render_relative_dir("{artist}/{album}", _values(_track(artist="", album="", albumartist=""))) == "未知艺术家/未知专辑"


def test_unknown_album_fallback():
    values = _values(_track(album="", albumartist=""))
    assert render_relative_dir("{artist}/{album}", values) == "周杰伦/未知专辑"


def test_target_path_inside_root():
    target = target_path(
        _track(),
        r"D:\lib",
        "{language}/{artist}/{album}",
        "{track:02} - {title}",
    )
    assert str(target).startswith(r"D:\lib")
    assert target.name == "03 - 稻香.flac"
    assert target.parent.name == "魔杰座"


def test_illegal_chars_in_segments():
    target = target_path(
        _track(title='A/B:C', artist="X?Y"),
        "/lib",
        "{artist}/{album}",
        "{title}",
    )
    parts = target.parts
    assert "X_Y" in parts
    assert target.name == "A_B_C.flac"


def test_validate_template_reports_unknown_placeholder():
    warnings = validate_template("{nope}/{artist}", {"artist", "album", "title"})
    assert any("nope" in w for w in warnings)


def test_sanitize_protects_path_traversal():
    target = target_path(_track(artist="../../etc"), "/lib", "{artist}", "{title}")
    assert ".." not in Path(target).parts
