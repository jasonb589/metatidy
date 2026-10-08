"""接口级测试：三个功能走一遍完整 HTTP 流程。

用 fastapi.testclient（不需要起服务器），覆盖：
- 扫描 -> 列表（索引优先，不读文件）
- 元数据编辑：preview 不改文件 / apply 真的改文件
- 搜索：内置源真实联网（可跳过）
- 整理移动：preview 出 token -> execute 后台任务 -> 文件真的移动
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.audiofix import make_flac

os.environ.setdefault("METATIDY_OFFLINE", "0")


@pytest.fixture()
def client(clean_db):
    from app.main import app

    with TestClient(app) as c:
        yield c


def _wait_job(client, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/jobs/{job_id}").json()
        if data["state"] in {"done", "error"}:
            return data
        time.sleep(0.2)
    raise AssertionError(f"任务 {job_id} 超时未完成")


@pytest.fixture()
def scanned(client, music_dir):
    """放两首歌进库、扫描、返回 id 列表。"""
    album = music_dir / "临时目录" / "周杰伦 - 魔杰座"
    album.mkdir(parents=True, exist_ok=True)
    from mutagen.flac import FLAC

    for idx, title in enumerate(["稻香", "说好的幸福呢"], start=1):
        path = album / f"{title}.flac"
        make_flac(path)
        audio = FLAC(str(path))
        audio["title"] = [title]
        audio["artist"] = ["周杰伦"]
        audio["album"] = ["魔杰座"]
        audio["tracknumber"] = [str(idx)]
        audio.save()

    job = client.post("/api/scan", json={"full": True}).json()
    result = _wait_job(client, job["job_id"])
    assert result["state"] == "done", result
    listing = client.get("/api/tracks", params={"page_size": 50}).json()
    return [item["id"] for item in listing["items"]]


def test_status_and_empty_library(client):
    data = client.get("/api/status").json()
    assert data["version"]
    assert "stats" in data
    assert data["stats"]["tracks"] == 0


def test_scan_indexes_tracks(client, scanned):
    listing = client.get("/api/tracks", params={"page_size": 50}).json()
    assert listing["total"] == 2
    titles = {i["title"] for i in listing["items"]}
    assert titles == {"稻香", "说好的幸福呢"}
    # 列表走索引，必须带上这些字段但不含封面二进制
    first = listing["items"][0]
    for key in ("id", "path", "artist", "album", "has_cover", "duration"):
        assert key in first


def test_search_in_library(client, scanned):
    data = client.get("/api/tracks", params={"q": "稻香"}).json()
    assert data["total"] == 1


def test_edit_preview_then_apply(client, scanned):
    track_id = scanned[0]

    preview = client.post(
        "/api/tracks/preview",
        json={"ids": [track_id], "fields": {"album": "魔杰座 (2008)", "artist": "周杰伦/费玉清"}},
    ).json()
    assert preview["changed_fields"] >= 2
    changes = preview["items"][0]["changes"]
    assert changes["album"]["new"] == "魔杰座 (2008)"
    # 多歌手被归一化成 &
    assert changes["artist"]["new"] == "周杰伦 & 费玉清"

    # preview 不落盘
    detail = client.get(f"/api/tracks/{track_id}").json()
    assert detail["album"] == "魔杰座"

    applied = client.post(
        "/api/tracks/apply",
        json={"ids": [track_id], "fields": {"album": "魔杰座 (2008)", "artist": "周杰伦/费玉清"}},
    ).json()
    assert applied["written"] == 1
    assert applied["failed"] == []

    from app import tagio

    detail = client.get(f"/api/tracks/{track_id}").json()
    tags = tagio.read_tags(detail["path"])
    assert tags["album"] == "魔杰座 (2008)"
    assert tags["artist"] == "周杰伦 & 费玉清"
    # 索引也同步了
    assert client.get(f"/api/tracks/{track_id}").json()["artist"] == "周杰伦 & 费玉清"


def test_batch_edit_multiple_tracks(client, scanned):
    preview = client.post(
        "/api/tracks/preview",
        json={"ids": scanned, "fields": {"genre": "流行"}},
    ).json()
    assert len(preview["items"]) == 2
    applied = client.post("/api/tracks/apply", json={"ids": scanned, "fields": {"genre": "流行"}}).json()
    assert applied["written"] == 2
    listing = client.get("/api/tracks", params={"genre": "流行"}).json()
    assert listing["total"] == 2


def test_edit_empty_fields_rejected(client, scanned):
    resp = client.post("/api/tracks/preview", json={"ids": [scanned[0]], "fields": {}})
    assert resp.status_code == 400
    resp = client.post("/api/tracks/apply", json={"ids": [], "fields": {"title": "x"}})
    assert resp.status_code == 400


def test_move_preview_and_execute(client, scanned, clean_db, music_dir):
    listing = client.get("/api/tracks", params={"page_size": 50}).json()
    ids = [i["id"] for i in listing["items"]]
    before = {i["id"]: i["path"] for i in listing["items"]}

    preview = client.post(
        "/api/move/preview",
        json={"ids": ids, "dir_template": "{artist}/{album}", "filename_template": "{track:02} - {title}"},
    ).json()
    assert preview["token"]
    actions = {i["action"] for i in preview["items"]}
    assert actions <= {"move", "in_place", "conflict_rename", "conflict_skip", "invalid"}
    assert preview["counts"].get("move", 0) == 2

    # 预览阶段文件不能动
    for tid, path in before.items():
        assert Path(path).exists()

    job = client.post("/api/move/execute", json={"token": preview["token"]}).json()
    result = _wait_job(client, job["job_id"])
    assert result["state"] == "done", result
    import json as _json

    summary = _json.loads(result["result"])
    assert summary["moved"] == 2

    # 文件真的到了新位置，且索引同步
    for item in preview["items"]:
        assert Path(item["target"]).exists(), item["target"]
        assert not Path(item["source"]).exists()

    after = client.get("/api/tracks", params={"page_size": 50}).json()
    new_paths = sorted(i["path"] for i in after["items"])
    assert any("周杰伦" in p and p.endswith("01 - 稻香.flac") for p in new_paths), new_paths

    # 同一 token 不能重复执行
    again = client.post("/api/move/execute", json={"token": preview["token"]})
    assert again.status_code == 409


def test_move_dry_run(client, scanned):
    ids = [i["id"] for i in client.get("/api/tracks", params={"page_size": 50}).json()["items"]]
    preview = client.post(
        "/api/move/preview",
        json={"ids": ids, "dir_template": "{artist}/{album}", "filename_template": "{title}"},
    ).json()
    result = client.post("/api/move/execute", json={"token": preview["token"], "dry_run": True}).json()
    assert result["moved"] == 2
    for item in preview["items"]:
        assert Path(item["source"]).exists(), "dry_run 不能动文件"


def test_template_test_endpoint(client, scanned):
    data = client.get(
        "/api/template/test",
        params={"dir_template": "{language?}/{artist}/{album}", "filename_template": "{title}"},
    ).json()
    assert data["target"].endswith(".flac")


def test_settings_roundtrip(client, clean_db):
    resp = client.put("/api/settings", json={"values": {"dir_template": "{artist}/{album}", "conflict_policy": "skip"}})
    assert resp.status_code == 200
    data = client.get("/api/settings").json()
    assert data["values"]["dir_template"] == "{artist}/{album}"
    assert data["values"]["conflict_policy"] == "skip"
    assert any(p["key"] == "artist" for p in data["placeholders"])


def test_settings_rejects_unknown_placeholder_warning(client, clean_db):
    resp = client.put("/api/settings", json={"values": {"dir_template": "{nope}/{artist}"}})
    assert resp.status_code == 200
    assert resp.json()["warnings"]


def test_aliases_roundtrip(client, clean_db):
    client.put("/api/aliases/artist", json={"items": [{"from": "周杰伦", "to": "Jay Chou"}]})
    items = client.get("/api/aliases/artist").json()["items"]
    assert items == [{"from": "周杰伦", "to": "Jay Chou"}]


@pytest.mark.skipif(os.environ.get("METATIDY_OFFLINE") == "1", reason="离线模式跳过联网")
def test_search_hits_real_sources(client, scanned):
    """真实联网搜索：至少 MusicBrainz / iTunes / Deezer 之一返回候选。"""
    track_id = scanned[0]
    resp = client.post("/api/search", json={"track_id": track_id, "sources": ["musicbrainz", "itunes", "deezer"], "limit": 3})
    assert resp.status_code == 200
    data = resp.json()
    assert "candidates" in data
    assert data["source_status"], "应记录每个源的状态"
    assert data["candidates"], f"三个源都没结果：{data['source_status']}"
    top = data["candidates"][0]
    assert top["source"] in {"musicbrainz", "itunes", "deezer"}
    assert top["score"] >= 0
    assert top["confidence"] in {"高", "中", "待确认"}


def test_sources_endpoint(client):
    data = client.get("/api/sources").json()
    names = {s["name"] for s in data["sources"]}
    assert {"musicbrainz", "itunes", "deezer", "netease", "qq"} <= names
    assert {"kuwo", "kugou", "lastfm", "theaudiodb", "spotify", "genius", "ytmusic"} <= names


# --------------------------------------------------------------------------- 批量刮削语义


def _fake_search(monkeypatch, candidate: dict):
    from app import scrapebridge

    payload = {"candidates": [candidate], "source_status": [{"source": "fake", "count": 1}]}
    monkeypatch.setattr(scrapebridge, "search", lambda *a, **k: payload)


def test_batch_scrape_zero_threshold_only_searches(client, scanned, monkeypatch):
    """auto_apply_min_score = 0 必须真的「只搜索不写入」（曾经会直接写最佳候选）。"""
    import json as _json

    from app import tagio

    _fake_search(monkeypatch, {"source": "fake", "title": "稻香", "artist": "周杰伦", "genre": "流行", "score": 150, "confidence": "高"})
    job = client.post("/api/scrape/batch", json={"ids": scanned, "fields": ["genre"], "auto_apply_min_score": 0}).json()
    result = _json.loads(_wait_job(client, job["job_id"])["result"])
    assert result["search_only"] is True
    assert result["applied"] == 0
    assert {d["status"] for d in result["details"]} == {"仅搜索"}
    for track_id in scanned:
        path = client.get(f"/api/tracks/{track_id}").json()["path"]
        assert tagio.read_tags(path)["genre"] == "", "只搜索模式不能改文件"


def test_batch_scrape_applies_alias_and_threshold(client, scanned, monkeypatch):
    """批量写入要和单首写入等价：套用别名库、支持阈值。"""
    import json as _json

    from app import tagio

    client.put("/api/aliases/artist", json={"items": [{"from": "周杰伦", "to": "Jay Chou"}]})
    _fake_search(monkeypatch, {"source": "fake", "title": "稻香", "artist": "周杰伦", "genre": "流行", "score": 150, "confidence": "高"})
    job = client.post(
        "/api/scrape/batch",
        json={"ids": [scanned[0]], "fields": ["artist", "genre"], "auto_apply_min_score": 100},
    ).json()
    result = _json.loads(_wait_job(client, job["job_id"])["result"])
    assert result["applied"] == 1, result
    path = client.get(f"/api/tracks/{scanned[0]}").json()["path"]
    tags = tagio.read_tags(path)
    assert tags["artist"] == "Jay Chou", "别名库必须生效"
    assert tags["genre"] == "流行"


def test_batch_scrape_skips_below_threshold(client, scanned, monkeypatch):
    import json as _json

    from app import tagio

    _fake_search(monkeypatch, {"source": "fake", "title": "稻香", "genre": "流行", "score": 50, "confidence": "待确认"})
    job = client.post("/api/scrape/batch", json={"ids": [scanned[0]], "fields": ["genre"], "auto_apply_min_score": 100}).json()
    result = _json.loads(_wait_job(client, job["job_id"])["result"])
    assert result["applied"] == 0
    assert result["details"][0]["status"] == "低于阈值"
    path = client.get(f"/api/tracks/{scanned[0]}").json()["path"]
    assert tagio.read_tags(path)["genre"] == ""


def test_job_reports_full_progress_when_done(client, scanned):
    """任务完成后百分比必须是 100，不能停在节流后的旧值。"""
    job = client.post("/api/scan", json={"full": False}).json()
    result = _wait_job(client, job["job_id"])
    assert result["state"] == "done"
    assert result["percent"] == 100.0
    assert result["done"] == result["total"]


def test_settings_warns_on_bad_filename_template(client, clean_db):
    resp = client.put("/api/settings", json={"values": {"filename_template": "{nope} - {title}"}})
    assert resp.status_code == 200
    warnings = resp.json()["warnings"]
    assert any("文件名模板" in w and "nope" in w for w in warnings), warnings
