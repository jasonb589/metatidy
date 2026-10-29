"""集成测试：路径语言推断、迁移层（12+ 源）接入、扫描增强。"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import scrapebridge
from app.language import infer_language
from tests.audiofix import make_flac


@pytest.fixture()
def client(clean_db):
    from app.main import app

    with TestClient(app) as c:
        yield c


def _wait_job(client, job_id: str, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/jobs/{job_id}").json()
        if data["state"] in {"done", "error"}:
            return data
        time.sleep(0.2)
    raise AssertionError(f"任务 {job_id} 超时")


# --------------------------------------------------------------------------- 路径语言推断


@pytest.mark.parametrize(
    "rel,expected",
    [
        ("俄文/ADÉLA/PRIMA/song.flac", "俄文"),
        ("尼泊尔文/Ekdev Limbu/album/song.flac", "尼泊尔文"),
        ("土耳其文/Gülşen/BAL/song.flac", "土耳其文"),
        ("中文/周杰伦/魔杰座/稻香.flac", "中文"),
        ("英文/ADELE/25/Hello.flac", "英文"),
        ("国语/某歌手/专辑/x.flac", "中文"),
        ("未分类/某歌手/专辑/x.flac", ""),
        ("song.flac", ""),
    ],
)
def test_infer_language(tmp_path, rel, expected):
    root = tmp_path / "lib"
    assert infer_language(root / rel, root) == expected


def test_infer_language_outside_root(tmp_path):
    root = tmp_path / "lib"
    assert infer_language(tmp_path / "other" / "俄文" / "x.flac", root) == ""


def test_scan_fills_language_from_path(client, music_dir):
    """标签里没有 language 时，用库目录第一层兜底，避免整理时把语言目录压平。"""
    target = music_dir / "俄文" / "ADÉLA" / "PRIMA" / "KGB - ADÉLA.flac"
    make_flac(target)

    job = client.post("/api/scan", json={"full": True}).json()
    assert _wait_job(client, job["job_id"])["state"] == "done"

    listing = client.get("/api/tracks", params={"page_size": 10}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["language"] == "俄文"


# --------------------------------------------------------------------------- 迁移层接入


def test_core_is_available_and_exposes_sources():
    status = scrapebridge.core_status()
    assert status["available"] is True, "metatidy_core 应该已迁移"
    assert status["count"] >= 12, status
    for name in ("netease", "qq", "kugou", "kuwo", "musicbrainz", "itunes", "deezer",
                 "lastfm", "theaudiodb", "spotify", "genius", "ytmusic"):
        assert name in status["sources"], f"{name} 未接通"


def test_list_sources_marks_migrated():
    items = {s["name"]: s for s in scrapebridge.list_sources()}
    assert items["kugou"]["status"] == "已迁移"
    assert items["musicbrainz"]["status"] == "已迁移"
    assert items["spotify"]["needs_key"]


@pytest.mark.skipif(__import__("os").environ.get("METATIDY_OFFLINE") == "1", reason="离线跳过")
def test_migrated_source_returns_candidates():
    """迁移层的源（非内置实现）也要真的能出结果，并如实报告每个源的状态。"""
    sources = ["netease", "musicbrainz", "itunes"]
    result = scrapebridge.search("稻香", artist_hint="周杰伦", sources=sources, limit=2, timeout=30)
    status = {s["source"]: s for s in result["source_status"]}
    assert set(status) == set(sources)
    total = sum(s.get("count", 0) for s in result["source_status"])
    assert total > 0, f"所有源都没结果（可能网络受限）：{result['source_status']}"
    top = result["candidates"][0]
    assert top["title"]
    assert top["confidence"] in {"高", "中", "待确认"}


@pytest.mark.skipif(__import__("os").environ.get("METATIDY_OFFLINE") == "1", reason="离线跳过")
def test_candidate_fields_align_with_editable_fields(client, scanned_ids=None):
    """候选字段名要能直接搬到标签里（albumartist/track/disc/albumtype 等）。"""
    from app import db

    result = scrapebridge.search("稻香", artist_hint="周杰伦", sources=["netease", "musicbrainz", "itunes"], limit=2, timeout=30)
    assert result["candidates"], result["source_status"]
    editable = set(db.EDITABLE_FIELDS)
    assert editable & set(result["candidates"][0]), "候选字段应与可编辑字段有交集"
    assert {"title", "artist", "album"} <= set(result["candidates"][0])


@pytest.mark.skipif(__import__("os").environ.get("METATIDY_OFFLINE") == "1", reason="离线跳过")
def test_lyrics_returns_string():
    text = scrapebridge.fetch_lyrics("稻香", "周杰伦")
    assert isinstance(text, str)


@pytest.mark.skipif(__import__("os").environ.get("METATIDY_OFFLINE") == "1", reason="离线跳过（未知源会回退到默认优先级，实际会联网）")
def test_search_rejects_unknown_source_gracefully():
    result = scrapebridge.search("test", sources=["not_a_source"], limit=1, timeout=5)
    assert result["sources"] == scrapebridge.SEARCH_PRIORITY  # 回退到默认优先级
    assert isinstance(result["candidates"], list)
