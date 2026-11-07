"""Album detail and whole-group selection against real HTTP, PG and FLAC.

Every SQL mutation targets a scanned fixture ID and its exact fixture path.
The immutable selection contains more than 1000 members; subsequent group
changes must reject its old revision without changing any audio file.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import requests
from mutagen.flac import FLAC

from tests.audiofix import make_flac
from tests.cover_acceptance import image_bytes, replace_cover
from tests.jobs_acceptance import _postgres


def check_album_detail(base: str, music: Path, check, wait_job) -> None:
    root = music / "__album_detail_acceptance__"
    music_path = music.resolve()
    assert root.resolve().parent == music_path and not root.exists()
    root.mkdir()
    prefix = root.name
    album = f'{prefix} 合辑 100%_Mix! "双引号" / 单引号\''
    artist = "Various Artists / 合辑"
    group = [album, artist]
    holding_album = f"{prefix} 保留组"
    count = 1005
    files: list[Path] = []
    fixture_rows: dict[int, dict] = {}

    def literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    def patch_sql(track_id: int, **values) -> str:
        row = fixture_rows[track_id]
        path = Path(row["path"])
        assert path.parent.resolve() == root.resolve()
        assert set(values) <= {"album", "albumartist", "artist", "disc", "track", "title", "has_cover"}
        assignments = ", ".join(f"{key} = " + ("TRUE" if value is True else "FALSE" if value is False
                                                else literal(str(value))) for key, value in values.items())
        return f"UPDATE tracks SET {assignments} WHERE id={track_id} AND path={literal(str(path))};"

    def patch(track_id: int, **values) -> None:
        _postgres(patch_sql(track_id, **values))

    def fingerprint(path: Path):
        return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns

    def number(value: str, fallback):
        first = value.split("/", 1)[0].strip(" ")
        return int(first) if re.fullmatch(r"[0-9]{1,9}", first) else fallback

    def track_order(row: dict):
        track = number(row["track"], None)
        return number(row["disc"], 1), track is None, track if track is not None else 0, row["id"]

    with requests.Session() as client:
        def get(route: str, **params):
            response = client.get(f"{base}{route}", params=params, timeout=60)
            response.raise_for_status()
            return response.json()

        def post(route: str, payload: dict):
            response = client.post(f"{base}{route}", json=payload, timeout=60)
            response.raise_for_status()
            return response.json()

        def scan(*, prune=False):
            job = wait_job(post("/api/scan", {"root": root.name, "full": True, "prune": prune})["job_id"])
            if job["state"] != "done":
                raise RuntimeError(f"Album-detail fixture scan failed: {job}")

        def detail(key=group, **params):
            return get("/api/albums/detail", album_group=json.dumps(key, ensure_ascii=False), **params)

        def selection(revision: str, key=group):
            return post("/api/albums/selection", {"album_group": key, "revision": revision})

        def selection_status(revision: str, key=group):
            return client.post(f"{base}/api/albums/selection",
                               json={"album_group": key, "revision": revision}, timeout=60).status_code

        def scoped_tracks(key=group):
            first = get("/api/tracks", album_group=json.dumps(key, ensure_ascii=False),
                        sort="disc_track", page_size=1000)
            rows = list(first["items"])
            for page in range(2, first["pages"] + 1):
                rows.extend(get("/api/tracks", album_group=json.dumps(key, ensure_ascii=False),
                                sort="disc_track", page_size=1000, page=page)["items"])
            return rows

        try:
            # Reserve one of the lowest assigned IDs after scanning. A later
            # same-count membership swap then also preserves the group's max ID.
            for ordinal in range(count + 1):
                path = make_flac(root / f"main-{ordinal:04}.flac")
                audio = FLAC(path)
                audio.info.total_samples = 44100 * (ordinal % 5 + 1)
                audio["title"] = [f"专辑曲目 {ordinal:04}"]
                audio["artist"] = [f"合辑歌手 {ordinal % 3}"]
                audio["album"] = [album]
                audio["albumartist"] = [artist]
                audio["discnumber"] = [str(ordinal // 300 + 1)]
                audio["tracknumber"] = [str(ordinal % 300 + 1)]
                audio["date"] = ["2024"]
                audio["x-album-detail-preserve"] = ["没有请求写入的标签"]
                if ordinal % 2 == 0:
                    audio["lyrics"] = ["[00:00.00] 合辑验收歌词"]
                audio.save()
                files.append(path)
            replace_cover(files[0], image_bytes("PNG", (20, 20)), "image/png", (20, 20))
            replace_cover(files[20], image_bytes("PNG", (20, 20), alternate=True), "image/png", (20, 20))
            extras = {
                "other-artist": (album, "同名专辑的另一位艺术家"),
                "blank-artist": (f"{prefix} 未知艺术家", ""),
                "ascii-spaces": (f"{prefix} ASCII", "Fallback Artist"),
                "unicode-spaces": (f"{prefix} Unicode", "Unicode Artist"),
            }
            for name, (title, album_artist) in extras.items():
                path = make_flac(root / f"{name}.flac")
                audio = FLAC(path)
                audio["title"] = [name]
                audio["album"] = [title]
                audio["albumartist"] = [album_artist]
                audio["artist"] = [album_artist]
                audio.save()
            scan()
            first = get("/api/tracks", q=root.name, page_size=1000, sort="path")
            rows = list(first["items"])
            for page in range(2, first["pages"] + 1):
                rows.extend(get("/api/tracks", q=root.name, page_size=1000, sort="path", page=page)["items"])
            assert len(rows) == count + 1 + len(extras), f"Incomplete album fixtures: {len(rows)}"
            fixture_rows = {row["id"]: row for row in rows}
            main_rows = sorted((row for row in rows if row["filename"].startswith("main-")), key=lambda row: row["id"])
            reserved = main_rows.pop(0)
            patch(reserved["id"], album=holding_album)
            extra_rows = {Path(row["filename"]).stem: row for row in rows if not row["filename"].startswith("main-")}

            # These raw legacy tags cannot all survive normal audio parsing;
            # seed only their index fields to exercise the numeric SQL guard.
            for row, disc, track in zip(main_rows[:7], ["1/4", "1", "", "side A", "2", "999999999999", "01"],
                                        ["10/24", "2/24", "", "side B", "1", "999999999999", "002"]):
                patch(row["id"], disc=disc, track=track)
                row.update(disc=disc, track=track)
            ascii_group = [f"{prefix} ASCII", "Fallback Artist"]
            unicode_group = [f"\u3000{prefix} Unicode\u3000", "\u3000Unicode Artist\u3000"]
            patch(extra_rows["ascii-spaces"]["id"], album=f" {ascii_group[0]} ", albumartist="   ", artist=" Fallback Artist ")
            patch(extra_rows["unicode-spaces"]["id"], album=unicode_group[0], albumartist=unicode_group[1])
            expected = [row["id"] for row in sorted(main_rows, key=track_order)]
            before = {path.name: fingerprint(path) for path in root.iterdir()}

            pages = [detail(page=page, page_size=200) for page in range(1, 7)]
            all_items = [item for page in pages for item in page["items"]]
            revision = pages[0]["revision"]
            check("专辑详情超过1000首完整分页，碟号音轨按数字及稳定ID排序",
                  [item["id"] for item in all_items] == expected
                  and all(page["total"] == count and page["page"] == ordinal and page["pages"] == 6
                          and page["page_size"] == 200 and page["group"] == group
                          and page["revision"] == revision for ordinal, page in enumerate(pages, 1))
                  and [row["id"] for row in scoped_tracks()] == expected)
            summaries = get("/api/albums", q=prefix, page_size=100)["items"]
            summary = next(item for item in summaries if [item["album"], item["album_artist"]] == group)
            check("详情概况与专辑收藏共享汇总，同名不同艺术家的曲目不混组",
                  all(page["summary"] == summary for page in pages)
                  and summary["track_count"] == count and summary["year"] == "2024"
                  and summary["bytes"] == sum(row["size"] for row in main_rows)
                  and abs(summary["duration"] - sum(row["duration"] for row in main_rows)) < .001
                  and detail([album, extras["other-artist"][1]])["total"] == 1
                  and extra_rows["other-artist"]["id"] not in expected)
            selected = selection(revision)
            check("整张专辑选择一次返回全部有序ID，版本和数量不受列表上限影响",
                  selected["group"] == group and selected["ids"] == expected and selected["total"] == count
                  and selected["revision"] == revision and selected["selected_at"] > 0
                  and re.fullmatch(r"[0-9a-f]{32}", revision) is not None
                  and set(selected) == {"group", "revision", "total", "ids", "selected_at"}
                  and selection(revision)["ids"] == expected)
            resolved = [post("/api/tracks/selection", {"ids": selected["ids"], "page": page, "page_size": 200})
                        for page in range(1, 7)]
            resolved_items = [item for page in resolved for item in page["items"]]
            check("整组ID可完整交给已选审阅核对，响应只有索引信息",
                  [item["id"] for item in resolved_items] == expected
                  and all(item["status"] == "found" and item["track"]["id"] == item["id"] for item in resolved_items)
                  and all("file_exists" not in item["track"] for item in resolved_items)
                  and all("file_exists" not in item for item in all_items))
            check("专辑详情分页默认100首，负页和超大页安全夹取",
                  detail()["page_size"] == 100 and detail()["pages"] == 11
                  and detail(page=-5, page_size=200)["items"] == pages[0]["items"]
                  and detail(page=9223372036854775807, page_size=200)["items"] == pages[-1]["items"])
            blank_group = [extras["blank-artist"][0], ""]
            unicode_absent = [unicode_group[0].strip(), unicode_group[1].strip()]
            absent_response = client.get(f"{base}/api/albums/detail",
                                         params={"album_group": json.dumps(unicode_absent)}, timeout=30)
            check("空专辑艺术家和ASCII空格兼容，Unicode空格与引号保留精确身份",
                  detail(blank_group)["items"][0]["id"] == extra_rows["blank-artist"]["id"]
                  and detail([f" {ascii_group[0]} ", f" {ascii_group[1]} "])["group"] == ascii_group
                  and detail(unicode_group)["group"] == unicode_group and absent_response.status_code == 404
                  and selection(revision, [f" {album} ", f" {artist} "])["ids"] == expected)
            bad_queries = [{}, {"album_group": "[]"}, {"album_group": json.dumps([" ", "A"])},
                           {"album_group": json.dumps(["A", "B", "C"])},
                           {"album_group": json.dumps(["x" * 4001, "A"])},
                           {"album_group": json.dumps(group), "page_size": 0},
                           {"album_group": json.dumps(group), "page_size": 201},
                           {"album_group": json.dumps(group), "page": "NaN"}]
            query_codes = [client.get(f"{base}/api/albums/detail", params=params, timeout=30).status_code
                           for params in bad_queries]
            bad_bodies = [{}, {"album_group": group}, {"album_group": json.dumps(group), "revision": revision},
                          {"album_group": group, "revision": None}, {"album_group": group, "revision": "x" * 32},
                          {"album_group": group, "revision": "a" * 31}]
            body_codes = [client.post(f"{base}/api/albums/selection", json=payload, timeout=30).status_code
                          for payload in bad_bodies]
            absent = [f"{prefix} absent", ""]
            check("详情和整组选中严格校验参数，未知组404与过期版本409明确区分",
                  query_codes == [422] * len(bad_queries) and body_codes == [422] * len(bad_bodies)
                  and client.get(f"{base}/api/albums/detail", params={"album_group": json.dumps(absent)}, timeout=30).status_code == 404
                  and selection_status(revision, absent) == 404 and selection_status("0" * 32) == 409,
                  f"query={query_codes}, body={body_codes}")

            offline_row = main_rows[-10]
            offline_source = Path(offline_row["path"])
            offline = offline_source.with_suffix(".offline")
            offline_source.rename(offline)
            check("专辑音频离线时详情与整组选中仍只查索引，不改文件",
                  detail(page_size=200)["summary"] == summary and selection(revision)["ids"] == expected
                  and all(fingerprint(path if path.exists() else offline) == before[path.name]
                          for path in (Path(row["path"]) for row in rows)))
            offline.rename(offline_source)

            # Nonmembership metadata changes update the detail but intentionally
            # do not imply a file lock or expire the member/order revision.
            edited = main_rows[10]
            patch(edited["id"], title="只修改索引标题", has_cover=not bool(edited["has_cover"]))
            updated = detail()
            check("标题与封面标记更新不伪称范围变化，成员版本保持稳定",
                  updated["revision"] == revision and selection(revision)["ids"] == expected
                  and updated["summary"]["missing_cover"] != summary["missing_cover"])
            patch(edited["id"], title=edited["title"], has_cover=bool(edited["has_cover"]))
            reordered = main_rows[11]
            patch(reordered["id"], disc="9", track="999")
            changed = detail()
            check("修改碟号音轨使旧版本失效，新选择使用新曲序",
                  changed["revision"] != revision and selection_status(revision) == 409
                  and selection(changed["revision"])["ids"][-1] == reordered["id"])
            patch(reordered["id"], disc=reordered["disc"], track=reordered["track"])
            assert detail()["revision"] == revision

            outgoing = main_rows[0]
            _postgres("BEGIN;" + patch_sql(outgoing["id"], album=holding_album)
                      + patch_sql(reserved["id"], album=album) + "COMMIT;")
            swapped = detail()
            swapped_ids = selection(swapped["revision"])["ids"]
            check("同数量同最大ID替换成员仍使旧版本409，不只比较计数或时间",
                  swapped["total"] == count and len(swapped_ids) == count and max(swapped_ids) == max(expected)
                  and set(swapped_ids) == ((set(expected) - {outgoing["id"]}) | {reserved["id"]})
                  and swapped["revision"] != revision and selection_status(revision) == 409)
            _postgres("BEGIN;" + patch_sql(outgoing["id"], album=album)
                      + patch_sql(reserved["id"], album=holding_album) + "COMMIT;")
            assert detail()["revision"] == revision
            patch(reserved["id"], album=album)
            added = detail()
            check("新增成员不会悄悄加入旧范围，旧版本要求刷新",
                  added["total"] == count + 1 and selection_status(revision) == 409
                  and reserved["id"] in selection(added["revision"])["ids"])
            patch(reserved["id"], album=holding_album)
            check("移除成员使新增后的版本失效，已返回ID快照保持原值",
                  selection_status(added["revision"]) == 409 and detail()["revision"] == revision
                  and selected["ids"] == expected)

            index_definition = _postgres("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() "
                                         "AND indexname='idx_tracks_album_group_hash';").lower()
            check("专辑分组索引使用固定长度摘要键，避免新增长文本BTree键限制",
                  index_definition.count("md5(") == 2 and "btrim(album)" in index_definition
                  and "coalesce" in index_definition and "btrim(albumartist)" in index_definition
                  and "btrim(artist)" in index_definition and "where" in index_definition)
            check("专辑浏览和范围准备及索引变化未改写任何真实音频",
                  before == {path.name: fingerprint(path) for path in root.iterdir()})

            # A selected ID stays in the client snapshot after scoped pruning;
            # 0.20 resolves it as missing rather than expanding to current members.
            pruned = main_rows[-2]
            Path(pruned["path"]).unlink()
            scan(prune=True)
            resolved = [post("/api/tracks/selection", {"ids": selected["ids"], "page": page, "page_size": 200})
                        for page in range(1, 7)]
            resolved_items = [item for page in resolved for item in page["items"]]
            check("专辑范围快照交接后索引被清理，已选核对保留缺失ID且不换成新成员",
                  [item["id"] for item in resolved_items] == expected
                  and [item["id"] for item in resolved_items if item["status"] == "missing"] == [pruned["id"]]
                  and all(page["found_total"] == count - 1 and page["missing_total"] == 1 for page in resolved)
                  and reserved["id"] not in selected["ids"] and selection_status(revision) == 409)
        finally:
            assert root.resolve().parent == music_path and root.resolve() != music_path
            for path in root.iterdir():
                assert path.parent == root and path.is_file(), f"Unexpected album-detail fixture entry: {path}"
                path.unlink()
            try:
                scan(prune=True)
            finally:
                root.rmdir()
