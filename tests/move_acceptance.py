"""Full saved-plan review and single execution against real HTTP/PG/FLAC.

The conflict is intentionally beyond the preview's first 500 entries, and the
selection exceeds the track listing's 1000-row page cap. File fingerprints and
the final index distinguish review-only requests from actual execution.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac


def check_moves(base: str, music: Path, check, wait_job) -> None:
    root = music / "__move_acceptance__"
    music_path = music.resolve()
    assert root.resolve().parent == music_path and not root.exists()
    source_root = root / "source"
    target_root = root / "target"
    source_root.mkdir(parents=True)
    count = 1005
    conflict_ordinal, missing_ordinal, literal_ordinal = 701, 751, 702
    literal = "Needle 100%_Mix!'"
    titles = {1: '=SUM(1,2)\n"双引号"', 2: "+待审阅", 3: "-待审阅", 4: "@待审阅", literal_ordinal: literal}
    files: list[Path] = []

    def fingerprint(path: Path):
        return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns

    def describe(value):
        return json.dumps(value, ensure_ascii=False)[:1200]

    with requests.Session() as client:
        def get(route: str, **params):
            response = client.get(f"{base}{route}", params=params, timeout=60)
            response.raise_for_status()
            return response.json()

        def post(route: str, payload: dict):
            response = client.post(f"{base}{route}", json=payload, timeout=60)
            response.raise_for_status()
            return response.json()

        def scan(scope: Path, *, prune=False):
            result = post("/api/scan", {"root": scope.relative_to(music).as_posix(), "full": True, "prune": prune})
            job = wait_job(result["job_id"])
            if job["state"] != "done":
                raise RuntimeError(f"Move fixture scan failed: {job}")

        def listing():
            first = get("/api/tracks", q=root.name, page_size=1000, sort="path", order="asc")
            items = list(first["items"])
            for page in range(2, first["pages"] + 1):
                items.extend(get("/api/tracks", q=root.name, page_size=1000, sort="path", order="asc", page=page)["items"])
            return sorted(items, key=lambda row: row["filename"])

        try:
            for ordinal in range(1, count + 1):
                path = make_flac(source_root / f"song-{ordinal:04}.flac")
                audio = FLAC(path)
                audio["title"] = [titles.get(ordinal, f"移动验收 {ordinal:04}")]
                audio["artist"] = ["计划审阅验收"]
                audio.save()
                files.append(path)
            scan(source_root)
            rows = listing()
            assert len(rows) == count, f"Expected {count} fixture tracks, got {len(rows)}"
            ids = [row["id"] for row in rows]
            before = {path.name: fingerprint(path) for path in files}
            target_root.mkdir()
            conflict_target = target_root / files[conflict_ordinal - 1].name
            conflict_target.write_bytes(b"pre-existing target must be left untouched")
            conflict_before = fingerprint(conflict_target)
            missing_source = files[missing_ordinal - 1]
            offline = missing_source.with_suffix(".offline")
            missing_source.rename(offline)
            body = {"ids": ids, "dir_template": f"{root.name}/target", "filename_template": "{original}", "conflict_policy": "skip"}
            plan = post("/api/move/preview", body)
            token = plan["token"]
            route = f"/api/move/plan/{token}"
            expected_counts = {"move": count - 2, "conflict_skip": 1, "invalid": 1}
            check("超过1000个显式选择全部进入计划，首屏500只是展示截断",
                  plan["total"] == count and plan["planned"] == count
                  and plan["truncated"] is False and plan["display_truncated"] is True
                  and len(plan["items"]) == 500 and plan["counts"] == expected_counts, describe(plan["counts"]))

            pages = [get(f"{route}/items", page=page, page_size=200) for page in range(1, 7)]
            all_items = [item for page in pages for item in page["items"]]
            check("完整计划稳定分页不重不漏，并保留选择顺序和原始序号",
                  len(all_items) == count and [item["track_id"] for item in all_items] == ids
                  and [item["ordinal"] for item in all_items] == list(range(1, count + 1))
                  and all(page["filtered_total"] == count and page["planned"] == count
                          and page["token"] == token and page["executed"] is False for page in pages))
            last = get(f"{route}/items", page=9223372036854775807, page_size=200)
            check("超大页码安全回到末页", last["page"] == 6 and last["pages"] == 6 and len(last["items"]) == 5)

            conflict = get(f"{route}/items", action="conflict_skip", page_size=20)
            invalid = get(f"{route}/items", action="invalid", page_size=20)
            check("首500项之外的冲突和缺失文件仍可筛选审阅",
                  conflict["filtered_total"] == 1 and conflict["items"][0]["ordinal"] == conflict_ordinal
                  and invalid["filtered_total"] == 1 and invalid["items"][0]["ordinal"] == missing_ordinal
                  and conflict["counts"] == expected_counts and invalid["counts"] == expected_counts)
            matched = get(f"{route}/items", q="needle 100%_mix!'")
            empty = get(f"{route}/items", q="' OR 1=1 --", page=9)
            check("搜索覆盖全计划且按字面匹配百分号下划线与引号",
                  matched["filtered_total"] == 1 and matched["items"][0]["ordinal"] == literal_ordinal
                  and get(f"{route}/items", q="%")["filtered_total"] == 1
                  and get(f"{route}/items", q="Needle 100X_Mix!")["filtered_total"] == 0
                  and empty["filtered_total"] == 0 and empty["items"] == [] and empty["page"] == 1 and empty["pages"] == 0)
            combined = get(f"{route}/items", action="invalid", q=missing_source.name)
            check("动作与路径搜索共同生效，浏览条件不修改整份计划范围",
                  combined["filtered_total"] == 1 and combined["items"][0]["track_id"] == ids[missing_ordinal - 1]
                  and get(f"{route}/items", action="move", q=missing_source.name)["filtered_total"] == 0
                  and combined["planned"] == count and combined["total"] == count)

            invalid_queries = ({"action": "drop table"}, {"page_size": 0}, {"page_size": 201}, {"q": "字" * 501})
            codes = [client.get(f"{base}{route}/items", params=params, timeout=30).status_code for params in invalid_queries]
            check("分页筛选参数越界明确拒绝，未知计划返回404",
                  codes == [422] * len(codes)
                  and client.get(f"{base}/api/move/plan/no-such-plan/items", timeout=30).status_code == 404,
                  str(codes))

            report_response = client.get(f"{base}{route}/export", params={"format": "json"}, timeout=60)
            report_response.raise_for_status()
            report = report_response.json()
            check("JSON计划报告包含完整1005项和计划标识，不冒充执行结果",
                  report["report_type"] == "move_plan" and report["filtered_total"] == count
                  and len(report["items"]) == count and report["items"][-1]["track_id"] == ids[-1]
                  and "attachment" in report_response.headers.get("Content-Disposition", "")
                  and "moved" not in report and "failures" not in report)
            filtered_report = get(f"{route}/export", format="json", action="invalid", q=missing_source.name)
            check("筛选报告只导出匹配项，并保留整份计划规模",
                  filtered_report["filtered_total"] == 1 and len(filtered_report["items"]) == 1
                  and filtered_report["items"][0]["ordinal"] == missing_ordinal
                  and filtered_report["planned"] == count and filtered_report["q"] == missing_source.name
                  and filtered_report["action"] == "invalid")

            csv_response = client.get(f"{base}{route}/export", params={"format": "csv"}, timeout=60)
            csv_response.raise_for_status()
            csv_rows = list(csv.DictReader(io.StringIO(csv_response.content.decode("utf-8-sig"), newline="")))
            by_ordinal = {int(item["ordinal"]): item for item in csv_rows}
            check("CSV完整导出处理中文、换行、引号和公式前缀",
                  csv_response.content.startswith(b"\xef\xbb\xbf") and len(csv_rows) == count
                  and all(by_ordinal[i]["title"] == "'" + titles[i] for i in (1, 2, 3, 4))
                  and by_ordinal[literal_ordinal]["title"] == literal
                  and all(item["report_type"] == "move_plan" and item["plan_token"] == token for item in csv_rows))
            filtered_csv = client.get(f"{base}{route}/export", params={"format": "csv", "action": "conflict_skip"}, timeout=30)
            filtered_csv.raise_for_status()
            filtered_csv_rows = list(csv.DictReader(io.StringIO(filtered_csv.content.decode("utf-8-sig"))))
            check("CSV筛选作用于完整计划，非法导出格式明确拒绝",
                  len(filtered_csv_rows) == 1 and int(filtered_csv_rows[0]["ordinal"]) == conflict_ordinal
                  and client.get(f"{base}{route}/export", params={"format": "exe"}, timeout=30).status_code == 422)

            limited = post("/api/move/preview", {**body, "limit": 600})
            limited_items = get(f"/api/move/plan/{limited['token']}/items", page=3, page_size=200)
            check("主动限量、匹配总数和页面大小分别呈现",
                  limited["total"] == count and limited["planned"] == 600 and limited["truncated"] is True
                  and limited_items["total"] == count and limited_items["planned"] == 600
                  and limited_items["filtered_total"] == 600 and limited_items["pages"] == 3)
            duplicates = post("/api/move/preview", {**body, "ids": [ids[0], ids[0]]})
            missing_id = client.post(f"{base}/api/move/preview", json={**body, "ids": [ids[0], 9223372036854775807]}, timeout=30)
            check("重复选择去重，已消失的索引ID不能静默漏项",
                  duplicates["planned"] == 1 and duplicates["total"] == 1 and missing_id.status_code == 400,
                  f"duplicate planned={duplicates['planned']}; missing HTTP={missing_id.status_code}")

            dry = post("/api/move/execute", {"token": token, "dry_run": True})
            unchanged = all(fingerprint(path if path.exists() else offline) == before[path.name] for path in files)
            check("搜索分页导出与演练均不改文件，演练始终统计原计划",
                  dry["moved"] == count - 2 and dry["skipped"] == 2 and dry["failed"] == 0
                  and unchanged and fingerprint(conflict_target) == conflict_before
                  and get(f"{route}/items")["executed"] is False, describe(dry))

            barrier = threading.Barrier(8)

            def submit(_index):
                barrier.wait(timeout=30)
                response = requests.post(f"{base}/api/move/execute", json={"token": token, "dry_run": False}, timeout=60)
                return response.status_code, response.json()

            with ThreadPoolExecutor(max_workers=8) as pool:
                submissions = list(pool.map(submit, range(8)))
            codes = [code for code, _data in submissions]
            check("八个并发执行请求仅有一个领取计划，其余立即409",
                  codes.count(200) == 1 and codes.count(409) == 7, str(codes))
            accepted = [data for code, data in submissions if code == 200]
            assert len(accepted) == 1, f"Unexpected move claims: {describe(submissions)}"
            check("任务提交后立即标记计划已消费，分页不能重置执行状态",
                  get(f"{route}/items", action="invalid")["executed"] is True
                  and get(route)["_executed"] is True)
            job = wait_job(accepted[0]["job_id"])
            summary = json.loads(job.get("result") or "{}")
            check("执行处理整份计划而非浏览筛选结果，汇总真实成功与跳过",
                  job["state"] == "done" and summary.get("moved") == count - 2
                  and summary.get("skipped") == 2 and summary.get("failed") == 0
                  and summary.get("failures") == [], describe(summary))
            file_results = all(
                fingerprint(target_root / path.name)[0] == before[path.name][0] and not path.exists()
                for ordinal, path in enumerate(files, start=1) if ordinal not in (conflict_ordinal, missing_ordinal)
            )
            check("1003个源文件实际移动且内容不变，冲突目标与缺失源不被替换",
                  file_results and fingerprint(files[conflict_ordinal - 1]) == before[conflict_target.name]
                  and fingerprint(conflict_target) == conflict_before
                  and fingerprint(offline) == before[missing_source.name])
            after_rows = {row["id"]: row for row in listing()}
            check("移动后的索引路径逐项同步，跳过与缺失项路径保留",
                  all(Path(after_rows[track_id]["path"]) == (files[i] if i + 1 in (conflict_ordinal, missing_ordinal)
                                                               else target_root / files[i].name)
                      for i, track_id in enumerate(ids)))
            replay = client.post(f"{base}/api/move/execute", json={"token": token}, timeout=30)
            saved_report = get(f"{route}/export", format="json", action="invalid")
            check("完成后重复提交仍409，原计划仍可查看和导出",
                  replay.status_code == 409 and saved_report["executed"] is True
                  and saved_report["filtered_total"] == 1
                  and saved_report["items"][0]["source"] == str(missing_source))
        finally:
            # Remove only our checked fixture root; keep it present until scoped
            # pruning has removed the old index entries.
            assert root.resolve().parent == music_path
            if root.exists():
                shutil.rmtree(root)
                root.mkdir()
                try:
                    scan(root, prune=True)
                finally:
                    root.rmdir()
