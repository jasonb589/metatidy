"""Real HTTP/Postgres portrait acceptance with a strictly local Navidrome.

The upstream only implements the official native/Subsonic contracts. Cached
Last.fm artifacts are fixture UUIDs; a persisted cooldown plus a deny-all HTTP
proxy prevents accidental external requests if a cache assertion regresses.
Only rows and files belonging to this invocation are removed.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit

import requests
from PIL import Image

from tests.jobs_acceptance import _postgres


def _picture(kind: str, color=(45, 108, 178)) -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (32, 24), color).save(stream, format=kind)
    return stream.getvalue()


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _cache_key(artist: str) -> str:
    value = json.dumps([artist, None], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()


class _Navidrome:
    """A real listening server, including a base path and duplicate names."""

    username = "portrait-fixture-user"
    password = "portrait-fixture-password"
    jwt = "portrait-fixture-jwt"
    sonic_token = "portrait-fixture-subsonic-token"
    sonic_salt = "portrait-fixture-salt"

    def __init__(self):
        self.lock = threading.Lock()
        self.login_count = 0
        self.read_count = 0
        self.external_attempts = 0
        self.queries: list[dict] = []
        self.uploads: list[dict] = []
        self.errors: list[str] = []
        self.response_code = 200
        self.hold_upload = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.current_png = _picture("PNG", (180, 85, 44))
        self.artists = {
            artist_id: {
                "id": artist_id,
                "name": "同名歌手 / Fixture",
                "albumCount": index + 1,
                "songCount": (index + 1) * 5,
                "mbzArtistId": f"00000000-0000-0000-0000-{index + 1:012d}",
                "uploadedImage": "",
                "updatedAt": "2026-11-08T00:00:00Z",
                "imageHash": "0123456789abcdef",
            }
            for index, artist_id in enumerate(("artist-a", "artist-b"))
        }
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, status: int, content, headers=None):
                if isinstance(content, (dict, list)):
                    content = json.dumps(content, ensure_ascii=False).encode()
                    mime = "application/json"
                elif isinstance(content, str):
                    content = content.encode()
                    mime = "text/plain"
                else:
                    mime = "application/octet-stream"
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Connection", "close")
                for key, value in (headers or {}).items():
                    self.send_header(key, str(value))
                self.end_headers()
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def reject_external(self) -> bool:
                if self.command == "CONNECT" or self.path.startswith(("http://", "https://")):
                    with fixture.lock:
                        fixture.external_attempts += 1
                    self.send(502, "External network disabled in portrait acceptance")
                    return True
                return False

            def native_auth(self) -> bool:
                valid = self.headers.get("X-ND-Authorization") == f"Bearer {fixture.jwt}"
                if not valid:
                    self.send(401, "native authorization required")
                elif self.headers.get("Authorization"):
                    fixture.errors.append("Unexpected standard Authorization header")
                return valid

            def sonic_auth(self, query) -> bool:
                valid = all(query.get(key) == [value] for key, value in {
                    "u": fixture.username, "t": fixture.sonic_token,
                    "s": fixture.sonic_salt, "c": "MetaTidy", "f": "json",
                }.items())
                if not valid:
                    self.send(200, {"subsonic-response": {"status": "failed", "error": {"code": 40}}})
                return valid

            def do_CONNECT(self):
                self.reject_external()

            def do_GET(self):
                if self.reject_external():
                    return
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                if parsed.path.startswith("/nd/api/"):
                    if not self.native_auth():
                        return
                    with fixture.lock:
                        fixture.read_count += 1
                    if parsed.path == "/nd/api/artist":
                        with fixture.lock:
                            fixture.queries.append(query)
                            candidates = [dict(row) for row in fixture.artists.values()]
                        term = query.get("name", [""])[0]
                        candidates = [row for row in candidates if term.casefold() in row["name"].casefold()]
                        start = int(query.get("_start", ["0"])[0])
                        end = int(query.get("_end", [str(len(candidates))])[0])
                        self.send(200, candidates[start:end], {"X-Total-Count": len(candidates)})
                        return
                    artist_id = parsed.path.removeprefix("/nd/api/artist/")
                    with fixture.lock:
                        row = fixture.artists.get(artist_id)
                        row = dict(row) if row else None
                    self.send(200 if row else 404, row or {"error": "artist not found"})
                    return
                if parsed.path == "/nd/rest/ping" and self.sonic_auth(query):
                    self.send(200, {"subsonic-response": {
                        "status": "ok", "type": "navidrome", "serverVersion": "0.64.2",
                    }})
                    return
                if parsed.path == "/nd/rest/getCoverArt" and self.sonic_auth(query):
                    if not query.get("id", [""])[0].startswith(("ar-artist-a", "ar-artist-b")):
                        fixture.errors.append("Artwork request did not use an artist cover ID")
                    self.send(200, fixture.current_png)
                    return
                self.send(404, {"error": "unknown mock route"})

            def do_POST(self):
                if self.reject_external():
                    return
                parsed = urlsplit(self.path)
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                if parsed.path == "/nd/auth/login":
                    try:
                        credentials = json.loads(body)
                    except ValueError:
                        self.send(400, "invalid JSON login")
                        return
                    if credentials != {"username": fixture.username, "password": fixture.password}:
                        fixture.errors.append("Wrong native login JSON")
                        self.send(401, "wrong credentials")
                        return
                    with fixture.lock:
                        fixture.login_count += 1
                    self.send(200, {"token": fixture.jwt, "username": fixture.username, "isAdmin": False,
                                    "subsonicToken": fixture.sonic_token, "subsonicSalt": fixture.sonic_salt})
                    return
                if not self.native_auth():
                    return
                parts = parsed.path.strip("/").split("/")
                if len(parts) != 5 or parts[:3] != ["nd", "api", "artist"] or parts[4] != "image":
                    self.send(404, "unknown upload route")
                    return
                content_type = self.headers.get("Content-Type", "")
                message = BytesParser(policy=policy.default).parsebytes(
                    b"MIME-Version: 1.0\r\nContent-Type: " + content_type.encode() + b"\r\n\r\n" + body)
                images = [part for part in message.iter_parts()
                          if part.get_param("name", header="content-disposition") == "image"]
                if len(images) != 1:
                    fixture.errors.append("Multipart upload must contain exactly one image field")
                    self.send(400, "missing image")
                    return
                part = images[0]
                uploaded = part.get_payload(decode=True)
                try:
                    decoded = Image.open(io.BytesIO(uploaded))
                    decoded.load()
                    valid = decoded.format == "JPEG" and part.get_filename() == "portrait.jpg"
                except (OSError, ValueError):
                    valid = False
                if not valid:
                    fixture.errors.append("Upload was not a decodable JPEG named portrait.jpg")
                    self.send(400, "invalid image")
                    return
                with fixture.lock:
                    fixture.uploads.append({"id": parts[3], "bytes": uploaded})
                    hold, code = fixture.hold_upload, fixture.response_code
                    sequence = len(fixture.uploads)
                fixture.entered.set()
                if hold and not fixture.release.wait(15):
                    fixture.errors.append("Test failed to release held upload")
                if code != 200:
                    self.send(code, fixture.password + " " + fixture.jwt + " " + fixture.sonic_token)
                    return
                with fixture.lock:
                    row = fixture.artists[parts[3]]
                    row["uploadedImage"] = f"{parts[3]}_portrait.jpeg"
                    row["updatedAt"] = f"2026-11-08T00:{sequence:02}:00Z"
                # This endpoint in Navidrome does not explicitly set JSON MIME.
                self.send(200, '{"status":"ok"}')

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def count(self) -> int:
        with self.lock:
            return len(self.uploads)

    def hold(self):
        with self.lock:
            self.hold_upload = True
        self.entered.clear()
        self.release.clear()

    def unhold(self):
        with self.lock:
            self.hold_upload = False
        self.release.set()

    def close(self):
        self.unhold()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def check_portraits(
    repo: Path,
    work: Path,
    music: Path,
    argv: list[str],
    env: dict[str, str],
    port: int,
    check: Callable[[str, bool, str], None],
) -> None:
    """Use the caller's fixture DB/music and a separate, supplied service port.

    Requires requests, Pillow with AVIF support, psql and DATABASE_URL. No live
    Last.fm or Navidrome credentials are read or used. The caller must ensure no
    other fixture instance is starting/stopping an upload during this check.
    """
    if env.get("DATABASE_URL") != os.environ.get("DATABASE_URL") or not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Portrait fixtures require the caller and psql to use the same DATABASE_URL")
    nonce = uuid.uuid4().hex
    portrait_id, damaged_id = str(uuid.uuid4()), str(uuid.uuid4())
    artist = f"PortraitFixture-{nonce}"
    missing_artist = f"PortraitMissing-{nonce}"
    positive_key, negative_key = _cache_key(artist), _cache_key(missing_artist)
    data = work / "portrait-data" / nonce
    artifact_dir = data / "artist-portraits"
    artifact_dir.mkdir(parents=True)
    jpeg, avif = _picture("JPEG"), _picture("AVIF")
    for identifier in (portrait_id, damaged_id):
        (artifact_dir / f"{identifier}.jpg").write_bytes(jpeg)
        (artifact_dir / f"{identifier}.avif").write_bytes(avif)
    gate = data / "lastfm-portraits" / "gate.json"
    gate.parent.mkdir()
    gate.write_text(json.dumps({"version": 1, "next_request_at_ms": 0,
                               "cooldown_until_ms": int((time.time() + 3600) * 1000),
                               "consecutive_failures": 0, "reason": "Acceptance disables external requests"}),
                    encoding="utf-8")
    upstream = _Navidrome()
    base = f"http://127.0.0.1:{port}"
    private_password = f"portrait-auth-{nonce}"
    run_env = {
        **env, "METATIDY_PORT": str(port), "METATIDY_HOST": "127.0.0.1",
        "METATIDY_DATA_DIR": str(data), "METATIDY_MUSIC_DIR": str(music),
        "METATIDY_LIBRARY_ROOT": str(music), "METATIDY_AUTO_SCAN": "0",
        "METATIDY_PASSWORD": "", "METATIDY_AUTH_PASSWORD": "", "METATIDY_COOKIE_SECURE": "0",
        "METATIDY_NAVIDROME_URL": upstream.base + "/nd/",
        "METATIDY_NAVIDROME_USERNAME": upstream.username,
        "METATIDY_NAVIDROME_PASSWORD": upstream.password,
        "HTTP_PROXY": upstream.base, "HTTPS_PROXY": upstream.base, "ALL_PROXY": upstream.base,
        "http_proxy": upstream.base, "https_proxy": upstream.base, "all_proxy": upstream.base,
        "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1",
    }
    baseline_audio = {path: hashlib.sha256(path.read_bytes()).digest() for path in music.rglob("*.flac")}
    session = requests.Session()
    session.trust_env = False
    server = None
    logfile = (work / f"portraits-{nonce}.log").open("wb")
    public_results: list[str] = []
    ids_sql = ",".join(f"'{identifier}'::uuid" for identifier in (portrait_id, damaged_id))
    keys_sql = ",".join(_literal(key) for key in (positive_key, negative_key))

    def launch():
        process = subprocess.Popen(argv, cwd=repo, env=run_env, stdout=logfile, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Portrait fixture server exited with {process.returncode}")
            try:
                if session.get(base + "/api/health", timeout=2).status_code == 200:
                    return process
            except requests.RequestException:
                pass
            time.sleep(.15)
        process.terminate()
        process.wait(timeout=10)
        raise TimeoutError("Portrait fixture server did not start")

    def stop(process):
        if process:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    def request(method, route, **kwargs):
        response = session.request(method, base + route, timeout=30, **kwargs)
        if "image/" not in response.headers.get("content-type", ""):
            public_results.append(response.text)
        return response

    def preview(identifier=portrait_id, target="artist-b"):
        response = request("POST", "/api/artist-portraits/sync-preview",
                           json={"portrait_id": identifier, "artist_id": target})
        response.raise_for_status()
        return response.json()

    def submit(token):
        return request("POST", "/api/artist-portraits/sync", json={"token": token})

    def settled(token):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            response = request("GET", f"/api/artist-portraits/sync/{token}")
            response.raise_for_status()
            item = response.json()
            if item["state"] not in ("ready", "uploading"):
                return item
            time.sleep(.05)
        raise TimeoutError("Portrait upload did not settle")

    try:
        server = launch()
        tracks_response = request("GET", "/api/tracks", params={"page_size": 100})
        tracks_response.raise_for_status()
        indexed_artist = next((row.get("artist", "").strip() for row in tracks_response.json()["items"]
                               if row.get("artist", "").strip()), "")
        expected_artists = int(_postgres("SELECT count(DISTINCT BTRIM(artist)) FROM tracks WHERE BTRIM(artist)<>'';"))
        artist_pages = [request("GET", "/api/artists", params={"page": page, "page_size": 2}) for page in (1, 2)]
        matched_artist = request("GET", "/api/artists", params={"q": indexed_artist, "page_size": 100})
        for response in [*artist_pages, matched_artist]:
            response.raise_for_status()
        first_artists, next_artists = [response.json() for response in artist_pages]
        expected_pages = (expected_artists + 1) // 2
        expected_next_page = min(2, max(1, expected_pages))
        check("本地歌手 SQL 查询按实际索引分组并稳定分页，已有歌手可搜索",
              bool(indexed_artist) and first_artists["total"] == next_artists["total"] == expected_artists
              and first_artists["pages"] == next_artists["pages"] == expected_pages
              and len(first_artists["items"]) == min(2, expected_artists)
              and next_artists["page"] == expected_next_page
              and len(next_artists["items"]) == min(2, max(0, expected_artists - (expected_next_page - 1) * 2))
              and (expected_next_page == 1 or not ({item["name"] for item in first_artists["items"]}
                                                 & {item["name"] for item in next_artists["items"]}))
              and indexed_artist in {item["name"] for item in matched_artist.json()["items"]})
        literal_results = []
        for symbol in ("%", "_"):
            expected = int(_postgres(f"SELECT count(DISTINCT BTRIM(artist)) FROM tracks WHERE strpos(BTRIM(artist),{_literal(symbol)})>0;"))
            response = request("GET", "/api/artists", params={"q": symbol, "page_size": 100})
            response.raise_for_status()
            result = response.json()
            literal_results.append(result["total"] == expected and len(result["items"]) == min(100, expected)
                                   and all(symbol in item["name"] for item in result["items"]))
        check("本地歌手搜索把百分号和下划线作为字面字符", all(literal_results))

        # Fixture metadata exercises the additional Last.fm image CDN; no CDN request is made.
        source_image = "https://lastfm-img.freetls.fastly.net/i/u/300x300/11111111111111111111111111111111.jpg"
        rows = [{"id": identifier, "artist": artist, "source_page": "https://www.last.fm/music/Fixture",
                 "source_image": source_image,
                 "jpeg_digest": hashlib.sha256(jpeg).hexdigest(), "preview_digest": hashlib.sha256(avif).hexdigest(),
                 "width": 32, "height": 24} for identifier in (portrait_id, damaged_id)]
        document = _literal(json.dumps(rows, ensure_ascii=False))
        _postgres(f"""INSERT INTO artist_portraits(id,artist,source_page,source_image,jpeg_digest,preview_digest,width,height)
            SELECT id,artist,source_page,source_image,jpeg_digest,preview_digest,width,height
            FROM jsonb_to_recordset({document}::jsonb) AS item(id uuid,artist text,source_page text,source_image text,
                jpeg_digest text,preview_digest text,width integer,height integer);
            INSERT INTO artist_portrait_fetches(cache_key,portrait_id,expires_at)
                VALUES({_literal(positive_key)},'{portrait_id}'::uuid,now()+interval '1 day');
            INSERT INTO artist_portrait_fetches(cache_key,failure,expires_at)
                VALUES({_literal(negative_key)},'{{"code":"image_not_found","message":"Fixture has no image"}}'::jsonb,now()+interval '1 day');""")

        fetches = [request("POST", "/api/artist-portraits/fetch", json={"artist": artist}) for _ in range(2)]
        check("歌手头像缓存命中不访问 Last.fm 或 Navidrome",
              all(response.status_code == 200 and response.json().get("cached") is True
                  and response.json()["portrait"]["id"] == portrait_id
                  and response.json()["portrait"]["source_image"] == source_image for response in fetches)
              and upstream.external_attempts == 0 and upstream.login_count == 0, "same cached UUID twice")
        missing = request("POST", "/api/artist-portraits/fetch", json={"artist": missing_artist})
        check("歌手头像负缓存保留明确失败且不再次联网",
              missing.status_code == 404 and missing.json().get("cached") is True
              and missing.json().get("code") == "image_not_found" and upstream.external_attempts == 0)
        _postgres(f"""UPDATE artist_portrait_fetches
            SET failure='{{"code":"upstream_image_unsupported","message":"Fixture upstream image format is unsupported"}}'::jsonb
            WHERE cache_key={_literal(negative_key)};""")
        unsupported = [request("POST", "/api/artist-portraits/fetch", json={"artist": missing_artist}) for _ in range(2)]
        check("上游图片格式不支持的负缓存保留 502，重复获取不再次联网",
              all(response.status_code == 502 and response.json().get("cached") is True
                  and response.json().get("code") == "upstream_image_unsupported" for response in unsupported)
              and upstream.external_attempts == 0 and upstream.login_count == 0)
        image = request("GET", f"/api/artist-portraits/{portrait_id}/preview")
        decoded = Image.open(io.BytesIO(image.content))
        decoded.load()
        check("歌手头像预览是真实 AVIF 并使用私有缓存策略",
              image.status_code == 200 and image.headers.get("content-type") == "image/avif"
              and decoded.format == "AVIF" and decoded.size == (32, 24)
              and "no-store" in image.headers.get("cache-control", ""))

        connection = request("POST", "/api/navidrome/test", json={})
        listing = request("GET", "/api/navidrome/artists", params={"q": "同名", "page": 2, "page_size": 1})
        targets = listing.json()
        check("Navidrome 原生认证和带前缀分页查询保留同名歌手独立 ID",
              connection.status_code == 200 and connection.json().get("supports_upload") is True
              and targets["total"] == 2 and [item["id"] for item in targets["items"]] == ["artist-b"]
              and targets["items"][0]["mbid"].endswith("000000000002") and upstream.login_count == 1
              and upstream.queries[-1].get("_start") == ["1"] and upstream.queries[-1].get("_end") == ["2"])
        prepared = preview()
        check("同步预览只读取所选目标，不按同名自动覆盖",
              prepared["target"]["id"] == "artist-b" and prepared["portrait"]["id"] == portrait_id
              and prepared["portrait"]["source_image"] == source_image
              and prepared["sync_state"] == "ready" and upstream.count() == 0)
        current = request("GET", prepared["target_image_url"])
        current_image = Image.open(io.BytesIO(current.content))
        current_image.load()
        check("Navidrome 当前头像通过后端代理显示，不返回上游鉴权链接",
              current.status_code == 200 and current.headers.get("content-type") == "image/png"
              and current_image.format == "PNG" and current.content == upstream.current_png
              and "?" not in prepared["target_image_url"])
        posted = submit(prepared["token"])
        outcome = settled(prepared["token"])
        replay = submit(prepared["token"])
        check("单次确认上传有效 JPEG 到精确歌手 ID，成功后重复提交拒绝",
              posted.status_code == 200 and outcome["state"] == "uploaded"
              and outcome["result"].get("target_record_changed") is True and replay.status_code == 409
              and upstream.count() == 1 and upstream.uploads[0] == {"id": "artist-b", "bytes": jpeg})

        prepared = preview(target="artist-a")
        before = upstream.count()
        upstream.hold()

        def concurrent_submit(_):
            with requests.Session() as concurrent:
                concurrent.trust_env = False
                return concurrent.post(base + "/api/artist-portraits/sync", json={"token": prepared["token"]}, timeout=15).status_code

        with ThreadPoolExecutor(max_workers=8) as executor:
            codes = list(executor.map(concurrent_submit, range(8)))
        entered = upstream.entered.wait(5)
        upstream.unhold()
        concurrent_result = settled(prepared["token"])
        check("八个并发确认只有一个取得令牌且只上传一次",
              entered and sorted(codes) == [200] + [409] * 7
              and concurrent_result["state"] == "uploaded" and upstream.count() == before + 1, str(codes))

        first, second = preview(), preview()
        before = upstream.count()
        upstream.hold()
        first_response = submit(first["token"])
        entered = upstream.entered.wait(5)
        other_response = submit(second["token"])
        during_upload = request("POST", "/api/artist-portraits/sync-preview",
                                json={"portrait_id": portrait_id, "artist_id": "artist-b"})
        upstream.unhold()
        distinct_result = settled(first["token"])
        check("同一目标的不同预览令牌也不能并发覆盖",
              entered and first_response.status_code == 200 and other_response.status_code == 409
              and during_upload.status_code == 409 and "token" not in during_upload.json()
              and distinct_result["state"] == "uploaded" and upstream.count() == before + 1)

        prepared = preview(target="artist-a")
        before = upstream.count()
        with upstream.lock:
            upstream.artists["artist-a"]["updatedAt"] = "2026-11-09T00:00:00Z"
        submit(prepared["token"]).raise_for_status()
        changed = settled(prepared["token"])
        check("预览后目标头像发生变化会停止上传",
              changed["state"] == "failed" and "变化" in changed["message"] and upstream.count() == before)

        prepared = preview(identifier=damaged_id)
        before = upstream.count()
        (artifact_dir / f"{damaged_id}.jpg").write_bytes(jpeg + b"tampered")
        submit(prepared["token"]).raise_for_status()
        damaged = settled(prepared["token"])
        check("预览后图片缓存被篡改会校验失败且不上传",
              damaged["state"] == "failed" and upstream.count() == before)
        (artifact_dir / f"{damaged_id}.jpg").write_bytes(jpeg)

        prepared = preview(target="artist-a")
        before = upstream.count()
        upstream.response_code = 500
        submit(prepared["token"]).raise_for_status()
        uncertain = settled(prepared["token"])
        replay = submit(prepared["token"])
        upstream.response_code = 200
        check("远端 5xx 标记结果待确认，令牌不能重放",
              uncertain["state"] == "uncertain" and replay.status_code == 409 and upstream.count() == before + 1
              and uncertain["result"]["uploaded"] is None
              and upstream.password not in uncertain["message"] and upstream.jwt not in uncertain["message"])

        prepared = preview()
        before = upstream.count()
        _postgres(f"UPDATE artist_portrait_syncs SET expires_at=now()-interval '1 second' WHERE token='{prepared['token']}'::uuid;")
        expired = submit(prepared["token"])
        check("过期同步确认在上传前拒绝", expired.status_code == 409 and upstream.count() == before)
        bad_target = request("POST", "/api/artist-portraits/sync-preview",
                             json={"portrait_id": portrait_id, "artist_id": "../auth/login"})
        check("非法目标 ID 不能改变上游请求路径",
              bad_target.status_code == 400 and upstream.count() == before and not upstream.errors)

        interrupted = preview(target="artist-a")
        _postgres(f"UPDATE artist_portrait_syncs SET state='uploading' WHERE token='{interrupted['token']}'::uuid;")
        before = upstream.count()
        stop(server)
        server = None
        run_env["METATIDY_PASSWORD"] = private_password
        server = launch()
        anon_codes = [request("GET", route).status_code for route in (
            "/api/artist-portraits/status", f"/api/artist-portraits/{portrait_id}/preview",
            f"/api/artist-portraits/sync/{interrupted['token']}/target-image", "/api/navidrome/artists",
            "/api/artists", f"/api/artist-portraits/sync/{interrupted['token']}")]
        anon_codes.extend(request("POST", route, json={}).status_code for route in (
            "/api/artist-portraits/fetch", "/api/artist-portraits/sync-preview", "/api/artist-portraits/sync", "/api/navidrome/test"))
        check("设置口令后头像读取、预览和同步全受认证保护", anon_codes == [401] * 10, str(anon_codes))
        request("POST", "/api/login", json={"password": private_password}).raise_for_status()
        recovered = request("GET", f"/api/artist-portraits/sync/{interrupted['token']}").json()
        replay = submit(interrupted["token"])
        check("服务重启把未完成同步恢复为待确认，不会后台补传",
              recovered["state"] == "uncertain" and replay.status_code == 409 and upstream.count() == before)
        request("POST", "/api/logout", json={}).raise_for_status()

        public = "\n".join(public_results)
        check("返回内容不含 Navidrome 密码、JWT、Subsonic token 或 salt",
              all(secret not in public for secret in (upstream.password, upstream.jwt, upstream.sonic_token, upstream.sonic_salt)))
        check("头像流程保持音乐文件不变且未联系任何外部服务",
              upstream.external_attempts == 0 and not upstream.errors
              and all(path.exists() and hashlib.sha256(path.read_bytes()).digest() == digest
                      for path, digest in baseline_audio.items()))
    finally:
        upstream.unhold()
        stop(server)
        upstream.close()
        session.close()
        logfile.close()
        _postgres(f"DELETE FROM artist_portrait_syncs WHERE portrait_id IN ({ids_sql});"
                  f"DELETE FROM artist_portrait_fetches WHERE cache_key IN ({keys_sql}) OR portrait_id IN ({ids_sql});"
                  f"DELETE FROM artist_portraits WHERE id IN ({ids_sql});")
        for identifier in (portrait_id, damaged_id):
            for suffix in ("jpg", "avif"):
                (artifact_dir / f"{identifier}.{suffix}").unlink(missing_ok=True)
