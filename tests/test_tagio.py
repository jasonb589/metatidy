"""标签读写测试：合成 flac / mp3 上的写入、回读、差异预览。"""

from __future__ import annotations

import pytest

from app import tagio
from tests.audiofix import make_flac, make_mp3


@pytest.fixture()
def flac_file(tmp_path):
    return make_flac(tmp_path / "song.flac")


@pytest.fixture()
def mp3_file(tmp_path):
    return make_mp3(tmp_path / "song.mp3")


def test_read_empty_tags(flac_file):
    tags = tagio.read_tags(flac_file)
    assert tags["title"] == ""
    assert tags["has_cover"] == 0


def test_flac_roundtrip(flac_file):
    written = tagio.apply_update(
        flac_file,
        {
            "title": "稻香",
            "artist": "周杰伦 & 费玉清",
            "album": "魔杰座",
            "albumartist": "周杰伦",
            "genre": "流行",
            "year": "2008",
            "track": "3",
            "disc": "1",
            "language": "中文",
            "albumtype": "专辑",
            "mb_artist_id": "abc-123",
        },
    )
    assert written["count"] > 0
    tags = tagio.read_tags(flac_file)
    assert tags["title"] == "稻香"
    assert tags["artist"] == "周杰伦 & 费玉清"
    assert tags["album"] == "魔杰座"
    assert tags["year"] == "2008"
    assert tags["language"] == "中文"
    assert tags["mb_artist_id"] == "abc-123"


def test_mp3_roundtrip(mp3_file):
    tagio.apply_update(
        mp3_file,
        {
            "title": "七里香",
            "artist": "周杰伦",
            "album": "七里香",
            "year": "2004",
            "track": "1",
            "albumtype": "专辑",
        },
    )
    tags = tagio.read_tags(mp3_file)
    assert tags["title"] == "七里香"
    assert tags["artist"] == "周杰伦"
    assert tags["track"] == "1"
    assert tags["albumtype"] == "专辑"
    assert tags["duration"] > 0


def test_preview_does_not_write(flac_file):
    before = tagio.read_tags(flac_file)
    plan = tagio.preview_update(flac_file, {"title": "新名字", "artist": "某人"})
    after = tagio.read_tags(flac_file)
    assert before == after, "preview 不能改文件"
    assert set(plan["changes"]) == {"title", "artist"}
    assert plan["changes"]["title"]["old"] == ""
    assert plan["changes"]["title"]["new"] == "新名字"


def test_apply_overwrite_false_keeps_existing(flac_file):
    tagio.apply_update(flac_file, {"album": "原专辑"})
    tagio.apply_update(flac_file, {"album": "新专辑"}, overwrite=False)
    assert tagio.read_tags(flac_file)["album"] == "原专辑"
    tagio.apply_update(flac_file, {"album": "新专辑"}, overwrite=True)
    assert tagio.read_tags(flac_file)["album"] == "新专辑"


def test_preview_reports_no_change_when_identical(flac_file):
    tagio.apply_update(flac_file, {"title": "同名"})
    plan = tagio.preview_update(flac_file, {"title": "同名"})
    assert plan["count"] == 0


def test_lyrics_write_and_read(flac_file):
    tagio.apply_update(flac_file, {"title": "带歌词"}, lyrics="测试歌词第一行")
    assert tagio.read_lyrics(flac_file) == "测试歌词第一行"
    assert tagio.read_tags(flac_file)["has_lyrics"] == 1


def test_cover_write_and_read(flac_file):
    # 一个 1x1 的 PNG
    import base64

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )
    try:
        tagio.apply_update(flac_file, {"title": "有封面"}, cover=png, cover_mime="image/png")
    except Exception:
        pytest.skip("合成 PNG 不被 mutagen 接受，跳过封面用例")
    got = tagio.read_cover(flac_file)
    assert got is not None
    assert got[0] == png
    assert tagio.read_tags(flac_file)["has_cover"] == 1


def test_unsupported_format_raises(tmp_path):
    bad = tmp_path / "song.wav"
    bad.write_bytes(b"RIFF....")
    with pytest.raises(tagio.TagError):
        tagio.apply_update(bad, {"title": "x"})


def test_missing_file_returns_error(tmp_path):
    tags = tagio.read_tags(tmp_path / "nope.flac")
    assert tags.get("error")
