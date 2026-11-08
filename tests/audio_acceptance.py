"""Real indexed-audio HTTP reads, ranges and path boundaries with owned files.

Only UUID fixture rows and files created here are cleaned up. The main MP3 has
real CI audio frames plus varied ID3 bytes, so byte-range offsets cannot pass by
returning an arbitrary chunk of silence. No scan or write API is invoked.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import requests
from mutagen.id3 import ID3, TIT2, TXXX

from tests.audiofix import make_flac, make_mp3
from tests.jobs_acceptance import _postgres


def _literal(value: str) -> str:
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def _database_snapshot() -> str:
    return _postgres("""SELECT jsonb_build_object(
        'tracks',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) FROM tracks t),
        'jobs',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(j)::text),'' ORDER BY id),'')) FROM jobs j));""")


def check_audio(base: str, music: Path, check) -> None:
    nonce = uuid.uuid4().hex
    library = music.resolve()
    root = library / f"__audio_acceptance_{nonce}_试听__"
    outside = library.parent / f"{library.name}2-audio-{nonce}"
    assert root.parent == library and outside.parent == library.parent and not outside.is_relative_to(library)
    assert not root.exists() and not outside.exists()
    root.mkdir()
    outside.mkdir()
    owned_files: set[Path] = set()
    owned_links: list[Path] = []
    owned_dirs: list[Path] = [root, outside]
    rows: list[dict] = []
    owned_ids: dict[int, dict] = {}
    before_database = _database_snapshot()

    def create_file(path: Path, content: bytes):
        assert path.parent in owned_dirs and not path.exists()
        path.write_bytes(content)
        owned_files.add(path)
        return path

    def add(path: str | Path, name: str, **values):
        path = str(path)
        row = {"path": path, "dir": str(Path(path).parent), "filename": Path(path).name,
               "ext": "not-the-real-extension", "title": f"AudioFixture-{nonce}-{name}",
               "artist": "试听验收歌手", "size": 1, "mtime": 1.0,
               "tags_loaded": False, "path_derived": True, **values}
        rows.append(row)
        return row

    def file_snapshot():
        return {str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size,
                            path.stat().st_mtime_ns) for path in owned_files}

    def checked(response, payload, mime="audio/mpeg", *, status=200, total=None, start=None, head=False):
        headers = response.headers
        expected_range = None if status == 200 else f"bytes {start}-{start + len(payload) - 1}/{total}"
        return (response.status_code == status and response.content == (b"" if head else payload)
                and headers.get("content-type") == mime and headers.get("content-length") == str(len(payload))
                and headers.get("accept-ranges") == "bytes"
                and {"private", "no-store"} <= {part.strip() for part in headers.get("cache-control", "").split(",")}
                and headers.get("x-content-type-options") == "nosniff"
                and headers.get("content-range") == expected_range)

    with requests.Session() as client:
        client.trust_env = False

        def audio(row, method="GET", **kwargs):
            track_id = row["id"] if isinstance(row, dict) else row
            return client.request(method, f"{base}/api/tracks/{track_id}/audio", timeout=30,
                                  allow_redirects=False, **kwargs)

        try:
            main_file = root / "试听 %_!' 音频.MP3"
            fixture = os.environ.get("METATIDY_TEST_MP3")
            if fixture:
                create_file(main_file, Path(fixture).read_bytes())
            else:
                make_mp3(main_file, frames=320)
                owned_files.add(main_file)
            tags = ID3()
            tags.add(TIT2(encoding=3, text=["只读试听：保留全部音频字节"]))
            distinct = "".join(hashlib.sha256(f"{nonce}-{index}".encode()).hexdigest() for index in range(2200))
            tags.add(TXXX(encoding=3, desc="audio-acceptance-bytes", text=[distinct]))
            tags.save(main_file)
            original = main_file.read_bytes()
            assert len(original) > 128 * 1024 and original[65520:65580] != original[:60]
            main = add(main_file, "main")
            short_file = create_file(root / "short.mp3", original[:1000])
            short = add(short_file, "short", size=2**40)
            empty_file = create_file(root / "empty.mp3", b"")
            empty = add(empty_file, "empty", size=999)
            flac_file = root / "sample.flac"
            fixture_flac = os.environ.get("METATIDY_TEST_FLAC")
            if fixture_flac:
                create_file(flac_file, Path(fixture_flac).read_bytes())
            else:
                make_flac(flac_file)
                owned_files.add(flac_file)
            flac = add(flac_file, "flac")
            unknown_file = create_file(root / "unknown.txt", b"audio endpoint must not expose arbitrary file types")
            unknown = add(unknown_file, "unknown", ext="mp3")
            outside_file = create_file(outside / "outside.mp3", b"owned outside fixture - must never be served")
            outside_row = add(outside_file, "outside", ext="mp3")
            directory = root / "directory.mp3"
            directory.mkdir()
            owned_dirs.append(directory)
            nonregular = add(directory, "directory")
            missing_file = root / "missing.mp3"
            missing = add(missing_file, "missing")
            moved_away = root / "went-offline.mp3"
            relative = add(f"{root.name}{os.sep}{main_file.name}", "relative")
            dot = add(str(root) + os.sep + "." + os.sep + main_file.name, "dot")
            traversal = add(str(root) + os.sep + ".." + os.sep + root.name + os.sep + main_file.name, "traversal")

            aliases = {}
            if os.name != "nt":
                for name, target, is_directory in (
                    ("inside-alias.mp3", main_file, False),
                    ("outside-alias.mp3", outside_file, False),
                    ("inside-directory", root, True),
                    ("outside-directory", outside, True),
                ):
                    link = root / name
                    link.symlink_to(target, target_is_directory=is_directory)
                    owned_links.append(link)
                    endpoint = link / (main_file.name if target == root else outside_file.name) if is_directory else link
                    aliases[name] = add(endpoint, name)

            columns = {"path": "text", "dir": "text", "filename": "text", "ext": "text", "title": "text",
                       "artist": "text", "size": "bigint", "mtime": "double precision", "tags_loaded": "boolean", "path_derived": "boolean"}
            document = _literal(json.dumps(rows, ensure_ascii=False))
            fields = ",".join(columns)
            record = ",".join(f"{field} {kind}" for field, kind in columns.items())
            inserted = json.loads(_postgres(
                f"WITH inserted AS (INSERT INTO tracks({fields}) SELECT {fields} "
                f"FROM jsonb_to_recordset({document}::jsonb) AS fixture({record}) RETURNING id,path) "
                "SELECT jsonb_agg(to_jsonb(inserted) ORDER BY id) FROM inserted;"
            ))
            by_path = {row["path"]: row for row in rows}
            assert len(inserted) == len(rows)
            for item in inserted:
                row = by_path[item["path"]]
                row["id"] = item["id"]
                owned_ids[row["id"]] = row
            indexed_snapshot = _database_snapshot()
            baseline = file_snapshot()

            complete = audio(main)
            check("试听完整读取索引ID对应音频原字节，实际长度和MIME不依赖陈旧索引字段",
                  checked(complete, original)
                  and hashlib.sha256(complete.content).digest() == hashlib.sha256(original).digest()
                  and checked(audio(short), original[:1000])
                  and checked(audio(flac), flac_file.read_bytes(), "audio/flac"))
            cases = [("bytes=0-0", 0, 1), ("bytes=13-199", 13, 200),
                     ("bytes=65520-65580", 65520, 65581), ("bytes=100-", 100, len(original)),
                     ("bytes=-257", len(original) - 257, len(original)),
                     (f"bytes={len(original) - 17}-{len(original) + 900}", len(original) - 17, len(original)),
                     (f"bytes=-{len(original) + 900}", 0, len(original))]
            range_results = [(audio(main, headers={"Range": header}), start, end) for header, start, end in cases]
            check("单段Range支持闭区间、开放尾部和后缀读取，跨64KiB及越尾截断字节准确",
                  all(checked(response, original[start:end], status=206, total=len(original), start=start)
                      for response, start, end in range_results))
            split = len(original) // 2
            left = audio(main, headers={"Range": f"bytes=0-{split - 1}"})
            right = audio(main, headers={"Range": f"bytes={split}-"})
            check("分段响应可无损拼回完整音频且互不污染读取位置",
                  checked(left, original[:split], status=206, total=len(original), start=0)
                  and checked(right, original[split:], status=206, total=len(original), start=split)
                  and hashlib.sha256(left.content + right.content).digest() == hashlib.sha256(original).digest())

            invalid_ranges = ["bytes=", "bytes=-", "bytes=-0", "bytes=3-2", f"bytes={len(original)}-",
                              "bytes=0-1,3-4", "items=0-1", "Bytes=0-1", "bytes=+1-2", "bytes=a-b",
                              "bytes=1 -2", "bytes=1- 2", "bytes=18446744073709551616-", "bytes=0-18446744073709551616"]
            rejected = [audio(main, headers={"Range": value}) for value in invalid_ranges]
            check("非法、多段、零后缀和越界Range返回416及实际文件总长，响应体为空",
                  all(response.status_code == 416 and response.content == b""
                      and response.headers.get("content-range") == f"bytes */{len(original)}"
                      and response.headers.get("content-length") == "0" for response in rejected),
                  str([response.status_code for response in rejected]))
            address = urlsplit(base)
            connection = http.client.HTTPConnection(address.hostname, address.port, timeout=30)
            try:
                connection.putrequest("GET", f"/api/tracks/{main['id']}/audio")
                connection.putheader("Range", "bytes=0-10")
                connection.putheader("Range", "bytes=20-30")
                connection.endheaders()
                duplicate_range = connection.getresponse()
                duplicate_bytes = duplicate_range.read()
                check("重复Range请求头明确拒绝，不静默选择第一段",
                      duplicate_range.status == 416 and duplicate_bytes == b""
                      and duplicate_range.getheader("Content-Range") == f"bytes */{len(original)}")
            finally:
                connection.close()
            if_range = [audio(main, headers={"Range": "bytes=5-20", "If-Range": value})
                        for value in ('"old-etag"', "Sun, 06 Nov 1994 08:49:37 GMT")]
            check("缺少服务器校验器时If-Range安全回退完整200，不拼接可能陈旧的分段",
                  all(checked(response, original) for response in if_range))
            heads = [audio(main, "HEAD", headers=headers) for headers in ({}, {"Range": "bytes=0-9"},
                     {"Range": "bytes=999999999-"}, {"Range": "malformed", "If-Range": '"old"'})]
            check("HEAD只返回完整文件头并忽略Range，没有响应体或部分内容标记",
                  all(checked(response, original, head=True) for response in heads))
            empty_get = audio(empty)
            empty_range = audio(empty, headers={"Range": "bytes=0-"})
            check("空音频完整读取为200零字节，任何Range为416而HEAD仍返回零长度",
                  checked(empty_get, b"") and checked(audio(empty, "HEAD", headers={"Range": "bytes=0-"}), b"", head=True)
                  and empty_range.status_code == 416 and empty_range.content == b""
                  and empty_range.headers.get("content-range") == "bytes */0")
            ignored_query = audio(main, params={"path": str(outside_file), "file": str(outside_file)})
            check("试听路径只能来自已索引ID，URL查询参数无法替换为另一个本地文件",
                  checked(ignored_query, original))

            identity_codes = [audio(value).status_code for value in ("invalid", "1.5", "9223372036854775808", 0, -1, 9223372036854775807)]
            check("试听ID严格解析，非法编号422且非正数或不存在的索引404",
                  identity_codes == [422, 422, 422, 404, 404, 404], str(identity_codes))
            boundary = [(relative, 400), (dot, 400), (traversal, 400), (outside_row, 403),
                        (missing, 404), (nonregular, 400), (unknown, 415)]
            boundary_codes = [(audio(row).status_code, audio(row, "HEAD").status_code) for row, _ in boundary]
            check("试听拒绝相对或穿越路径、音乐根外文件、缺失文件、目录和不支持扩展",
                  boundary_codes == [(code, code) for _, code in boundary], str(boundary_codes))
            if aliases:
                check("真实文件与目录符号链接越出音乐根时拒绝，根内链接仍可试听",
                      checked(audio(aliases["inside-alias.mp3"]), original)
                      and checked(audio(aliases["inside-directory"]), original)
                      and all(audio(aliases[name]).status_code == audio(aliases[name], "HEAD").status_code == 403
                              for name in ("outside-alias.mp3", "outside-directory")))

            # Close a partially consumed stream, then make a fresh request and
            # rename the same owned file. Neither action should wait on a leaked
            # reader or a server-side whole-file buffer.
            with audio(main, stream=True) as streaming:
                assert streaming.status_code == 200
                assert next(streaming.iter_content(4096)) == original[:4096]
            retry = audio(main, headers={"Range": "bytes=42-83"})
            main_file.rename(moved_away)
            try:
                offline_code = audio(main).status_code
                offline_head = audio(main, "HEAD")
            finally:
                moved_away.rename(main_file)
            check("中断试听后可重新分段读取，索引文件离线及时404且恢复后可继续试听",
                  checked(retry, original[42:84], status=206, total=len(original), start=42)
                  and offline_code == offline_head.status_code == 404 and offline_head.content == b""
                  and checked(audio(main), original))
            check("完整试听、拖动分段、HEAD和失败请求均不改音频、索引或创建后台任务",
                  file_snapshot() == baseline and _database_snapshot() == indexed_snapshot
                  and {path.name for path in root.iterdir()} == (
                      {path.name for path in owned_files if path.parent == root}
                      | {path.name for path in owned_links} | {path.name for path in owned_dirs if path.parent == root}))
        finally:
            paths = {row["path"] for row in rows}
            if paths:
                paths_sql = ",".join(_literal(path) for path in paths)
                ids_sql = " AND id IN (" + ",".join(str(value) for value in owned_ids) + ")" if owned_ids else ""
                _postgres(f"DELETE FROM tracks WHERE path IN ({paths_sql}){ids_sql};")
            for link in reversed(owned_links):
                assert link.parent == root and link.is_symlink()
                link.unlink()
            for path in owned_files:
                assert path.parent in owned_dirs and (path.resolve().is_relative_to(root) or path.parent == outside)
                path.unlink(missing_ok=True)
            for directory in reversed(owned_dirs):
                assert directory == outside or directory.resolve().is_relative_to(root)
                directory.rmdir()
            check("试听验收只清理自有文件和索引，原曲库与任务数据保持完整",
                  not root.exists() and not outside.exists() and _database_snapshot() == before_database)
