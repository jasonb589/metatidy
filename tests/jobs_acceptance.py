"""Task history, saved reports and authoritative states with real PG/Redis.

Only unique fixture job IDs are inserted or removed. psql receives credentials
through its environment and SQL through stdin, never through shell text.
"""
from __future__ import annotations

import json
import os
import socket
import ssl
import subprocess
import time
import uuid
from collections import Counter
from urllib.parse import parse_qs, unquote, urlsplit

import requests


def _postgres(sql: str) -> str:
    url = urlsplit(os.environ["DATABASE_URL"])
    env = {**os.environ, "PGHOST": url.hostname or "localhost", "PGPORT": str(url.port or 5432),
           "PGUSER": unquote(url.username or ""), "PGPASSWORD": unquote(url.password or ""),
           "PGDATABASE": unquote(url.path.lstrip("/")), "PGCLIENTENCODING": "UTF8"}
    mode = parse_qs(url.query).get("sslmode", [None])[0]
    if mode:
        env["PGSSLMODE"] = mode
    result = subprocess.run(["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
                            input=sql, text=True, encoding="utf-8", capture_output=True, env=env, timeout=45)
    if result.returncode:
        raise RuntimeError(f"Job fixture SQL failed (exit {result.returncode}); check database availability")
    return result.stdout.strip()


def _redis(*args):
    """Small RESP client for fixture keys; supports configured auth and database."""
    url = urlsplit(os.environ["REDIS_URL"])
    connection = socket.create_connection((url.hostname or "localhost", url.port or 6379), timeout=10)
    if url.scheme == "rediss":
        connection = ssl.create_default_context().wrap_socket(connection, server_hostname=url.hostname)
    with connection, connection.makefile("rb") as stream:
        def receive():
            line = stream.readline()
            if not line:
                raise RuntimeError("Redis fixture connection ended unexpectedly")
            kind, value = line[:1], line[1:-2]
            if kind == b"-":
                raise RuntimeError("Redis rejected a fixture command")
            if kind == b"+":
                return value.decode()
            if kind == b":":
                return int(value)
            if kind == b"$":
                length = int(value)
                if length < 0:
                    return None
                data = stream.read(length)
                if len(data) != length or stream.read(2) != b"\r\n":
                    raise RuntimeError("Incomplete Redis fixture reply")
                return data.decode()
            if kind == b"*":
                return [receive() for _ in range(int(value))]
            raise RuntimeError("Unknown Redis fixture reply")

        def command(*values):
            chunks = [str(value).encode("utf-8") for value in values]
            connection.sendall(b"*" + str(len(chunks)).encode() + b"\r\n" + b"".join(
                b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n" for value in chunks))
            return receive()

        if url.password:
            credentials = [unquote(url.password)]
            if url.username:
                credentials.insert(0, unquote(url.username))
            command("AUTH", *credentials)
        database = url.path.lstrip("/")
        if database:
            command("SELECT", int(database))
        return command(*args)


def check_jobs(base: str, check) -> None:
    nonce = uuid.uuid4().hex[:8]
    prefix = f"TaskHistoryFixture-{nonce}"
    anchor = time.time() + 60
    rows = []
    for number in range(40):
        job_id = nonce + f"{number:04x}"
        rows.append({"id": str(uuid.UUID(job_id.ljust(32, "0"))), "short_id": job_id,
                     "kind": ("scan", "scrape", "move")[number % 3], "state": "done", "total": 7, "done": 7,
                     "message": f"{prefix} task {number:02}", "error": "", "result": {"failed": 0, "skipped": 7},
                     "created_at": anchor + number, "updated_at": anchor + number})
    # Both active records are older than the recent-20 window.
    for number in (0, 1):
        rows[number].update(state="running", done=2, created_at=anchor - 86400, updated_at=anchor - 100, result=None)
    rows[2].update(kind="scan", created_at=anchor - 43200, updated_at=anchor + 200,
                   result={"trigger": "watch", "added": 1, "updated": 0, "failed": 0})
    rows[3].update(kind="scan", result={"trigger": "watch", "added": 2, "failed": 0})
    details = [{"track_id": number, "status": "已保存结果", "candidate": {"title": "只在结果正文出现的关键词"}} for number in range(500)]
    rows[4].update(kind="scrape", result={"applied": 530, "failed": 10, "details": details,
                                         "details_total": 540, "details_truncated": True})
    rows[5].update(kind="scrape", result={"failed": 0, "details": details})
    rows[6].update(result=["legacy scalar-or-array", {"retained": True}])
    rows[7].update(state="error", done=3, error="容器重启导致任务中断", result=None)
    rows[8].update(kind="move", result={"moved": 6, "skipped": 0, "failed": 1, "renamed": 1,
                                       "failures": [{"source": "/music/original.flac", "target": "/music/expected.flac", "error": "文件离线"}]})
    rows[9].update(kind="scan", result={"failed": 25, "errors": [f"读取失败 {number}" for number in range(20)]})
    literal = f"{prefix} Needle 100%_Mix!'"
    rows[10]["message"] = literal
    # A tie verifies deterministic UUID ordering for pagination.
    rows[38]["created_at"] = rows[39]["created_at"]
    keys = [f"metatidy:job:{rows[number]['short_id']}" for number in (0, 7)]
    ids_sql = ",".join("'" + row["id"] + "'::uuid" for row in rows)
    document = json.dumps(rows, ensure_ascii=False).replace("'", "''")

    with requests.Session() as client:
        def get(route, **params):
            response = client.get(f"{base}{route}", params=params, timeout=30)
            response.raise_for_status()
            return response.json()

        baseline = get("/api/jobs")["counts"]
        try:
            _postgres(f"""INSERT INTO jobs (id,kind,state,total,done,message,error,result,created_at,updated_at)
                SELECT id,kind,state,total,done,message,error,result,to_timestamp(created_at),to_timestamp(updated_at)
                FROM jsonb_to_recordset('{document}'::jsonb) AS entry(id uuid,kind text,state text,total bigint,done bigint,
                    message text,error text,result jsonb,created_at double precision,updated_at double precision);""")
            overview = get("/api/jobs")
            counts = Counter(row["state"] for row in rows)
            check("任务概况统计全库，较早运行任务不会被最近20条挤掉",
                  overview["counts"]["total"] == baseline["total"] + len(rows)
                  and all(overview["counts"][state] == baseline[state] + counts[state] for state in ("running", "done", "error"))
                  and overview["active_total"] == baseline["running"] + 2
                  and {rows[0]["short_id"], rows[1]["short_id"]} <= {item["id"] for item in overview["active"]}
                  and rows[0]["short_id"] not in {item["id"] for item in overview["jobs"]})
            check("旧任务列表合同保留完整result字符串，新活跃摘要不带大结果",
                  len(overview["jobs"]) == 20 and all(isinstance(item["result"], str) for item in overview["jobs"])
                  and all("result" not in item and "summary" in item for item in overview["active"]))
            watch = overview["latest_completed_watch"]
            check("自动扫描完成游标按完成更新时间排序，与历史创建时间分离",
                  watch["id"] == rows[2]["short_id"] and watch["cursor"]
                  and abs(watch["updated_at"] - rows[2]["updated_at"]) < .01)

            pages = [get("/api/jobs/history", q=prefix, page=page, page_size=7) for page in range(1, 7)]
            items = [item for page in pages for item in page["items"]]
            expected = sorted(rows, key=lambda row: (row["created_at"], row["id"]), reverse=True)
            check("历史任务稳定分页不重不漏，同时间记录有固定顺序",
                  [item["id"] for item in items] == [row["short_id"] for row in expected]
                  and all(page["total"] == 40 and page["pages"] == 6 for page in pages))
            check("历史列表只传摘要标量，不重复传输500条结果正文",
                  all("result" not in item and "has_result" in item and "has_errors" in item for item in items)
                  and all(all(isinstance(value, (str, int, float, bool)) for value in item["summary"].values()) for item in items)
                  and "只在结果正文出现的关键词" not in json.dumps(pages, ensure_ascii=False))
            by_id = {item["id"]: item for item in items}
            partial = by_id[rows[8]["short_id"]]
            check("任务已完成与部分文件失败分开表示，真实摘要保留错误标记",
                  partial["state"] == "done" and partial["has_errors"] is True and partial["summary"]["failed"] == 1
                  and by_id[rows[7]["short_id"]]["state"] == "error"
                  and by_id[rows[4]["short_id"]]["summary"]["details_total"] == 540)
            filtered = get("/api/jobs/history", q=prefix, kind="move", state="done", page_size=100)
            expected_filtered = {row["short_id"] for row in rows if row["kind"] == "move" and row["state"] == "done"}
            check("类型状态与搜索条件共同生效，任务失败筛选不混入部分失败",
                  {item["id"] for item in filtered["items"]} == expected_filtered
                  and get("/api/jobs/history", q=prefix, state="error")["total"] == 1
                  and overview["counts"] == get("/api/jobs")["counts"])
            match = get("/api/jobs/history", q=literal.lower())
            check("历史搜索支持编号与字面通配字符，结果正文不在搜索范围",
                  match["total"] == 1 and match["items"][0]["id"] == rows[10]["short_id"]
                  and get("/api/jobs/history", q=rows[0]["short_id"])["total"] == 1
                  and get("/api/jobs/history", q=f"{prefix} Needle 100X_Mix!")["total"] == 0
                  and get("/api/jobs/history", q="只在结果正文出现的关键词")["total"] == 0)
            last = get("/api/jobs/history", q=prefix, page=9223372036854775807, page_size=7)
            empty = get("/api/jobs/history", q=f"{prefix}-not-found", page=999)
            bad = [{"kind": "unknown"}, {"state": "queued"}, {"page_size": 0}, {"page_size": 101}, {"q": "字" * 501}]
            codes = [client.get(f"{base}/api/jobs/history", params=params, timeout=30).status_code for params in bad]
            check("任务分页空结果和超大页码安全，非法参数明确422",
                  last["page"] == 6 and len(last["items"]) == 5
                  and empty["page"] == 1 and empty["pages"] == 0 and empty["items"] == []
                  and codes == [422] * len(bad), str(codes))

            _redis("HSET", keys[0], "state", "running", "done", 5, "total", 9, "message", "Redis最新进度")
            _redis("HSET", keys[1], "state", "running", "done", 999, "total", 999, "error", "", "message", "过期缓存")
            for key in keys:
                _redis("EXPIRE", key, 300)
            live = get(f"/api/jobs/{rows[0]['short_id']}")
            terminal = get(f"/api/jobs/{rows[7]['short_id']}")
            check("进行中详情使用实时进度，数据库终态不被Redis旧running覆盖",
                  live["state"] == "running" and live["done"] == 5 and live["total"] == 9
                  and terminal["state"] == "error" and terminal["done"] == 3
                  and terminal["error"] == "容器重启导致任务中断")

            response = client.get(f"{base}/api/jobs/{rows[4]['short_id']}/report", params={"format": "json"}, timeout=30)
            response.raise_for_status()
            report = response.json()
            complete = report["completeness"]
            check("任务报告导出已保存500条结果并明确原540条被截断",
                  report["report_type"] == "job_result" and report["report_scope"] == "saved_result"
                  and "attachment" in response.headers.get("Content-Disposition", "")
                  and json.loads(report["job"]["result"]) == rows[4]["result"]
                  and report["parsed_result"] == rows[4]["result"]
                  and complete["details_saved"] == 500 and complete["details_total"] == 540
                  and complete["details_truncated"] is True)
            legacy = get(f"/api/jobs/{rows[5]['short_id']}/report", format="json")
            check("旧任务没有完整性元数据时保留未知，不凭500条猜完整",
                  legacy["completeness"]["details_saved"] == 500
                  and legacy["completeness"]["details_total"] is None
                  and legacy["completeness"]["details_truncated"] is None
                  and len(legacy["parsed_result"]["details"]) == 500)
            unusual = get(f"/api/jobs/{rows[6]['short_id']}/report", format="json")
            running_report = get(f"/api/jobs/{rows[0]['short_id']}/report", format="json")
            check("非对象结果原样保留，进行中报告不编造最终结果",
                  unusual["parsed_result"] == rows[6]["result"]
                  and json.loads(unusual["job"]["result"]) == rows[6]["result"]
                  and running_report["job"]["state"] == "running"
                  and running_report["parsed_result"] is None and running_report["job"]["result"] == "")
            moved = get(f"/api/jobs/{rows[8]['short_id']}/report", format="json")
            scanned = get(f"/api/jobs/{rows[9]['short_id']}/report", format="json")
            check("移动和扫描报告保留真实失败项，不虚构未保存的成功路径",
                  moved["parsed_result"] == rows[8]["result"] and moved["completeness"]["failures_saved"] == 1
                  and "moved_paths" not in moved["parsed_result"] and moved["completeness"]["note"]
                  and scanned["completeness"]["errors_saved"] == 20 and scanned["completeness"]["note"])
            check("报告格式与未知任务正确报错",
                  client.get(f"{base}/api/jobs/{rows[0]['short_id']}/report", params={"format": "csv"}, timeout=30).status_code == 422
                  and client.get(f"{base}/api/jobs/not-a-job/report", timeout=30).status_code == 404)
            old_cursor = watch["cursor"]
            _postgres(f"UPDATE jobs SET updated_at=to_timestamp({anchor + 300}) WHERE id='{rows[3]['id']}'::uuid;")
            latest = get("/api/jobs")["latest_completed_watch"]
            check("历史筛选之外的自动扫描新完成更新游标，重复读取稳定",
                  latest["id"] == rows[3]["short_id"] and latest["cursor"] != old_cursor
                  and get("/api/jobs")["latest_completed_watch"]["cursor"] == latest["cursor"])
        finally:
            _postgres(f"DELETE FROM jobs WHERE id IN ({ids_sql});")
            for key in keys:
                _redis("DEL", key)
