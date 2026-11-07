"""Exercise actual filesystem notifications against a real server instance."""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Callable

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac


def check_auto_scan(
    repo: Path,
    work: Path,
    music: Path,
    argv: list[str],
    env: dict[str, str],
    port: int,
    check: Callable[[str, bool, str], None],
) -> None:
    """Start an isolated watcher, publish files, and only use read HTTP calls.

    Uses the existing test database/library after all manual-scan assertions.
    The other test instances explicitly disable automatic scanning.
    """
    base = f"http://127.0.0.1:{port}"
    auto_env = {
        **env,
        "METATIDY_PORT": str(port),
        "METATIDY_PASSWORD": "",
        "METATIDY_AUTH_PASSWORD": "",
        "METATIDY_AUTO_SCAN": "1",
        "METATIDY_AUTO_SCAN_FAST": "0",
        "METATIDY_AUTO_SCAN_DEBOUNCE_SECS": "1",
    }

    def tagged_file(path: Path, title: str, artist: str, album_title: str) -> Path:
        make_flac(path)
        audio = FLAC(str(path))
        audio["title"] = [title]
        audio["artist"] = [artist]
        audio["album"] = [album_title]
        audio.save()
        return path

    # This file predates the watcher. Startup reconciliation must discover it
    # without any new filesystem event or POST /api/scan.
    offline_artist = "启动补扫验收"
    tagged_file(music / "英文" / offline_artist / "停机新增" / "01 - 停机新增.flac",
                "停机期间加入的收藏", offline_artist, "停机新增")
    log_path = work / "auto-scan-server.log"
    with log_path.open("wb") as log:
        proc = subprocess.Popen(argv, cwd=repo, env=auto_env, stdout=log, stderr=subprocess.STDOUT)
        try:
            # Starting the watcher performs one safe reconciliation. Wait for
            # that job to finish before taking the baseline for file events.
            baseline_job_id = None
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f"自动扫描实例提前退出：{proc.returncode}")
                try:
                    status = requests.get(f"{base}/api/status", timeout=5).json().get("auto_scan", {})
                    baseline_job_id = status.get("last_job_id")
                    if status.get("watching") and status.get("state") == "watching" and baseline_job_id:
                        initial_job = requests.get(f"{base}/api/jobs/{baseline_job_id}", timeout=5).json()
                        if initial_job.get("state") == "done" and not status.get("pending_scopes"):
                            break
                except requests.RequestException:
                    pass
                time.sleep(.3)
            else:
                raise TimeoutError("自动扫描未进入监听空闲状态，或启动增量扫描未完成")

            check("自动扫描监听真实目录并完成启动增量检查", True, f"job={baseline_job_id}")
            caught_up = requests.get(f"{base}/api/tracks", params={"q": offline_artist, "page_size": 50}, timeout=10).json()["items"]
            check("服务启动自动补扫停机期间新增的音乐",
                  len(caught_up) == 1 and caught_up[0].get("title") == "停机期间加入的收藏"
                  and caught_up[0].get("language") == "英文" and caught_up[0].get("tags_loaded"),
                  str([(row["title"], row.get("language")) for row in caught_up]))
            baseline = requests.get(f"{base}/api/jobs", timeout=10).json()["jobs"]
            baseline_ids = {job["id"] for job in baseline}
            prefix = "自动监听验收"
            album = music / "日文" / prefix / "测试专辑"
            album.mkdir(parents=True, exist_ok=True)

            def publish(filename: str, title: str) -> Path:
                destination = album / filename
                temporary = destination.with_suffix(".uploading")
                tagged_file(temporary, title, prefix, "测试专辑")
                os.replace(temporary, destination)
                return destination

            first_path = publish("01 - 新收藏.flac", "第一首")
            publish("02 - 新收藏.flac", "第二首")
            # Several writes during the same debounce window must converge to
            # the final tags, with no duplicate index rows.
            for title in ("尚在写入", "第一首最终标签"):
                audio = FLAC(str(first_path))
                audio["title"] = [title]
                audio.save()

            observed_max_running = 0

            def wait_for_titles(expected: set[str]) -> list[dict]:
                nonlocal observed_max_running
                end = time.monotonic() + 60
                while time.monotonic() < end:
                    rows = requests.get(f"{base}/api/tracks", params={"q": prefix, "page_size": 50}, timeout=10).json()["items"]
                    jobs = requests.get(f"{base}/api/jobs", timeout=10).json()["jobs"]
                    fresh_jobs = [job for job in jobs if job["id"] not in baseline_ids and job["kind"] == "scan"]
                    observed_max_running = max(observed_max_running, sum(job["state"] == "running" for job in fresh_jobs))
                    failed = [job for job in fresh_jobs if job["state"] == "error"]
                    if failed:
                        raise RuntimeError(f"自动扫描失败：{failed[0].get('error')}")
                    status = requests.get(f"{base}/api/status", timeout=10).json().get("auto_scan", {})
                    if expected <= {row["title"] for row in rows} and status.get("state") == "watching" and not status.get("pending_scopes"):
                        return rows
                    time.sleep(.3)
                raise TimeoutError(f"文件事件未自动收敛到所需索引：{sorted(expected)}")

            indexed = wait_for_titles({"第一首最终标签", "第二首"})
            check("新增与连续写入无需手动扫描，最终标签自动进入索引",
                  len(indexed) == 2 and all(row.get("tags_loaded") for row in indexed),
                  str([(row["title"], row.get("tags_loaded")) for row in indexed]))
            check("自动子目录扫描仍按曲库根目录推断语言",
                  all(row.get("language") == "日文" for row in indexed),
                  str([(row["title"], row.get("language")) for row in indexed]))
            fresh_jobs = requests.get(f"{base}/api/jobs", timeout=10).json()["jobs"]
            fresh_jobs = [job for job in fresh_jobs if job["id"] not in baseline_ids and job["kind"] == "scan"]
            watch_jobs = [job for job in fresh_jobs if json.loads(job.get("result") or "{}").get("trigger") == "watch"]
            check("自动扫描任务可识别，事件批次未重复新增曲目",
                  bool(watch_jobs) and all(job["state"] == "done" for job in watch_jobs)
                  and observed_max_running <= 1 and len({row["id"] for row in indexed}) == 2,
                  f"watch jobs={len(watch_jobs)}, observed concurrent scans={observed_max_running}")

            # A disappeared file must not cause automatic pruning: cloud-share
            # outages and incomplete notifications should never erase index rows.
            first_id = next(row["id"] for row in indexed if row["title"] == "第一首最终标签")
            first_path.unlink()
            publish("03 - 新收藏.flac", "第三首")
            retained = wait_for_titles({"第一首最终标签", "第二首", "第三首"})
            detail = requests.get(f"{base}/api/tracks/{first_id}", timeout=10).json()
            check("自动扫描不清理已删除文件的索引",
                  len(retained) == 3 and detail.get("id") == first_id and detail.get("file_exists") is False,
                  "第三首已自动索引，暂时缺失的第一首记录仍保留")

            # Moving a whole album into the watched tree may deliver only a
            # directory notification, not one event per song.
            staged_album = (work / "auto-scan-import" / "整张专辑").resolve()
            imported_album = (music / "韩文" / prefix / "整张专辑").resolve()
            if not staged_album.is_relative_to(work.resolve()) or not imported_album.is_relative_to(music.resolve()):
                raise RuntimeError("整目录导入验收路径超出工作目录")
            tagged_file(staged_album / "01 - 整碟第一首.flac", "整碟第一首", prefix, "整张专辑")
            tagged_file(staged_album / "02 - 整碟第二首.flac", "整碟第二首", prefix, "整张专辑")
            imported_album.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged_album, imported_album)
            imported = wait_for_titles({"整碟第一首", "整碟第二首"})
            album_rows = [row for row in imported if row.get("album") == "整张专辑"]
            check("整张专辑目录一次移入也会自动增量入库",
                  len(imported) == 5 and len(album_rows) == 2
                  and all(row.get("tags_loaded") and row.get("language") == "韩文" for row in album_rows),
                  str([(row["title"], row.get("language")) for row in album_rows]))
        except Exception as error:
            log.flush()
            diagnostic = log_path.read_text(encoding="utf-8", errors="replace")[-1500:]
            check("自动扫描真实文件事件验收", False, f"{error}\n{diagnostic}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
