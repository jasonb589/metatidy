"""Immutable filename extraction plans against real HTTP, PostgreSQL and tags.

Only UUID-owned fixtures are mutated. CI supplies real encoded FLAC/MP3 samples;
mutagen independently checks their tags, preserved artwork and audio payload.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from mutagen.flac import FLAC
from mutagen.id3 import APIC, ID3, TIT2, TPE1, TPE2, TRCK, TXXX, USLT

from tests.audiofix import make_flac, make_mp3
from tests.cover_acceptance import image_bytes, replace_cover
from tests.jobs_acceptance import _postgres


def _literal(value: str) -> str:
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def _fingerprint(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns


def _audio_digest(path: Path) -> str:
    data = path.read_bytes()
    if path.suffix == ".flac":
        assert data[:4] == b"fLaC"
        cursor = 4
        while True:
            last = data[cursor] & 0x80
            size = int.from_bytes(data[cursor + 1:cursor + 4], "big")
            cursor += 4 + size
            if last:
                data = data[cursor:]
                break
    else:
        if data[:3] == b"ID3":
            size = sum(value << shift for value, shift in zip(data[6:10], [21, 14, 7, 0]))
            data = data[10 + size + (10 if data[5] & 0x10 else 0):]
        if data[-128:-125] == b"TAG":
            data = data[:-128]
    return hashlib.sha256(data).hexdigest()


def check_filename_tags(base: str, music: Path, check, wait_job) -> None:
    root = music / ("__filename_tags_" + uuid.uuid4().hex)
    assert root.resolve().parent == music.resolve() and not root.exists()
    root.mkdir()
    tokens: set[str] = set()
    fixture_jobs: set[str] = set()
    cover = image_bytes("PNG", (24, 16))
    lyrics = "[00:01.00] 文件名提取必须保留歌词"
    custom = ["保留自定义值", "second value"]
    client = requests.Session()
    client.trust_env = False
    prefix = "/api/tracks/filename-tags"

    def get(route: str, **params):
        response = client.get(base + route, params=params, timeout=45)
        response.raise_for_status()
        return response.json()

    def post(route: str, payload: dict, *, status=200, code=None):
        response = client.post(base + route, json=payload, timeout=90)
        assert response.status_code == status, (route, response.status_code, response.text[:1000])
        result = response.json()
        if code:
            assert result.get("detail", {}).get("code") == code, result
        return result

    def scan(prune=False):
        started = post("/api/scan", {"root": root.name, "full": True, "prune": prune})
        assert wait_job(started["job_id"])["state"] == "done"

    def analyze(ids, template="{track} - {artist} - {title}"):
        return post(prefix + "/parse", {"ids": ids, "template": template})

    def preview(ids, *, overwrite=False, template="{track} - {artist} - {title}", include=None):
        analysis = analyze(ids, template)
        plan = post(prefix + "/preview", {"ids": ids, "template": template,
                    "analysis_revision": analysis["analysis_revision"],
                    "include_ids": [item["track_id"] for item in analysis["items"] if item["status"] == "matched"] if include is None else include,
                    "overwrite": overwrite, "normalize_artist": False})
        tokens.add(plan["token"])
        assert len(plan["items"]) == plan["total"] == len(ids)
        assert [item["track_id"] for item in plan["items"]] == ids
        assert all("_baseline" not in item for item in plan["items"])
        return plan

    def apply(plan, request_id=None):
        request = {"token": plan["token"], "revision": plan["revision"], "request_id": request_id or str(uuid.uuid4())}
        started = post(prefix + "/apply", request)
        fixture_jobs.add(started["job_id"])
        result = wait_job(started["job_id"])
        saved = get(prefix + "/plans/" + plan["token"])
        assert saved["job_id"] == started["job_id"] and saved["state"] == result["state"]
        report = json.loads(result["result"])
        assert report["token"] == plan["token"] and report["revision"] == plan["revision"]
        assert report["details_truncated"] is False and report["details_total"] == len(plan["items"])
        assert report["details"] == saved["items"]
        return started, saved, request

    def seed(name: str, *, existing=False):
        path = root / name
        env = "METATIDY_TEST_FLAC" if path.suffix == ".flac" else "METATIDY_TEST_MP3"
        fixture = os.environ.get(env)
        if os.environ.get("CI"):
            assert fixture and Path(fixture).is_file(), f"CI requires real audio: {env}"
        if fixture:
            shutil.copyfile(fixture, path)
        else:
            (make_flac if path.suffix == ".flac" else make_mp3)(path)
        if path.suffix == ".flac":
            audio = FLAC(path)
            audio.clear()
            audio["lyrics"] = [lyrics]
            audio["x-metatidy-filename-preserve"] = custom
            audio["albumartist"] = ["不应修改的专辑艺术家"]
            if existing:
                audio["title"] = ["已有标题"]
                audio["artist"] = ["已有歌手"]
                audio["tracknumber"] = ["7"]
            audio.save()
            replace_cover(path, cover, "image/png", (24, 16))
        else:
            audio = ID3()
            audio.add(USLT(encoding=3, lang="eng", desc="", text=lyrics))
            audio.add(TXXX(encoding=3, desc="METATIDY_FILENAME_PRESERVE", text=custom))
            audio.add(TPE2(encoding=3, text=["不应修改的专辑艺术家"]))
            audio.add(APIC(encoding=3, mime="image/png", type=3, desc="", data=cover))
            if existing:
                audio.add(TIT2(encoding=3, text=["已有标题"]))
                audio.add(TPE1(encoding=3, text=["已有歌手"]))
                audio.add(TRCK(encoding=3, text=["7"]))
            audio.save(path, v2_version=4)
        return path

    def preserved(path):
        if path.suffix == ".flac":
            audio = FLAC(path)
            return (audio["lyrics"] == [lyrics] and audio["x-metatidy-filename-preserve"] == custom
                    and audio["albumartist"] == ["不应修改的专辑艺术家"] and audio.pictures[0].data == cover)
        audio = ID3(path)
        return (audio.getall("USLT")[0].text == lyrics and audio["TXXX:METATIDY_FILENAME_PRESERVE"].text == custom
                and audio["TPE2"].text == ["不应修改的专辑艺术家"] and audio.getall("APIC")[0].data == cover)

    try:
        empty_flac = seed("01 - 提取歌手甲 - 提取标题甲.v2.flac")
        empty_mp3 = seed("02 - 提取歌手乙 - 提取标题乙.mp3")
        existing = seed("03 - 覆盖歌手 - 覆盖标题.flac", existing=True)
        stale_file = seed("04 - 过期歌手 - 过期标题.flac")
        missing_file = seed("05 - 缺失歌手 - 缺失标题.flac")
        good_file = seed("06 - 成功歌手 - 成功标题.flac")
        ambiguous = seed("A - B - C.flac")
        invalid_file = seed("4294967296 - 非法歌手 - 非法轨号.flac")
        scan()
        rows = get("/api/tracks", q=root.name, page_size=100)["items"]
        by_name = {Path(row["path"]).name: row for row in rows}
        assert len(by_name) == 8
        ids = lambda *paths: [by_name[path.name]["id"] for path in paths]
        all_ids = ids(empty_flac, empty_mp3, existing)
        hashes = {path: _fingerprint(path) for path in (empty_flac, empty_mp3, existing)}
        audio_hashes = {path: _audio_digest(path) for path in hashes}

        parsed = analyze(all_ids)
        check("文件名解析保留多点标题、原始轨号与完整固定顺序",
              [item["track_id"] for item in parsed["items"]] == all_ids
              and parsed["items"][0]["parsed_fields"] == {"track": "01", "artist": "提取歌手甲", "title": "提取标题甲.v2"}
              and all(_fingerprint(path) == stamp for path, stamp in hashes.items()))
        plan = preview(all_ids)
        check("文件名真实预览默认补空，索引的路径推断标题不阻止写入",
              plan["ready_total"] == 2 and plan["changed_fields"] == 6
              and plan["items"][0]["current"]["title"] == ""
              and plan["items"][0]["effective_fields"]["track"] == "1"
              and plan["items"][2]["status"] == "unchanged"
              and {skip["reason"] for skip in plan["items"][2]["skipped"]} == {"existing"}
              and all(_fingerprint(path) == stamp for path, stamp in hashes.items()))
        started, saved, request = apply(plan)
        disk_flac, disk_mp3 = FLAC(empty_flac), ID3(empty_mp3)
        check("逐曲异构写入FLAC和MP3，预览、磁盘和索引一致",
              saved["counts"] == {"written": 2, "unchanged": 1}
              and disk_flac["title"] == ["提取标题甲.v2"] and disk_flac["artist"] == ["提取歌手甲"]
              and disk_flac["tracknumber"] == ["1"] and disk_mp3["TIT2"].text == ["提取标题乙"]
              and disk_mp3["TPE1"].text == ["提取歌手乙"] and disk_mp3["TRCK"].text == ["2"]
              and get(f"/api/tracks/{all_ids[0]}")["title"] == "提取标题甲.v2"
              and get(f"/api/tracks/{all_ids[1]}")["track"] == "2"
              and _fingerprint(existing) == hashes[existing])
        check("文件名标签写入保留封面原字节、歌词、自定义字段和音频帧",
              all(preserved(path) and _audio_digest(path) == audio_hashes[path] for path in hashes))
        after = {path: _fingerprint(path) for path in hashes}
        retry = post(prefix + "/apply", request)
        post(prefix + "/apply", {**request, "request_id": str(uuid.uuid4())}, status=409, code="already_submitted")
        check("提交响应丢失后同request_id只返回原任务，不能再次执行同计划",
              retry["job_id"] == started["job_id"] and all(_fingerprint(path) == stamp for path, stamp in after.items())
              and get(prefix + "/plans/" + plan["token"] + "/items")["items"] == saved["items"])

        noop = preview(ids(empty_flac, empty_mp3))
        post(prefix + "/apply", {"token": noop["token"], "revision": noop["revision"], "request_id": str(uuid.uuid4())}, status=409, code="no_changes")
        check("相同值计划不创建写任务、不改音频哈希与mtime",
              noop["ready_total"] == noop["changed_fields"] == 0
              and all(_fingerprint(path) == after[path] for path in (empty_flac, empty_mp3)))
        overwrite = preview(ids(existing), overwrite=True)
        _, saved, _ = apply(overwrite)
        check("显式覆盖必须重新预览并只写确认字段",
              overwrite["items"][0]["current"]["title"] == "已有标题"
              and saved["items"][0]["status"] == "written"
              and FLAC(existing)["title"] == ["覆盖标题"] and FLAC(existing)["tracknumber"] == ["3"]
              and preserved(existing) and _audio_digest(existing) == audio_hashes[existing])

        # Parse remains index-only even when the audio bytes are unavailable.
        missing_bytes = missing_file.read_bytes()
        missing_file.unlink()
        parsed = analyze(ids(missing_file, invalid_file))
        unreadable = preview(ids(missing_file))
        check("解析不访问音乐文件；真实预览明确区分不可读和字段非法",
              parsed["items"][0]["status"] == "matched" and parsed["items"][1]["status"] == "invalid"
              and unreadable["items"][0]["status"] == "unreadable" and not unreadable["items"][0]["changes"])
        missing_file.write_bytes(missing_bytes)
        check("重复分隔符不会贪婪猜测字段", analyze(ids(ambiguous), "{artist} - {title}")["items"][0]["status"] == "ambiguous")

        fake = 8_000_000_000_000_000
        bounded_ids = [all_ids[0]] + list(range(fake, fake + 499))
        complete = preview(bounded_ids, template="{title}", include=[])
        check("500项完整预览包含第500个缺失索引而不截断",
              complete["total"] == len(complete["items"]) == 500
              and complete["items"][-1]["track_id"] == bounded_ids[-1]
              and complete["counts"] == {"excluded": 1, "index_missing": 499})
        post(prefix + "/parse", {"ids": bounded_ids + [fake + 499], "template": "{title}"}, status=400, code="selection_limit_exceeded")
        for bad in [{"ids": [all_ids[0], all_ids[0]], "template": "{title}"},
                    {"ids": [True], "template": "{title}"}, {"ids": [1.5], "template": "{title}"},
                    {"ids": all_ids, "template": "{title}", "path": "/arbitrary/path"}]:
            post(prefix + "/parse", bad, status=400, code="invalid_request")
        for bad in ("{artist}{title}", "{title}-{title}", "{lyrics}", "{track:02}", "{title"):
            post(prefix + "/parse", {"ids": all_ids, "template": bad}, status=400, code="invalid_template")
        check("501边界、重复编号、任意路径和非法模板均整批拒绝", True)

        # A path A→B→A index update must still invalidate the older analysis.
        changed_id = ids(good_file)[0]
        old_analysis = analyze([changed_id])
        _postgres(f"UPDATE tracks SET path=path || '.aba' WHERE id={changed_id}; UPDATE tracks SET path={_literal(str(good_file))} WHERE id={changed_id};")
        post(prefix + "/preview", {"ids": [changed_id], "template": old_analysis["template"],
             "analysis_revision": old_analysis["analysis_revision"], "include_ids": [changed_id]}, status=409, code="analysis_changed")
        check("索引路径ABA变化使旧解析快照失效", True)

        expired = preview(ids(good_file))
        _postgres(f"UPDATE filename_tag_plans SET expires_at=now()-interval '1 second' WHERE token='{expired['token']}';")
        post(prefix + "/apply", {"token": expired["token"], "revision": expired["revision"], "request_id": str(uuid.uuid4())}, status=409, code="plan_expired")
        post(prefix + "/apply", {"token": expired["token"], "revision": "bad", "request_id": str(uuid.uuid4())}, status=409, code="plan_changed")

        partial = preview(ids(stale_file, missing_file, good_file))
        audio = FLAC(stale_file)
        audio["title"] = ["外部已经改过"]
        audio.save()
        stale_hash = _fingerprint(stale_file)
        missing_bytes = missing_file.read_bytes()
        missing_file.unlink()
        _, saved, _ = apply(partial)
        check("部分过期和缺失不会阻止其余曲目，逐项结果保留且不擅自重试",
              [item["status"] for item in saved["items"]] == ["stale", "failed", "written"]
              and saved["items"][0]["file_changed"] is False and saved["items"][1]["file_changed"] is False
              and saved["items"][0]["stage"] == "stale" and saved["items"][1]["stage"] == "read"
              and _fingerprint(stale_file) == stale_hash and FLAC(good_file)["title"] == ["成功标题"])
        missing_file.write_bytes(missing_bytes)

        concurrent = preview(ids(missing_file))
        request = {"token": concurrent["token"], "revision": concurrent["revision"], "request_id": str(uuid.uuid4())}
        def submit_once(_):
            response = requests.post(base + prefix + "/apply", json=request, timeout=45)
            return response.status_code, response.json()
        with ThreadPoolExecutor(max_workers=4) as executor:
            answers = list(executor.map(submit_once, range(4)))
        submitted_jobs = {answer[1].get("job_id") for answer in answers}
        assert len(submitted_jobs) == 1 and None not in submitted_jobs, answers
        only_job = submitted_jobs.pop()
        fixture_jobs.add(only_job)
        wait_job(only_job)
        check("并发领取同request_id仅启动一个写任务", all(code == 200 for code, _ in answers)
              and _postgres(f"SELECT count(*) FROM jobs WHERE kind='filename_tags' AND result->>'token'='{concurrent['token']}';") == "1")

        # Durable orphan fixture models a crash after marking writing but before
        # the terminal result was committed. Recovery must never perform writes.
        audio = FLAC(missing_file)
        audio["title"] = ["恢复前的真实现值"]
        audio.save()
        recovery = preview(ids(stale_file, missing_file), overwrite=True)
        assert recovery["ready_total"] == 2
        recovery_id = uuid.uuid4().hex[:12]
        fixture_jobs.add(recovery_id)
        recovery_uuid = str(uuid.UUID(recovery_id.ljust(32, "0")))
        token = recovery["token"]
        _postgres(f"""BEGIN;
            INSERT INTO jobs(id,kind,state,total,done,message,error) VALUES('{recovery_uuid}','filename_tags','running',2,0,'orphan fixture','');
            UPDATE filename_tag_plans SET state='running',job_id='{recovery_uuid}',request_id='{uuid.uuid4()}' WHERE token='{token}';
            UPDATE filename_tag_plan_items SET result=jsonb_set(result,'{{status}}',CASE WHEN position=0 THEN '\"writing\"'::jsonb ELSE '\"pending\"'::jsonb END) WHERE token='{token}';
            COMMIT;""")
        recovery_hash = {path: _fingerprint(path) for path in (stale_file, missing_file)}
        deadline = time.monotonic() + 80
        while time.monotonic() < deadline:
            recovered = get(prefix + "/plans/" + token)
            if recovered["state"] == "error":
                break
            time.sleep(0.5)
        check("恢复中断任务：writing需要核对、pending未处理，绝不自动重写",
              recovered["state"] == "error"
              and [item["status"] for item in recovered["items"]] == ["needs_verification", "not_started"]
              and recovered["items"][0]["file_changed"] is True
              and all(_fingerprint(path) == stamp for path, stamp in recovery_hash.items()))
        check("恢复后的任务报告和计划查询保持完整原序",
              json.loads(get("/api/jobs/" + recovery_id)["result"])["details"] == recovered["items"])
    finally:
        client.close()
        if tokens:
            token_list = ",".join(_literal(token) + "::uuid" for token in tokens)
            _postgres(f"DELETE FROM filename_tag_plans WHERE token IN ({token_list});")
        if fixture_jobs:
            job_list = ",".join(_literal(str(uuid.UUID(job.ljust(32, "0")))) + "::uuid" for job in fixture_jobs)
            _postgres(f"DELETE FROM jobs WHERE id IN ({job_list}) AND kind='filename_tags';")
        assert root.resolve().parent == music.resolve() and root.resolve() != music.resolve()
        for path in root.iterdir():
            assert path.is_file() and path.parent == root, path
            path.unlink()
        response = requests.post(base + "/api/scan", json={"root": root.name, "full": True, "prune": True}, timeout=45)
        response.raise_for_status()
        wait_job(response.json()["job_id"])
        root.rmdir()
