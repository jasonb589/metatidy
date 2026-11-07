"""Real HTTP write/preview consistency checks with isolated FLAC files and covers.

The backend owns planning and writing; this module compares its responses with
independent mutagen reads, byte hashes, mtimes and a local HTTP cover source.
"""
from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac
from tests.cover_acceptance import image_bytes, replace_cover


def check_writes(base: str, music: Path, check, wait_job) -> None:
    root = music / "__write_acceptance__"
    music_path = music.resolve()
    assert root.resolve().parent == music_path and not root.exists()
    root.mkdir()
    original_cover = image_bytes("PNG", (24, 16))
    replacement_cover = image_bytes("PNG", (24, 16), alternate=True)
    original_lyrics = "[00:01.00] 原有歌词"
    custom = ["保留自定义标签", "second custom value"]
    image_requests: list[str] = []

    class Covers(BaseHTTPRequestHandler):
        def do_GET(self):
            image_requests.append(self.path)
            if self.path == "/replacement.png":
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(replacement_cover)))
                self.end_headers()
                self.wfile.write(replacement_cover)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *_args):
            pass

    cover_server = ThreadingHTTPServer(("127.0.0.1", 0), Covers)
    cover_thread = threading.Thread(target=cover_server.serve_forever, daemon=True)
    cover_thread.start()
    cover_url = f"http://127.0.0.1:{cover_server.server_port}/replacement.png"

    def fingerprint(path: Path):
        return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns

    def skipped(data: dict):
        return {(item["field"], item["reason"]) for item in data.get("skipped", [])}

    def describe(data: dict):
        return json.dumps(data, ensure_ascii=False)[:1600]

    with requests.Session() as client:
        def get(route: str, **params):
            response = client.get(f"{base}{route}", params=params, timeout=30)
            response.raise_for_status()
            return response.json()

        def post(route: str, payload: dict):
            response = client.post(f"{base}{route}", json=payload, timeout=30)
            response.raise_for_status()
            return response.json()

        def scan(*, prune=False):
            data = post("/api/scan", {"root": root.name, "full": True, "prune": prune})
            result = wait_job(data["job_id"])
            if result["state"] != "done":
                raise RuntimeError(f"Write acceptance scan failed: {result}")

        try:
            files = {}
            for name in ("existing", "empty", "missing", "broken"):
                path = make_flac(root / f"{name}.flac")
                audio = FLAC(path)
                audio["title"] = [f"写入验收 {name}"]
                audio["x-metatidy-preserve"] = custom
                if name == "existing":
                    audio["artist"] = ["写入验收原歌手"]
                    audio["album"] = ["写入验收原专辑"]
                    audio["date"] = ["2001"]
                    audio["tracknumber"] = ["3"]
                    audio["discnumber"] = ["1"]
                    audio["lyrics"] = [original_lyrics]
                audio.save()
                files[name] = path
            replace_cover(files["existing"], original_cover, "image/png", (24, 16))
            scan()
            rows = get("/api/tracks", q=root.name, page_size=100)["items"]
            by_name = {Path(row["path"]).stem: row for row in rows}
            assert len(by_name) == 4, describe({"tracks": rows})
            current = by_name["existing"]
            track_id = current["id"]
            path = files["existing"]
            detail = lambda: get(f"/api/tracks/{track_id}")
            request = {"ids": [track_id], "overwrite": False, "normalize_artist": False,
                       "fields": {"title": "不能覆盖原标题", "genre": "  Ambient  "}}
            before = fingerprint(path)
            preview = post("/api/tracks/preview", request)
            item = preview["items"][0]
            check("不覆盖预览仅列出空字段补全，并标明已有字段跳过",
                  preview["changed_fields"] == 1 and set(item["changes"]) == {"genre"}
                  and item["effective_fields"] == {"genre": "Ambient"}
                  and ("title", "existing") in skipped(item), describe(item))
            check("写入差异预览不改变真实FLAC字节或修改时间", fingerprint(path) == before)
            applied = post("/api/tracks/apply", request)
            audio = FLAC(path)
            check("不覆盖写入数量和字段来自实际改动，磁盘与索引一致",
                  applied["written"] == 1 and applied.get("skipped") == 0 and applied["failed"] == []
                  and applied["fields"] == ["genre"] and applied["items"][0]["written"] == ["genre"]
                  and applied["items"][0]["file_changed"] is True
                  and audio["title"] == [current["title"]] and audio["genre"] == ["Ambient"]
                  and detail()["title"] == current["title"] and detail()["genre"] == "Ambient", describe(applied))
            check("字段写入保留未请求的自定义标签、封面和歌词",
                  audio["x-metatidy-preserve"] == custom and audio.pictures[0].data == original_cover
                  and audio["lyrics"] == [original_lyrics] and audio["artist"] == ["写入验收原歌手"])

            no_op = {"ids": [track_id], "fields": {"title": current["title"], "genre": "Ambient"}, "overwrite": True}
            before = fingerprint(path)
            preview = post("/api/tracks/preview", no_op)
            applied = post("/api/tracks/apply", no_op)
            check("相同内容预览与写入均为零改动，并保持哈希和mtime",
                  preview["changed_fields"] == 0 and preview["items"][0]["effective_fields"] == {}
                  and applied["written"] == 0 and applied["skipped"] == 1 and applied["fields"] == []
                  and applied["items"][0]["file_changed"] is False
                  and ("title", "unchanged") in skipped(applied["items"][0])
                  and fingerprint(path) == before, describe(applied))

            invalid = {"ids": [track_id], "overwrite": True, "fields": {
                "album": "   ", "track": "side A", "disc": "4294967296", "year": "not-year", "unknown_field": "不可写入"}}
            before = fingerprint(path)
            preview = post("/api/tracks/preview", invalid)
            applied = post("/api/tracks/apply", invalid)
            reasons = {("album", "blank"), ("track", "invalid"), ("disc", "invalid"), ("year", "invalid"), ("unknown_field", "unsupported")}
            check("空白、非法数字和不支持字段在预览与写入中均明确跳过",
                  preview["changed_fields"] == 0 and preview["items"][0]["effective_fields"] == {}
                  and reasons <= skipped(preview["items"][0]) and reasons <= skipped(applied["items"][0])
                  and applied["written"] == 0 and applied["skipped"] == 1
                  and fingerprint(path) == before and detail()["track"] == "3" and detail()["disc"] == "1"
                  and detail()["year"] == "2001" and detail()["album"] == "写入验收原专辑", describe(applied))

            canonical = {"ids": [by_name["empty"]["id"]], "overwrite": True,
                         "fields": {"track": "003", "disc": "02", "year": "2004-11-01", "genre": "  Folk  "}}
            preview = post("/api/tracks/preview", canonical)
            expected = {"track": "3", "disc": "2", "year": "2004", "genre": "Folk"}
            applied = post("/api/tracks/apply", canonical)
            readback = get(f"/api/tracks/{by_name['empty']['id']}")
            audio = FLAC(files["empty"])
            check("数字与年份规范值在预览、磁盘及索引三处一致",
                  preview["items"][0]["effective_fields"] == expected
                  and {field: readback[field] for field in expected} == expected
                  and audio["tracknumber"] == ["3"] and audio["discnumber"] == ["2"]
                  and (audio.get("date") or audio.get("year")) == ["2004"] and audio["genre"] == ["Folk"]
                  and set(applied["fields"]) == set(expected), describe({"applied": applied, "raw_tags": dict(audio)}))

            indexed_before_external = detail()
            audio = FLAC(path)
            audio["title"] = ["外部软件已修改的标题"]
            audio["artist"] = ["未请求同步的磁盘歌手"]
            audio.save()
            before = fingerprint(path)
            applied = post("/api/tracks/apply", {"ids": [track_id], "overwrite": False, "fields": {"title": "不得写入索引的请求值"}})
            check("跳过覆盖后索引同步请求字段的磁盘现值，不保存未写入的请求值",
                  applied["written"] == 0 and applied["skipped"] == 1 and fingerprint(path) == before
                  and detail()["title"] == "外部软件已修改的标题"
                  and detail()["artist"] == "写入验收原歌手"
                  and detail()["mtime"] == indexed_before_external["mtime"]
                  and detail()["size"] == indexed_before_external["size"]
                  and detail()["edited_at"] == indexed_before_external["edited_at"]
                  and FLAC(path)["artist"] == ["未请求同步的磁盘歌手"], describe(applied))

            edited_lyrics = "[00:01.00] 编辑入口显式替换歌词\n[00:02.00] 第二行"
            lyric_request = {"ids": [track_id], "overwrite": False, "fields": {"lyrics": edited_lyrics}}
            preview = post("/api/tracks/preview", lyric_request)
            applied = post("/api/tracks/apply", lyric_request)
            check("编辑入口歌词是显式替换，不受不覆盖文本开关影响",
                  "lyrics" in preview["items"][0]["changes"] and applied["written"] == 1
                  and applied["fields"] == ["lyrics"] and applied["items"][0]["lyrics"] is True
                  and FLAC(path)["lyrics"] == [edited_lyrics]
                  and get(f"/api/tracks/{track_id}/lyrics")["lyrics"] == edited_lyrics, describe(applied))

            scrape_lyrics = "[00:01.00] 候选歌词显式替换"
            scrape_request = {"track_id": track_id, "candidate": {"lyrics": scrape_lyrics}, "fields": [],
                              "write_cover": False, "write_lyrics": True, "overwrite": False}
            applied = post("/api/scrape/apply", scrape_request)
            check("刮削入口歌词显式替换，响应说明实际歌词改动",
                  applied["lyrics"] is True and applied["cover"] is False and applied["file_changed"] is True
                  and FLAC(path)["lyrics"] == [scrape_lyrics] and detail()["has_lyrics"] in (True, 1), describe(applied))
            before = fingerprint(path)
            repeated = post("/api/scrape/apply", scrape_request)
            check("重复相同歌词不重写文件，实际歌词写入标记为false",
                  repeated["lyrics"] is False and repeated["file_changed"] is False
                  and fingerprint(path) == before, describe(repeated))

            scrape_request = {"track_id": track_id, "candidate": {"title": "不应覆盖", "genre": "Jazz", "track": "oops"},
                              "fields": ["title", "genre", "track"], "write_cover": False, "write_lyrics": False, "overwrite": False}
            before = fingerprint(path)
            applied = post("/api/scrape/apply", scrape_request)
            check("刮削不覆盖和非法数字不虚报written或把候选写进索引",
                  applied["written"] == [] and applied["file_changed"] is False and applied["changes"] == {}
                  and {("title", "existing"), ("genre", "existing"), ("track", "invalid")} <= skipped(applied)
                  and detail()["title"] == "外部软件已修改的标题" and detail()["genre"] == "Ambient"
                  and fingerprint(path) == before, describe(applied))
            applied = post("/api/scrape/apply", {**scrape_request, "overwrite": True,
                           "candidate": {"title": "候选真实新标题", "genre": "Ambient", "track": "003"}})
            check("刮削written只包含真实变化字段，规范化相同值不计入",
                  applied["written"] == ["title"] and set(applied["changes"]) == {"title"}
                  and applied["file_changed"] is True and FLAC(path)["title"] == ["候选真实新标题"]
                  and detail()["title"] == "候选真实新标题", describe(applied))

            cover_request = {"track_id": track_id, "candidate": {"cover": cover_url}, "fields": [],
                             "write_cover": True, "write_lyrics": False, "overwrite": False}
            before = fingerprint(path)
            applied = post("/api/scrape/apply", cover_request)
            check("已有封面且禁止覆盖时不下载或改写，cover标记为false",
                  applied["cover"] is False and applied["file_changed"] is False
                  and FLAC(path).pictures[0].data == original_cover and fingerprint(path) == before
                  and image_requests == [], describe(applied))
            applied = post("/api/scrape/apply", {**cover_request, "overwrite": True})
            check("允许覆盖时封面实际替换且索引与响应一致",
                  applied["cover"] is True and applied["file_changed"] is True and len(FLAC(path).pictures) == 1
                  and FLAC(path).pictures[0].data == replacement_cover and detail()["has_cover"] in (True, 1)
                  and "/replacement.png" in image_requests, describe(applied))
            before = fingerprint(path)
            applied = post("/api/scrape/apply", {**cover_request, "overwrite": True})
            check("相同封面不会再次重写音频，cover不虚报改动",
                  applied["cover"] is False and applied["file_changed"] is False and fingerprint(path) == before, describe(applied))
            empty_id = by_name["empty"]["id"]
            applied = post("/api/scrape/apply", {**cover_request, "track_id": empty_id})
            check("无封面曲目在禁止覆盖模式下仍可补上真实封面",
                  applied["cover"] is True and applied["file_changed"] is True
                  and FLAC(files["empty"]).pictures[0].data == replacement_cover
                  and get(f"/api/tracks/{empty_id}")["has_cover"] in (True, 1), describe(applied))
            before = fingerprint(path)
            applied = post("/api/scrape/apply", {**cover_request, "overwrite": True,
                           "candidate": {"cover": cover_url.replace("replacement.png", "missing.png")}})
            check("封面下载失败明确跳过，保留原封面且不重写音频",
                  applied["cover"] is False and applied["file_changed"] is False
                  and ("cover", "unavailable") in skipped(applied) and fingerprint(path) == before, describe(applied))
            check("全部写入路径仍保留自定义标签与未请求的磁盘歌手",
                  FLAC(path)["x-metatidy-preserve"] == custom
                  and FLAC(files["empty"])["x-metatidy-preserve"] == custom
                  and FLAC(path)["artist"] == ["未请求同步的磁盘歌手"])

            missing_path, broken_path = files["missing"], files["broken"]
            missing_bytes = missing_path.read_bytes()
            broken_bytes = broken_path.read_bytes()
            missing_path.unlink()
            broken_path.write_bytes(b"invalid FLAC bytes for write failure acceptance")
            try:
                invalid_ids = [by_name["missing"]["id"], by_name["broken"]["id"]]
                preview = post("/api/tracks/preview", {"ids": invalid_ids, "fields": {"title": "不可写入"}})
                check("缺失文件或损坏标签的预览不虚构有效字段",
                      len(preview["items"]) == 2
                      and all(not item.get("effective_fields") and not item.get("changes") for item in preview["items"])
                      and any(item.get("file_exists") is False for item in preview["items"])
                      and any(item.get("current", {}).get("error") for item in preview["items"]), describe(preview))
                applied = post("/api/tracks/apply", {"ids": invalid_ids + [9223372036854775807], "fields": {"title": "不可写入"}})
                check("缺文件、坏文件和不存在曲目列入failed，不计为写入或无变化",
                      applied["written"] == 0 and applied["skipped"] == 0 and len(applied["failed"]) == 3
                      and applied["fields"] == [] and broken_path.read_bytes().startswith(b"invalid FLAC")
                      and get(f"/api/tracks/{invalid_ids[0]}")["title"] == by_name["missing"]["title"], describe(applied))
                response = client.post(f"{base}/api/scrape/apply", json={"track_id": invalid_ids[1], "fields": ["title"],
                    "candidate": {"title": "坏文件不允许写入"}, "write_cover": False, "write_lyrics": False}, timeout=30)
                check("刮削遇到坏文件返回可读错误且不修改索引",
                      response.status_code >= 400 and bool(response.json().get("detail"))
                      and get(f"/api/tracks/{invalid_ids[1]}")["title"] == by_name["broken"]["title"], response.text[:300])
            finally:
                missing_path.write_bytes(missing_bytes)
                broken_path.write_bytes(broken_bytes)
        finally:
            cover_server.shutdown()
            cover_server.server_close()
            cover_thread.join(timeout=5)
            assert root.resolve().parent == music_path and root.resolve() != music_path
            for entry in root.iterdir():
                assert entry.parent == root and entry.is_file(), f"Unexpected write fixture entry: {entry}"
                entry.unlink()
            scan(prune=True)
            root.rmdir()
