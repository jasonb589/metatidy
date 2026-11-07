"""Complete explicit selections against real HTTP, PostgreSQL and FLAC files.

Index presence is deliberately independent of file availability. The selection
exceeds both the 500-row preview and the 1000-row track listing limits.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac


def check_selection(base: str, music: Path, check, wait_job) -> None:
    root = music / "__selection_acceptance__"
    music_path = music.resolve()
    assert root.resolve().parent == music_path and not root.exists()
    root.mkdir()
    count = 1005
    files: list[Path] = []

    def fingerprint(path: Path):
        return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns

    def describe(value):
        return json.dumps(value, ensure_ascii=False)[:1000]

    with requests.Session() as client:
        def post(route: str, payload: dict):
            response = client.post(f"{base}{route}", json=payload, timeout=60)
            response.raise_for_status()
            return response.json()

        def get(route: str, **params):
            response = client.get(f"{base}{route}", params=params, timeout=60)
            response.raise_for_status()
            return response.json()

        def scan(*, prune=False):
            job = wait_job(post("/api/scan", {"root": root.name, "full": True, "prune": prune})["job_id"])
            if job["state"] != "done":
                raise RuntimeError(f"Selection fixture scan failed: {job}")

        try:
            for ordinal in range(count):
                path = make_flac(root / f"selected-{ordinal:04}.flac")
                audio = FLAC(path)
                audio["title"] = [f"选择核对 {ordinal:04}"]
                audio["artist"] = ["跨页选择验收"]
                audio["x-selection-preserve"] = ["未请求的标签"]
                audio.save()
                files.append(path)
            scan()
            first = get("/api/tracks", q=root.name, page_size=1000, sort="path")
            rows = list(first["items"])
            for page in range(2, first["pages"] + 1):
                rows.extend(get("/api/tracks", q=root.name, page_size=1000, sort="path", page=page)["items"])
            rows.sort(key=lambda row: row["filename"])
            assert len(rows) == count, f"Expected {count} selection fixtures, found {len(rows)}"
            ids = [row["id"] for row in rows]

            # Remove one record through the real scanner. It falls beyond the
            # first 500 items in the reverse-ordered selection below.
            pruned_id = ids[300]
            files[300].unlink()
            scan(prune=True)
            offline = files[1].with_suffix(".offline")
            files[1].rename(offline)
            before = {path.name: fingerprint(path) for path in root.iterdir()}
            ordered = list(reversed(ids)) + [0, -9, 9223372036854775807]
            submitted = ordered + [ordered[0], ordered[501], 0]
            route = "/api/tracks/selection"

            pages = [post(route, {"ids": submitted, "page": page, "page_size": 200}) for page in range(1, 7)]
            items = [item for result in pages for item in result["items"]]
            check("超过1000首的已选索引核对不漏项，重复ID去重且保留首次选择顺序",
                  [item["id"] for item in items] == ordered
                  and all(result["total"] == len(ordered) and result["selected_total"] == len(ordered)
                          and result["page"] == page and result["pages"] == 6 and result["page_size"] == 200
                          for page, result in enumerate(pages, 1)))
            missing = [pruned_id, 0, -9, 9223372036854775807]
            check("每页给出全部选择的索引存在与缺失总数，缺失项保留原位置",
                  [item["id"] for item in items if item["status"] == "missing"] == missing
                  and all(item["track"] is None for item in items if item["status"] == "missing")
                  and all(result["found_total"] == count - 1 and result["missing_total"] == 4 for result in pages))
            offline_item = next(item for item in items if item["id"] == ids[1])
            check("磁盘文件离线仍可核对索引，响应不声称文件可访问",
                  offline_item["status"] == "found" and offline_item["track"]["path"] == str(files[1])
                  and not files[1].exists() and offline.exists()
                  and all("file_exists" not in (item["track"] or {}) for item in items)
                  and all("tags" not in (item["track"] or {}) for item in items))
            last = post(route, {"ids": submitted, "page": 9223372036854775807, "page_size": 200})
            first_page = post(route, {"ids": submitted, "page": -1, "page_size": 200})
            check("已选索引分页的超大页码回到末页，负页码回到首页",
                  last["page"] == 6 and [item["id"] for item in last["items"]] == ordered[1000:]
                  and first_page["page"] == 1 and first_page["items"] == pages[0]["items"])
            empty = post(route, {"ids": [], "page": 999})
            default = post(route, {"ids": ordered[:101]})
            check("空选择明确返回零项而不是全库，默认每页100首",
                  empty == {"total": 0, "selected_total": 0, "found_total": 0, "missing_total": 0,
                            "page": 1, "page_size": 100, "pages": 0, "items": []}
                  and default["page_size"] == 100 and default["pages"] == 2 and len(default["items"]) == 100)
            invalid = ({"page_size": 0}, {"page_size": 201}, {"page": "oops"},
                       {"page": 2.5}, {"ids": ["not-an-id"]}, {"ids": "all"})
            codes = [client.post(f"{base}{route}", json={"ids": ids[:2], **payload}, timeout=30).status_code
                     for payload in invalid]
            check("索引核对拒绝非法分页和ID类型", codes == [422] * len(invalid), str(codes))
            after = {path.name: fingerprint(path) for path in root.iterdir()}
            check("索引核对不改变FLAC、离线文件或修改时间", before == after)

            preview = post("/api/tracks/preview", {"ids": submitted, "fields": {"genre": "Selection acceptance"}})
            check("标签预览保持前500首展示，同时报告全部已选索引缺失",
                  preview["selected_total"] == len(ordered) and preview["previewed_total"] == 500
                  and preview["truncated"] is True and len(preview["items"]) == 500
                  and preview["index_missing_total"] == 4 and preview["index_missing_ids"] == missing
                  and pruned_id not in [item["track_id"] for item in preview["items"]],
                  describe({key: value for key, value in preview.items() if key not in {"items", "fields"}}))
            check("预览数量只统计实际预览的字段差异且不写文件",
                  preview["changed_fields"] == 500
                  and before == {path.name: fingerprint(path) for path in root.iterdir()})
            short_ids = [ids[0], ids[-1], pruned_id, 0]
            duplicates = [ids[0], ids[0], ids[-1], pruned_id, pruned_id, 0, 0]
            preview = post("/api/tracks/preview", {"ids": duplicates, "fields": {"genre": "Selection acceptance"}})
            check("重复选择的标签预览按唯一曲目计数并维持顺序",
                  preview["selected_total"] == 4 and preview["previewed_total"] == 4
                  and [item["track_id"] for item in preview["items"]] == short_ids
                  and preview["changed_fields"] == 2 and preview["index_missing_ids"] == [pruned_id, 0])
            applied = post("/api/tracks/apply", {"ids": duplicates, "fields": {"genre": "Selection acceptance"}})
            check("真实标签写入去重，缺失索引逐项失败且数量守恒",
                  applied["written"] == 2 and applied["skipped"] == 0
                  and [item["track_id"] for item in applied["items"]] == short_ids[:2]
                  and [item["track_id"] for item in applied["failed"]] == short_ids[2:]
                  and all(item["stage"] == "lookup" and item["file_changed"] is False for item in applied["failed"]),
                  describe(applied))
            check("写入后的磁盘标签和索引一致，未选择文件与自定义标签保留",
                  all(FLAC(files[index])["genre"] == ["Selection acceptance"]
                      and FLAC(files[index])["x-selection-preserve"] == ["未请求的标签"]
                      and get(f"/api/tracks/{ids[index]}")["genre"] == "Selection acceptance" for index in (0, -1))
                  and all(fingerprint(path) == before[path.name] for path in root.iterdir()
                          if path.name not in {files[0].name, files[-1].name}))

            # All IDs are absent, so no external scraper is contacted. This
            # specifically verifies lookup accounting and preserved ordering.
            batch_ids = [pruned_id, 0, -9]
            job = wait_job(post("/api/scrape/batch", {"ids": [pruned_id, 0, pruned_id, -9, 0],
                           "fields": ["title"], "auto_apply_min_score": 0})["job_id"])
            result = json.loads(job["result"])
            check("批量刮削不再静默跳过缺失索引，重复选择只计一次失败",
                  job["state"] == "done" and job["total"] == 3 and job["done"] == 3
                  and result["applied"] == 0 and result["skipped"] == 0 and result["failed"] == 3
                  and result["search_only"] is True and result["details_total"] == 3
                  and result["details_truncated"] is False
                  and [item["track_id"] for item in result["details"]] == batch_ids
                  and all(item["stage"] == "lookup" and item["file_changed"] is False
                          and item["error"] for item in result["details"]), describe(result))
            many_missing = list(range(-1000, -1510, -1))
            job = wait_job(post("/api/scrape/batch", {"ids": many_missing + many_missing[:5],
                           "fields": ["title"], "auto_apply_min_score": 70})["job_id"])
            result = json.loads(job["result"])
            check("超过500条缺失刮削仍统计全部唯一ID，报告明确明细截断",
                  job["state"] == "done" and job["total"] == 510 and job["done"] == 510
                  and result["failed"] == 510 and result["applied"] == 0 and result["skipped"] == 0
                  and result["details_total"] == 510 and result["details_truncated"] is True
                  and [item["track_id"] for item in result["details"]] == many_missing[:500])
            report = get(f"/api/jobs/{job['id']}/report", format="json")
            check("批量索引失败在任务报告中保留原始结果与实际保存范围",
                  report["job"]["result"] == job["result"] and report["parsed_result"] == result
                  and report["completeness"]["details_saved"] == 500
                  and report["completeness"]["details_total"] == 510
                  and report["completeness"]["details_truncated"] is True)
        finally:
            assert root.resolve().parent == music_path and root.resolve() != music_path
            for path in root.iterdir():
                assert path.parent == root and path.is_file(), f"Unexpected selection fixture entry: {path}"
                path.unlink()
            try:
                scan(prune=True)
            finally:
                root.rmdir()
