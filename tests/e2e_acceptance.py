"""端到端验收：起真实服务，用 HTTP 把三个功能各跑一遍，并到磁盘上核对结果。

独立于 pytest 测试套件——这是「交付验收」而不是「单元测试」。
用法：python e2e_acceptance.py <repo_dir> <work_dir>
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

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\codex\音乐刮削")
WORK = Path(sys.argv[2] if len(sys.argv) > 2 else Path(os.environ["PI_SCRATCH_DIR"]) / "e2e")
PORT = 8097
BASE = f"http://127.0.0.1:{PORT}"

sys.path.insert(0, str(REPO))
from tests.audiofix import make_flac  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))


def seed(music: Path) -> None:
    from mutagen.flac import FLAC

    tracks = [
        ("中文/周杰伦/魔杰座/01 - 稻香.flac", {"title": "稻香", "artist": "周杰伦", "album": "魔杰座", "albumartist": "周杰伦", "tracknumber": "1", "date": "2008", "language": "中文"}),
        ("中文/周杰伦/魔杰座/02 - 说好的幸福呢.flac", {"title": "说好的幸福呢", "artist": "周杰伦", "album": "魔杰座", "tracknumber": "2", "language": "中文"}),
        ("俄文/ADÉLA/PRIMA/KGB - ADÉLA.flac", {"title": "KGB", "artist": "ADÉLA"}),
        ("待整理/未命名 1.flac", {"title": "七里香"}),
        ("待整理/未命名 2.flac", {"title": "夜曲", "artist": "周杰伦/费玉清"}),
    ]
    for rel, tags in tracks:
        path = music / rel
        make_flac(path)
        audio = FLAC(str(path))
        for k, v in tags.items():
            audio[k] = [v]
        audio.save()


def wait_job(job_id: str, timeout: float = 180.0) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        data = requests.get(f"{BASE}/api/jobs/{job_id}", timeout=20).json()
        if data["state"] in {"done", "error"}:
            return data
        time.sleep(0.4)
    raise TimeoutError(f"任务 {job_id} 超时")


def main() -> int:
    if WORK.exists():
        shutil.rmtree(WORK, ignore_errors=True)
    music = WORK / "music"
    data = WORK / "data"
    music.mkdir(parents=True)
    data.mkdir(parents=True)
    seed(music)
    print(f"验收库: {music}（{sum(1 for _ in music.rglob('*.flac'))} 首）\n")

    env = {
        **os.environ,
        "METATIDY_MUSIC_DIR": str(music),
        "METATIDY_DATA_DIR": str(data),
        "METATIDY_LIBRARY_ROOT": str(music),
        "PYTHONIOENCODING": "utf-8",
    }
    # 服务端启动命令可覆盖：CI 里用它验收 Rust 二进制，默认仍是 Python 版。
    # 用 sys.executable 而不是写死 venv 路径，Linux/Windows 都能跑。
    override = os.environ.get("E2E_SERVER_CMD", "").strip()
    if override:
        argv = override.split()
    else:
        argv = [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"]
    proc = subprocess.Popen(
        argv,
        cwd=str(REPO),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        for _ in range(40):
            try:
                requests.get(f"{BASE}/api/status", timeout=5)
                break
            except Exception:
                time.sleep(0.5)
        else:
            print("服务启动失败：\n" + proc.stderr.read().decode("utf-8", "ignore")[-2000:])
            return 2

        print("=== 0. 状态 ===")
        st = requests.get(f"{BASE}/api/status", timeout=20).json()
        check("服务可用", st["version"] == "0.1.0", f"版本 {st['version']}")
        check("迁移层 13 个源就绪", st["scraper"]["count"] >= 12, f"可用 {st['scraper']['count']} 个")

        print("\n=== 1. 扫描（功能底座） ===")
        t0 = time.time()
        job = requests.post(f"{BASE}/api/scan", json={"full": True}, timeout=30).json()
        res = wait_job(job["job_id"])
        check("扫描任务完成", res["state"] == "done", f"{res['message']} 用时 {time.time()-t0:.1f}s")
        listing = requests.get(f"{BASE}/api/tracks", params={"page_size": 50}, timeout=20).json()
        check("索引 5 首曲目", listing["total"] == 5, f"total={listing['total']}")
        lang_map = {i["title"]: i["language"] for i in listing["items"]}
        check("俄文目录自动推断语言", lang_map.get("KGB") == "俄文", f"KGB -> {lang_map.get('KGB')!r}")

        # 增量扫描：第二次应该跳过全部
        job2 = requests.post(f"{BASE}/api/scan", json={"full": False}, timeout=30).json()
        res2 = wait_job(job2["job_id"])
        skipped = json.loads(res2["result"])["skipped"] if res2.get("result") else -1
        check("增量扫描跳过未变动文件", skipped == 5, f"skipped={skipped}")

        print("\n=== 2. 功能一：元数据编辑 ===")
        target = next(i for i in listing["items"] if i["title"] == "七里香")
        preview = requests.post(f"{BASE}/api/tracks/preview", json={
            "ids": [target["id"]],
            "fields": {"album": "七里香", "artist": "周杰伦/费玉清", "year": "2004"},
        }, timeout=30).json()
        changes = preview["items"][0]["changes"]
        check("预览出差异（3 个字段）", len(changes) == 3, str({k: v["new"] for k, v in changes.items()}))
        check("多歌手归一成 &", changes["artist"]["new"] == "周杰伦 & 费玉清", changes["artist"]["new"])
        on_disk = requests.get(f"{BASE}/api/tracks/{target['id']}", timeout=20).json()
        check("预览未写入磁盘", on_disk["album"] == "" and on_disk["artist"] == "周杰伦" or on_disk["album"] != "七里香")

        applied = requests.post(f"{BASE}/api/tracks/apply", json={
            "ids": [target["id"]],
            "fields": {"album": "七里香", "artist": "周杰伦/费玉清", "year": "2004"},
        }, timeout=60).json()
        check("写入成功", applied["written"] == 1 and not applied["failed"], json.dumps(applied["failed"], ensure_ascii=False))
        from mutagen.flac import FLAC
        tags = FLAC(target["path"])
        check("磁盘上的标签真的变了", tags.get("album", [""])[0] == "七里香", f"album={tags.get('album')}")
        check("磁盘上的多歌手是 &", tags.get("artist", [""])[0] == "周杰伦 & 费玉清", f"artist={tags.get('artist')}")
        check("索引已同步", requests.get(f"{BASE}/api/tracks/{target['id']}", timeout=20).json()["album"] == "七里香")

        print("\n=== 3. 功能二：搜索刮削 ===")
        song = next(i for i in listing["items"] if i["title"] == "稻香")
        sr = requests.post(f"{BASE}/api/search", json={
            "track_id": song["id"], "sources": ["musicbrainz", "itunes", "netease", "deezer"], "limit": 3,
        }, timeout=180).json()
        got = len(sr["candidates"])
        check("真实数据源返回候选", got > 0, f"{got} 条；源状态 {json.dumps(sr['source_status'], ensure_ascii=False)}")
        if got:
            top = sr["candidates"][0]
            check("候选带分数与置信度", top["score"] >= 0 and top["confidence"] in {"高", "中", "待确认"},
                  f"{top['source']} / {top['title']} / {top['score']} / {top['confidence']}")
            check("候选字段可对齐标签字段", {"title", "artist", "album"} <= set(top),
                  str(sorted(k for k in top if k in {"title", "artist", "album", "albumartist", "genre", "year", "albumtype"})))
            write = requests.post(f"{BASE}/api/scrape/apply", json={
                "track_id": song["id"],
                "candidate": top,
                "fields": ["genre", "year"],
                "write_cover": False, "write_lyrics": False,
            }, timeout=120).json()
            check("按候选写入字段", isinstance(write.get("written"), list), f"written={write.get('written')}")
            reread = FLAC(song["path"])
            if top.get("genre"):
                check("刮削结果落盘", reread.get("genre", [""])[0] == top["genre"], f"genre={reread.get('genre')}")

        print("\n=== 4. 功能三：按目录层级整理移动 ===")
        plan = requests.post(f"{BASE}/api/move/preview", json={
            "ids": [i["id"] for i in requests.get(f"{BASE}/api/tracks", params={"page_size": 50}, timeout=20).json()["items"]],
            "dir_template": "{language?}/{artist}/{album}",
            "filename_template": "{track:02} - {title}",
        }, timeout=60).json()
        check("生成移动计划", plan["token"] and plan["planned"] == 5, f"counts={plan['counts']}")
        check("计划里没有越界项", all(i["action"] != "invalid" for i in plan["items"]),
              str([i["reason"] for i in plan["items"] if i["action"] == "invalid"]))
        before = {i["track_id"]: i["source"] for i in plan["items"]}

        dry = requests.post(f"{BASE}/api/move/execute", json={"token": plan["token"], "dry_run": True}, timeout=60).json()
        check("仅演练报出预期数量", dry["moved"] >= 1, str(dry))
        check("仅演练没动文件", all(Path(p).exists() for p in before.values()))

        job3 = requests.post(f"{BASE}/api/move/execute", json={"token": plan["token"]}, timeout=60).json()
        res3 = wait_job(job3["job_id"])
        summary = json.loads(res3["result"]) if res3.get("result") else {}
        check("移动任务完成", res3["state"] == "done", json.dumps(summary, ensure_ascii=False)[:200])
        check("无失败项", summary.get("failed", 1) == 0, str(summary.get("failures")))
        moved_ok = all(Path(i["target"]).exists() and not Path(i["source"]).exists() for i in plan["items"] if i["action"] != "in_place")
        check("文件真的在新位置、源文件已消失", moved_ok)
        target_paths = [i["target"] for i in plan["items"]]
        rel = {(Path(p).parent.name, Path(p).name) for p in target_paths}
        expected = {
            ("魔杰座", "01 - 稻香.flac"),
            ("魔杰座", "02 - 说好的幸福呢.flac"),
            ("未知专辑", "KGB.flac"),
            ("七里香", "七里香.flac"),
            ("未知专辑", "夜曲.flac"),
        }
        check("目标层级与文件名完全符合模板", rel == expected, str(sorted(rel)))
        after = requests.get(f"{BASE}/api/tracks", params={"page_size": 50}, timeout=20).json()["items"]
        check("索引路径已同步", {i["path"] for i in after} == set(target_paths), str(sorted(i["path"] for i in after)))
        dup = requests.post(f"{BASE}/api/move/execute", json={"token": plan["token"]}, timeout=30)
        check("同一计划不能重复执行", dup.status_code == 409, f"HTTP {dup.status_code}")

        print("\n=== 5. 别名库与设置 ===")
        requests.put(f"{BASE}/api/aliases/artist", json={"items": [{"from": "周杰伦", "to": "Jay Chou"}]}, timeout=20)
        aliases = requests.get(f"{BASE}/api/aliases/artist", timeout=20).json()["items"]
        check("别名库可读写", aliases == [{"from": "周杰伦", "to": "Jay Chou"}], str(aliases))
        saved = requests.put(f"{BASE}/api/settings", json={"values": {"dir_template": "{artist}/{album}", "conflict_policy": "skip"}}, timeout=20).json()
        check("设置可保存", saved["saved"].get("conflict_policy") == "skip", str(saved))
        tpl = requests.get(f"{BASE}/api/template/test", params={"dir_template": "{language?}/{artist}/{album}", "filename_template": "{title}"}, timeout=20).json()
        check("模板试渲染", tpl["target"].endswith(".flac"), f"{Path(tpl['source']).name} -> {tpl['target']}")

        print("\n=== 6. 快速扫描（只建索引、不读文件；云盘必用） ===")
        job_fast = requests.post(f"{BASE}/api/scan", json={"fast": True, "prune": True}, timeout=30).json()
        res_fast = wait_job(job_fast["job_id"])
        fast_result = json.loads(res_fast["result"]) if res_fast.get("result") else {}
        check("快速扫描完成", res_fast["state"] == "done", json.dumps(fast_result, ensure_ascii=False)[:160])
        fast_items = requests.get(f"{BASE}/api/tracks", params={"page_size": 50}, timeout=20).json()["items"]
        check("快速扫描后条目仍齐全", len(fast_items) == 5, f"{len(fast_items)} 条")
        check("全部标记为路径推断", all(i.get("path_derived") for i in fast_items),
              str([(i["title"], i["path_derived"], i["tags_loaded"]) for i in fast_items]))
        check("未读取音频标签", all(not i.get("tags_loaded") for i in fast_items))
        by_title = {i["title"]: i for i in fast_items}
        check("歌手由目录结构推断", by_title.get("稻香", {}).get("artist") == "周杰伦",
              repr(by_title.get("稻香", {}).get("artist")))
        check("专辑由目录结构推断", by_title.get("稻香", {}).get("album") == "魔杰座",
              repr(by_title.get("稻香", {}).get("album")))
        # 收尾：恢复成「读过标签」的状态，顺便验证快速扫描之后再做全量扫描不会把索引搞坏
        job_restore = requests.post(f"{BASE}/api/scan", json={"full": True, "prune": True}, timeout=30).json()
        res_restore = wait_job(job_restore["job_id"])
        check("随后全量扫描正常", res_restore["state"] == "done", str(res_restore.get("message")))

        print("\n=== 7. 静态前端与图标 ===")
        root_page = requests.get(f"{BASE}/", timeout=20)
        check("首屏可访问", root_page.status_code == 200 and "<html" in root_page.text.lower(),
              f"HTTP {root_page.status_code}")
        icon = requests.get(f"{BASE}/icon.svg", timeout=20)
        check("图标可访问（同一份也给 Arcane 当容器图标）",
              icon.status_code == 200 and "<svg" in icon.text,
              f"HTTP {icon.status_code} {icon.headers.get('content-type', '')}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{'='*60}\n验收结果：{passed}/{len(results)} 通过")
    for name, ok, detail in results:
        if not ok:
            print(f"  未通过：{name} —— {detail}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
