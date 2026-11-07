"""Album aggregation acceptance against real HTTP, PostgreSQL and FLAC files.

Run after the earlier library-count checks. Temporary tagged files are scanned
through the production scanner, then removed and pruned within their own scope.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac
from tests.cover_acceptance import image_bytes, replace_cover


def check_albums(base: str, music: Path, check, wait_job) -> None:
    prefix = "专辑聚合验收"
    root = music / "__album_acceptance__"
    fast_root = music / prefix / f"{prefix} 快速索引"
    # These paths are the only recursive cleanup targets; resolve before touching
    # them so a future refactor cannot turn cleanup into removal of the library.
    music_path = music.resolve()
    assert root.resolve().parent == music_path
    assert fast_root.resolve().parent.parent == music_path
    assert not root.exists() and not fast_root.exists(), "Album fixtures must use new directories"
    root.mkdir(parents=True)
    fast_root.mkdir(parents=True)

    shared = f"{prefix} 同名作品"
    compilation = f"{prefix} 合辑"
    complete = f"{prefix} 完整资料"
    blank_artist = f"{prefix} 未知艺术家"
    literal = f"{prefix} 100%_Mix!'"
    specs = [
        # Same title, different artists must stay separate.
        ("alpha", {"album": shared, "artist": "甲艺人", "date": "2004", "tracknumber": "1"}, False, False),
        ("beta", {"album": shared, "artist": "乙艺人", "date": "2005", "tracknumber": "1"}, False, False),
        # Different performers share an album artist; deliberately lexical-bad tracks.
        ("comp-ten", {"album": f"  {compilation}  ", "artist": "歌手十", "albumartist": "  Various Artists  ", "tracknumber": "10/12", "discnumber": "1/2", "date": "2020"}, True, True),
        ("comp-two", {"album": compilation, "artist": "歌手二", "albumartist": "Various Artists", "tracknumber": "2/12", "discnumber": "1/2", "date": "2020"}, True, False),
        ("comp-disc-two", {"album": compilation, "artist": "歌手一", "albumartist": "Various Artists", "tracknumber": "1", "discnumber": "2", "date": "2021"}, False, True),
        ("complete", {"album": complete, "artist": "完整艺人", "date": "2024", "discnumber": "1", "tracknumber": "1"}, True, True),
        ("unknown-artist", {"album": blank_artist, "artist": "   ", "albumartist": "   "}, False, False),
        ("unknown-album", {"album": "   ", "artist": prefix}, False, False),
        ("literal", {"album": literal, "artist": "安全参数艺人"}, False, False),
    ]
    with requests.Session() as client:
        def get(route: str, **params) -> dict:
            response = client.get(f"{base}{route}", params=params, timeout=30)
            response.raise_for_status()
            return response.json()

        def scan(scope: Path, *, fast: bool = False, prune: bool = False) -> dict:
            response = client.post(f"{base}/api/scan", json={
                "root": scope.relative_to(music).as_posix(), "full": True,
                "fast": fast, "prune": prune,
            }, timeout=30)
            response.raise_for_status()
            job = wait_job(response.json()["job_id"])
            if job["state"] != "done":
                raise RuntimeError(f"Album fixture scan failed: {job}")
            return job

        def group(album: str, artist: str, **params) -> dict:
            return get("/api/tracks", album_group=json.dumps([album, artist], ensure_ascii=False), page_size=100, **params)

        try:
            for index, (name, tags, cover, lyrics) in enumerate(specs, start=1):
                path = make_flac(root / f"{name}.flac")
                audio = FLAC(path)
                # STREAMINFO supplies a real nonzero duration without requiring
                # an encoder, so SUM(duration) cannot pass by returning zero.
                audio.info.total_samples = 44100 * (10 + index)
                for key, value in {"title": name, **tags}.items():
                    audio[key] = [value]
                if lyrics:
                    audio["lyrics"] = ["[00:00.00] 专辑验收歌词"]
                audio.save()
                if cover:
                    replace_cover(path, image_bytes("PNG", (16, 16)), "image/png", (16, 16))
            fast_file = fast_root / "01 - 未打开音频.flac"
            fast_file.write_bytes(b"not a playable audio file; fast scan must not open this")
            scan(root)
            scan(fast_root, fast=True)
            # Real scans trim tags; legacy index rows and an immediate editor
            # update can retain ASCII spaces. Preserve this fixture's existing
            # blank tag through the actual write API to exercise that state.
            blank_track = next(row for row in get("/api/tracks", q=root.name, page_size=100)["items"]
                               if row["title"] == "unknown-album")
            stats_before = get("/api/status")["stats"]
            write_blank = client.post(f"{base}/api/tracks/apply", json={
                "ids": [blank_track["id"]], "fields": {"album": "   "},
            }, timeout=30)
            write_blank.raise_for_status()
            stats_after = get("/api/status")["stats"]
            no_album = get("/api/tracks", q=root.name, no_album=1, page_size=100)
            check("纯空格专辑在索引中真实存在，未标注筛选和库统计口径一致",
                  write_blank.json()["written"] == 1 and not write_blank.json()["failed"]
                  and get(f"/api/tracks/{blank_track['id']}")["album"] == "   "
                  and FLAC(root / "unknown-album.flac").get("album") == ["   "]
                  and no_album["total"] == 1 and no_album["items"][0]["id"] == blank_track["id"]
                  and stats_after["no_album"] == stats_before["no_album"]
                  and stats_after["albums"] == stats_before["albums"])
            listing = get("/api/albums", q=prefix, page_size=100)
            items = listing["items"]
            by_key = {(row["album"], row["album_artist"]): row for row in items}
            check("专辑按标题和专辑艺术家分组，空标题不入组",
                  listing["total"] == 7 and len(items) == 7
                  and all(row["album"].strip() for row in items), str(list(by_key)))
            check("同名专辑的不同艺术家不混合",
                  by_key[(shared, "甲艺人")]["track_count"] == 1
                  and by_key[(shared, "乙艺人")]["track_count"] == 1)
            album = by_key[(compilation, "Various Artists")]
            comp_tracks = group(compilation, "Various Artists")["items"]
            covered_ids = [row["id"] for row in comp_tracks if row["has_cover"]]
            check("合辑歌手不同仍聚合，缺项与封面代表曲目正确",
                  album["track_count"] == 3 and album["disc_count"] == 2
                  and album["missing_cover"] == 1 and album["missing_lyrics"] == 1
                  and album["not_loaded"] == 0 and album["cover_track_id"] == min(covered_ids),
                  json.dumps(album, ensure_ascii=False))
            check("专辑总大小与总时长来自索引汇总，年份混合不误报",
                  album["bytes"] == sum(row["size"] for row in comp_tracks)
                  and abs(album["duration"] - 42.0) < .001
                  and abs(album["duration"] - sum(row["duration"] for row in comp_tracks)) < .001
                  and album["year"] == "" and album["indexed_at"] > 0
                  and by_key[(complete, "完整艺人")]["year"] == "2024")
            check("空艺术家与快速索引专辑可见，未伪造封面",
                  by_key[(blank_artist, "")]["track_count"] == 1
                  and by_key[(blank_artist, "")]["cover_track_id"] is None
                  and by_key[(f"{prefix} 快速索引", prefix)]["not_loaded"] == 1)

            incomplete = get("/api/albums", q=prefix, incomplete="1", page_size=100)
            incomplete_keys = {(row["album"], row["album_artist"]) for row in incomplete["items"]}
            check("待完善筛选排除完整专辑，保留所有含缺项的分组",
                  incomplete["total"] == 6 and (complete, "完整艺人") not in incomplete_keys
                  and (compilation, "Various Artists") in incomplete_keys)
            artist_search = get("/api/albums", q="Various Artists")
            check("专辑搜索匹配专辑艺术家且百分号下划线按字面处理",
                  artist_search["total"] == 1 and artist_search["items"][0]["album"] == compilation
                  and get("/api/albums", q=literal)["total"] == 1
                  and get("/api/albums", q=f"{prefix} 100%_Mix!")["total"] == 1
                  and get("/api/albums", q="' OR 1=1 --")["total"] == 0)

            pages = [get("/api/albums", q=prefix, page_size=2, page=page) for page in range(1, 5)]
            paged_keys = [(row["album"], row["album_artist"]) for page in pages for row in page["items"]]
            check("专辑稳定分页不重复、不漏项，超大页码安全夹到末页",
                  paged_keys == list(by_key) and len(set(paged_keys)) == 7
                  and get("/api/albums", q=prefix, page_size=2, page=9223372036854775807)["page"] == 4
                  and get("/api/albums", q=prefix, page=-5)["page"] == 1)
            empty = get("/api/albums", q="肯定不存在的专辑_937fa0", page=99)
            check("专辑空结果保持有效页码与零总数",
                  empty["total"] == 0 and empty["pages"] == 0 and empty["page"] == 1 and empty["items"] == [])
            fallback = get("/api/albums", q=prefix, sort="album; DROP TABLE tracks;--", page_size=100)
            check("专辑排序使用白名单，恶意排序不影响查询",
                  fallback["items"] == items and get("/api/albums", q=prefix, sort="artist")["total"] == 7
                  and get("/api/albums", q=prefix, sort="recent")["total"] == 7)
            invalid = [
                {"page_size": 0}, {"page_size": 101}, {"page_size": "NaN"},
                {"page": "9223372036854775808"}, {"incomplete": "maybe"},
            ]
            check("专辑分页与布尔参数错误返回可读422",
                  all(client.get(f"{base}/api/albums", params=params, timeout=20).status_code == 422 for params in invalid))

            normalized = group(f" {compilation} ", " Various Artists ")
            missing = group(compilation, "Various Artists", missing_cover=1)
            ordered = group(compilation, "Various Artists", sort="disc_track")["items"]
            reversed_tracks = group(compilation, "Various Artists", sort="disc_track", order="desc")["items"]
            check("专辑精确钻取包括合辑全员且可叠加缺封面筛选",
                  normalized["total"] == 3 and missing["total"] == 1
                  and missing["items"][0]["title"] == "comp-disc-two"
                  and group(blank_artist, "")["total"] == 1
                  and group(shared, "甲艺人")["total"] == 1)
            check("专辑曲序按碟号与数字音轨排序，避免1/10/2错序",
                  [row["title"] for row in ordered] == ["comp-two", "comp-ten", "comp-disc-two"]
                  and [row["title"] for row in reversed_tracks] == ["comp-disc-two", "comp-ten", "comp-two"])
            bad_groups = ["", "null", "{}", "[]", '["A"]', '["A",1]', '["A","B","C"]', '[" ",""]', json.dumps(["x" * 4001, ""]) ]
            check("专辑分组参数拒绝错误形状与超长输入",
                  all(client.get(f"{base}/api/tracks", params={"album_group": value}, timeout=20).status_code == 422 for value in bad_groups))
            check("专辑分组值绑定为数据，不执行SQL或跨组返回",
                  group("' OR 1=1 --", "")["total"] == 0 and group(literal, "安全参数艺人")["total"] == 1)

            # Temporarily move a source away without refreshing the index. Album
            # browsing still succeeds from PostgreSQL; it must not read the file.
            original = root / "comp-ten.flac"
            moved = root / "comp-ten.offline"
            before_hash = hashlib.sha256(original.read_bytes()).digest()
            original.rename(moved)
            try:
                offline = get("/api/albums", q=compilation)["items"][0]
                check("专辑浏览只查索引，原文件离线不触发读取或写入",
                      offline == album and group(compilation, "Various Artists")["total"] == 3
                      and hashlib.sha256(moved.read_bytes()).digest() == before_hash)
            finally:
                moved.rename(original)
        finally:
            for scope in (root, fast_root):
                assert scope.resolve() not in {music_path, music_path.parent}
                assert scope.resolve().is_relative_to(music_path)
                if scope.exists():
                    for entry in scope.iterdir():
                        if entry.is_file():
                            entry.unlink()
                    # Keep scope present for safe subtree pruning; remove it only
                    # after the scanner has removed its stale index records.
                    scan(scope, prune=True)
                    shutil.rmtree(scope)
            if fast_root.parent.exists() and not any(fast_root.parent.iterdir()):
                fast_root.parent.rmdir()
