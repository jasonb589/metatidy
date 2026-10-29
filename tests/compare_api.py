# 用途：把「同一套请求」分别打 Python 版与 Rust 版服务端，逐字段比较 JSON 键路径。
# 为什么需要它：端到端验收只覆盖了「前端必需」接口的一部分，这个脚本补上
# 「字段有没有缺」这一层——rust 缺的键会让前端读不到数据，rust 多的键一般无害。
# 用法（需先起好 Postgres 与 Redis；Rust 版需要 DATABASE_URL / REDIS_URL）：
#     python tests/compare_api.py
"""同一套请求分别打 Python 版与 Rust 版服务端，逐字段比较 JSON 键集合。

为什么需要它：端到端验收只覆盖了「前端必需」里的一部分接口。
前端要真能用，`/api/sources`、`/api/settings`、`/api/jobs`、曲目项的字段名等
也必须一致——这个脚本把两边的键路径摆在一起 diff，一眼就能看出缺哪个。

用法：python compare_api.py   （调用者负责先起 PG + Redis）
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

REPO = Path(r"D:\codex\音乐刮削")
SCRATCH = Path(os.environ["PI_SCRATCH_DIR"])
PORT = int(os.environ.get("CMP_PORT", "8099"))
BASE = f"http://127.0.0.1:{PORT}"

sys.path.insert(0, str(REPO))
from tests.audiofix import make_flac  # noqa: E402

ENDPOINTS = [
    ("GET", "/api/status"),
    ("GET", "/api/sources"),
    ("GET", "/api/settings"),
    ("GET", "/api/tracks?page_size=3"),
    ("GET", "/api/jobs"),
    ("GET", "/api/aliases/artist"),
    ("GET", "/api/aliases/album"),
    ("GET", "/api/tracks/999999"),
    ("GET", "/api/move/plan/nope"),
]

# 这些键是 Rust 版**有意**新增/改变的（见 PORT_NOTES 与契约），不当作缺失
KNOWN_DIFFS = {
    "/api/status": {"engine", "postgres", "redis", "db_path", "data_dir"},
    # Rust 侧新增的两个标志（Python 契约里没有），列表项多这两个键是有意的
    "/api/tracks?page_size=3": {"tags_loaded", "path_derived"},
}


def key_tree(obj, prefix=""):
    out = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            out.add(path)
            out |= key_tree(v, path)
    elif isinstance(obj, list) and obj:
        out |= key_tree(obj[0], prefix + "[]")
    return out


def seed(music: Path) -> None:
    from mutagen.flac import FLAC

    if music.exists():
        shutil.rmtree(music, ignore_errors=True)
    path = music / "中文" / "周杰伦" / "魔杰座" / "01 - 稻香.flac"
    make_flac(path)
    audio = FLAC(str(path))
    for k, v in {"title": "稻香", "artist": "周杰伦", "album": "魔杰座",
                 "albumartist": "周杰伦", "tracknumber": "1", "date": "2008"}.items():
        audio[k] = [v]
    audio.save()


def wait_job(job_id: str, timeout: float = 120.0) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        data = requests.get(f"{BASE}/api/jobs/{job_id}", timeout=20).json()
        if data.get("state") in {"done", "error"}:
            return data
        time.sleep(0.3)
    raise TimeoutError(job_id)


def probe(name: str, cmd: str, music: Path) -> dict:
    env = {
        **os.environ,
        "METATIDY_MUSIC_DIR": str(music),
        "METATIDY_LIBRARY_ROOT": str(music),
        "METATIDY_DATA_DIR": str(SCRATCH / f"cmp-{name}-data"),
        "METATIDY_STATIC_DIR": str(SCRATCH / "static"),
        "METATIDY_PORT": str(PORT),
        "PYTHONIOENCODING": "utf-8",
    }
    (SCRATCH / f"cmp-{name}-data").mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(cmd.split(), cwd=str(REPO), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                requests.get(f"{BASE}/api/status", timeout=3)
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise SystemExit(f"{name} 服务端起不来（{cmd}）")

        # 先扫一次，让 items 里真的有曲目（否则比较不到 item 的键）
        job = requests.post(f"{BASE}/api/scan", json={"full": True}, timeout=30).json()
        wait_job(job["job_id"])

        result = {}
        for method, path in ENDPOINTS:
            r = requests.request(method, f"{BASE}{path}", timeout=30)
            try:
                data = r.json()
                keys = sorted(key_tree(data))
            except Exception:
                keys, data = [], None
            result[path] = {"status": r.status_code, "keys": keys}
            print(f"  [{name}] {path} -> HTTP {r.status_code}, {len(keys)} 个键路径")
        return result
    finally:
        proc.terminate()
        time.sleep(1.0)


def main() -> int:
    music = SCRATCH / "cmp-music"
    seed(music)

    py_exe = str(REPO / ".venv" / "Scripts" / "python.exe")
    py_cmd = f"{py_exe} -m uvicorn app.main:app --port {PORT} --log-level warning"
    rust_cmd = f"{SCRATCH}\\target-api\\docker\\metatidy-server.exe"

    print("=== Python 版 ===")
    py = probe("py", py_cmd, music)
    print("=== Rust 版 ===")
    rs = probe("rust", rust_cmd, music)

    print("\n=== 差异（只列键路径与状态码） ===")
    problems = 0
    for method, path in ENDPOINTS:
        a, b = py.get(path, {}), rs.get(path, {})
        if a.get("status") != b.get("status"):
            print(f"  [状态码不同] {path}: python={a.get('status')} rust={b.get('status')}")
            problems += 1
        missing = set(a.get("keys", [])) - set(b.get("keys", [])) - KNOWN_DIFFS.get(path, set())
        extra = set(b.get("keys", [])) - set(a.get("keys", [])) - KNOWN_DIFFS.get(path, set())
        if missing or extra:
            problems += 1
            print(f"  [键不同] {path}")
            if missing:
                print(f"    rust 缺: {sorted(missing)}")
            if extra:
                print(f"    rust 多: {sorted(extra)}")
    if problems == 0:
        print("  没有差异：前端依赖的字段两边完全一致")
    else:
        print(f"  共 {problems} 处差异（上面逐条列出）")
    return 0


sys.exit(main())
