"""后台任务系统。

扫描、批量刮削、整理执行都可能在几千首歌上跑几分钟，绝不能阻塞 HTTP 请求：
- 每个任务一个守护线程，进度写入 SQLite 的 jobs 表
- 前端轮询 `GET /api/jobs/{id}` 拿进度
- 进度写库做节流（默认 400ms 或每 20 项），避免刷爆 WAL
- 同时最多 2 个重任务，避免机械硬盘被并发随机读拖死
"""

from __future__ import annotations

import json
import logging
import threading
import time
import traceback
import uuid
from typing import Any, Callable

from . import db

log = logging.getLogger("metatidy.jobs")

MAX_CONCURRENT_JOBS = 2
_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_JOBS)
_threads: dict[str, threading.Thread] = {}
_lock = threading.Lock()


class Progress:
    """带节流的进度上报器。"""

    def __init__(self, job_id: str, total: int = 0, min_interval: float = 0.4, min_delta: int = 20):
        self.job_id = job_id
        self.total = total
        self.done = 0
        self._last_write = 0.0
        self._last_done = 0
        self._min_interval = min_interval
        self._min_delta = min_delta

    def set_total(self, total: int) -> None:
        self.total = total
        db.job_update(self.job_id, total=total)

    def step(self, n: int = 1, message: str | None = None, force: bool = False) -> None:
        self.done += n
        now = time.time()
        due = force or (now - self._last_write >= self._min_interval) or (self.done - self._last_done >= self._min_delta)
        if not due:
            return
        self._last_write = now
        self._last_done = self.done
        kw: dict[str, Any] = {"done": self.done, "total": self.total}
        if message is not None:
            kw["message"] = message
        db.job_update(self.job_id, **kw)

    def note(self, message: str) -> None:
        db.job_update(self.job_id, message=message)


def start(kind: str, fn: Callable[..., Any], **kwargs: Any) -> str:
    """启动一个后台任务。fn 的签名是 fn(progress, **kwargs)。返回 job_id。"""
    job_id = uuid.uuid4().hex[:12]
    db.job_create(job_id, kind)

    def runner() -> None:
        acquired = _semaphore.acquire(timeout=600)
        if not acquired:
            db.job_update(job_id, state="error", error="等待其它任务超时")
            return
        try:
            payload = db.job_get(job_id) or {}
            db.job_update(job_id, state="running", message="开始")
            progress = Progress(job_id)
            result = fn(progress, **kwargs)
            # 任务结束时补齐 done/total，避免百分比停在节流后的旧值上
            final_total = progress.total or progress.done
            db.job_update(
                job_id,
                state="done",
                message="完成",
                done=final_total,
                total=final_total,
                result=json.dumps(result, ensure_ascii=False) if result is not None else "",
            )
        except Exception as exc:  # noqa: BLE001 —— 任务线程必须吞掉异常并记录
            log.exception("job %s (%s) failed", job_id, kind)
            db.job_update(
                job_id,
                state="error",
                error=f"{type(exc).__name__}: {exc}",
                message=(traceback.format_exc(limit=3) or "")[-500:],
            )
        finally:
            _semaphore.release()
            with _lock:
                _threads.pop(job_id, None)

    t = threading.Thread(target=runner, name=f"job-{kind}-{job_id}", daemon=True)
    with _lock:
        _threads[job_id] = t
    t.start()
    return job_id
