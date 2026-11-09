"""Whole filtered selections against real HTTP/PostgreSQL snapshots.

Fixtures use UUID-owned index rows, including 20,001 members and unavailable
audio paths. No scanner or external service is needed for these contracts.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import requests

from tests.collections_acceptance import _database_snapshot, _literal
from tests.jobs_acceptance import _postgres


def check_filtered_selection(base: str, music: Path, check) -> None:
    marker = f"FilteredSelection-{uuid.uuid4().hex}"
    scope = music.resolve() / marker
    special = scope / "  目录%_!  "
    nested = special / "Disc 2"
    sentinel = scope / "00001.flac"
    assert scope.parent == music.resolve() and not scope.exists()
    before = _database_snapshot()
    ids: list[int] = []
    owned_collections: set[str] = set()
    route = "/api/tracks/filtered-selection"
    keys = {"q", "sort", "order", "artist", "artist_group", "album", "language", "albumtype", "genre", "year",
            "album_group", "folder", "folder_recursive", "missing_cover", "missing_lyrics",
            "no_artist", "no_album", "not_loaded"}

    def disk_snapshot():
        return (hashlib.sha256(sentinel.read_bytes()).hexdigest(), sentinel.stat().st_mtime_ns,
                sorted(path.name for path in scope.iterdir()))

    with requests.Session() as client:
        client.trust_env = False

        def response(query, revision=None):
            payload = {"query": query}
            if revision is not None:
                payload["revision"] = revision
            return client.post(f"{base}{route}", json=payload, timeout=90)

        def good(query, revision=None):
            value = response(query, revision)
            assert value.status_code == 200, f"Filtered selection: HTTP {value.status_code} {value.text[:300]}"
            return value.json()

        def listed(query):
            params = {key: json.dumps(value, ensure_ascii=False) if key == "album_group" else
                      str(value).lower() if isinstance(value, bool) else value
                      for key, value in query.items() if value is not None}
            result = []
            page = 1
            while True:
                fetched = client.get(f"{base}/api/tracks", params={**params, "page": page, "page_size": 1000}, timeout=60)
                fetched.raise_for_status()
                data = fetched.json()
                result.extend(data["items"])
                if page >= data["pages"]:
                    assert len(result) == data["total"]
                    return result
                page += 1

        def rejected(value, code):
            data = value.json()
            return (value.status_code == 409 and data.get("detail", {}).get("code") == code
                    and "items" not in data and "items" not in data.get("detail", {}))

        def set_value(identifier, field, value):
            assert identifier in ids and field in {"title", "artist", "genre", "path", "size", "comment"}
            encoded = str(value) if isinstance(value, int) else _literal(value)
            _postgres(f"UPDATE tracks SET {field}={encoded} WHERE id={identifier};")

        try:
            scope.mkdir()
            sentinel.write_bytes(b"Filtered selection must never parse or rewrite these invalid audio bytes.\n")
            original_disk = disk_snapshot()
            root_sql, special_sql, nested_sql = map(_literal, (str(scope), str(special), str(nested)))
            seeded = json.loads(_postgres(f"""WITH fixture AS (
                SELECT n, lpad(n::text,5,'0') || '.flac' AS name,
                    CASE WHEN n % 3 = 0 THEN {nested_sql} WHEN n % 3 = 2 THEN {special_sql} ELSE {root_sql} END AS directory
                FROM generate_series(1,20001) n), inserted AS (
                INSERT INTO tracks(path,dir,filename,ext,title,artist,album,albumartist,genre,year,
                    language,albumtype,track,disc,has_cover,has_lyrics,tags_loaded,path_derived,size,mtime,indexed_at,edited_at)
                SELECT directory || {_literal(os.sep)} || name,directory,name,'flac',
                    {_literal(marker)} || ' Track ' || lpad(n::text,5,'0'),
                    CASE WHEN n % 11 = 0 THEN '' ELSE {_literal(marker)} || ' Artist ' || (n % 3)::text END,
                    CASE WHEN n % 13 = 0 THEN '   ' ELSE '同名专辑 ' || (n % 2)::text END,
                    CASE WHEN n % 7 = 0 THEN '' ELSE '群星 ' || (n % 3)::text END,
                    CASE WHEN n <= 20000 THEN 'WithinLimit' ELSE 'Overflow' END,
                    CASE WHEN n <= 1205 THEN '2026' ELSE '2025' END,
                    CASE WHEN n % 2 = 0 THEN '中文' ELSE 'English' END,
                    CASE WHEN n % 3 = 0 THEN 'single' ELSE 'album' END,
                    CASE WHEN n % 10 = 0 THEN '?' ELSE (n % 20 + 1)::text || '/20' END,
                    CASE WHEN n % 4 = 0 THEN '02/3' ELSE '1' END,
                    n % 2 = 0,n % 3 = 0,n % 5 <> 0,n % 5 = 0,n,1,
                    '2026-01-01'::timestamptz + (n % 9) * interval '1 second',
                    CASE WHEN n % 2 = 0 THEN '2026-02-01'::timestamptz + (n % 7) * interval '1 second' ELSE NULL END
                FROM fixture RETURNING id,path,filename)
                SELECT jsonb_agg(to_jsonb(inserted) ORDER BY filename) FROM inserted;"""))
            ids = [row["id"] for row in seeded]
            assert len(ids) == 20001 and len(set(ids)) == 20001
            indexed = _database_snapshot()
            small = {"q": marker, "year": "2026", "sort": "title", "order": "asc"}
            snapshot = good(small)
            check("整批筛选一次返回超过1000首的完整有序轻投影，与分页曲库完全一致",
                  snapshot["total"] == 1205 and snapshot["limit"] == 20000
                  and snapshot["items"] == listed(small)
                  and [row["id"] for row in snapshot["items"]] == ids[:1205]
                  and set(snapshot["query"]) == keys and re.fullmatch(r"[0-9a-f]{64}", snapshot["revision"]) is not None)
            repeated = good(small, snapshot["revision"])
            check("相同筛选及资料重复准备与确认得到同一完整快照，不创建任务或部分结果",
                  repeated == snapshot and good(snapshot["query"]) == snapshot
                  and _database_snapshot() == indexed and disk_snapshot() == original_disk)

            filters = [
                {"artist": f"{marker} Artist 1"}, {"artist_group": f"  {marker} Artist 1  "},
                {"album": "同名专辑 1"}, {"language": "中文"},
                {"genre": "WithinLimit"}, {"albumtype": "single"}, {"missing_cover": True},
                {"missing_lyrics": True}, {"no_artist": True}, {"no_album": True}, {"not_loaded": True},
                {"language": "English", "missing_cover": True, "missing_lyrics": True, "not_loaded": True},
                {"folder": str(special), "folder_recursive": False},
                {"folder": str(special), "folder_recursive": True},
                {"album_group": [" 同名专辑 1 ", " 群星 1 "]},
                {"album_group": ["同名专辑 1", f"{marker} Artist 1"]},
                {"q": marker + "%Track_00"},
            ]
            filter_results = []
            for extra in filters:
                query = {**small, **extra}
                actual = good(query)
                expected = listed(query)
                filter_results.append(bool(expected) and actual["items"] == expected and actual["total"] == len(expected))
            check("整批选择共用列表的搜索、精确标签、缺失标记、专辑分组及递归目录规则",
                  all(filter_results), str(filter_results))
            direct = good({**small, "folder": str(special), "folder_recursive": False})
            recursive = good({**small, "folder": str(special)})
            check("带空格和通配字符的目录保持精确路径，递归只增加该目录的后代",
                  direct["query"]["folder"] == str(special)
                  and direct["total"] == 402 and recursive["total"] == 803
                  and all(row["dir"] == str(special) for row in direct["items"])
                  and all(row["dir"] in {str(special), str(nested)} for row in recursive["items"]))
            sorts = []
            for sort in ("artist", "title", "album", "year", "path", "track", "indexed", "edited", "disc_track"):
                for order in ("asc", "desc"):
                    query = {**small, "sort": sort, "order": order}
                    sorts.append(good(query)["items"] == listed(query))
            check("九种排序的升降序与曲库完全一致，碟号曲号按数值排序且同值顺序稳定", all(sorts), str(sorts))

            canonical = good({**small, "q": "　 " + marker + " \n", "year": " 2026 ", "order": " ASC ", "folder_recursive": False})
            check("响应回显完整规范化条件，无目录时忽略无意义递归开关且同义查询版本一致",
                  canonical == snapshot and canonical["query"]["folder_recursive"] is True)
            empty = good({"q": marker + "-absent"})
            check("空筛选结果可核对但保持零项，不回退到整个曲库",
                  empty["total"] == 0 and empty["items"] == [] and good(empty["query"], empty["revision"]) == empty)

            at_limit = good({"q": marker, "genre": "WithinLimit", "sort": "title"})
            check("恰好20000首完整返回并可再次核对，无1000首或预览500首截断",
                  at_limit["total"] == 20000 and [row["id"] for row in at_limit["items"]] == ids[:20000]
                  and good(at_limit["query"], at_limit["revision"]) == at_limit)
            over = response({"q": marker})
            check("20001首整体拒绝并说明下限，不返回前20000首冒充完整范围",
                  rejected(over, "selection_limit_exceeded")
                  and over.json()["detail"]["limit"] == 20000 and over.json()["detail"]["matched_at_least"] == 20001)
            check("跨页准备和所有筛选排序只读数据库，不写索引、任务、清单或音频",
                  _database_snapshot() == indexed and disk_snapshot() == original_disk
                  and not special.exists() and not nested.exists()
                  and all("file_exists" not in row and "tags" not in row for row in snapshot["items"]))

            # Exercise the actual downstream persistence contract with the
            # whole prepared range, including members after the first page.
            collection_id = str(uuid.uuid4())
            owned_collections.add(collection_id)
            created = client.post(f"{base}/api/collections", json={"id": collection_id,
                "name": marker, "ids": [row["id"] for row in snapshot["items"]]}, timeout=60)
            created.raise_for_status()
            collection = created.json()["collection"]
            persisted = client.post(f"{base}/api/collections/{collection_id}/selection",
                json={"revision": collection["revision"]}, timeout=60)
            persisted.raise_for_status()
            check("整批筛选快照可直接保存清单，跨页1205首成员及原排序完整持久化",
                  collection["track_count"] == 1205 and persisted.json()["ids"] == ids[:1205]
                  and disk_snapshot() == original_disk)

            mutations = []
            for field, value in [("title", marker + " Changed title"), ("artist", "不同歌手"),
                                 ("size", 123456), ("path", str(scope / "renamed.flac"))]:
                old = snapshot["items"][0][field]
                try:
                    set_value(ids[0], field, value)
                    mutations.append(rejected(response(small, snapshot["revision"]), "selection_changed"))
                finally:
                    set_value(ids[0], field, old)
            check("准备后标题、歌手、文件大小或路径变化均拒绝旧版本，拒绝响应不含新选择", all(mutations), str(mutations))
            changed_query = {**small, "order": "desc"}
            check("确认必须对应同一规范化条件及顺序，替换排序或使用伪版本明确拒绝",
                  rejected(response(changed_query, snapshot["revision"]), "selection_changed")
                  and rejected(response(small, "0" * 64), "selection_changed"))
            try:
                _postgres(f"BEGIN; UPDATE tracks SET year='2025' WHERE id={ids[0]}; "
                          f"UPDATE tracks SET year='2026' WHERE id={ids[-1]}; COMMIT;")
                same_count = good(small)
                check("同总数下移出一首再加入另一首，成员变化仍使旧范围失效",
                      same_count["total"] == snapshot["total"]
                      and ids[0] not in [row["id"] for row in same_count["items"]]
                      and ids[-1] in [row["id"] for row in same_count["items"]]
                      and rejected(response(small, snapshot["revision"]), "selection_changed"))
            finally:
                _postgres(f"BEGIN; UPDATE tracks SET year='2026' WHERE id={ids[0]}; "
                          f"UPDATE tracks SET year='2025' WHERE id={ids[-1]}; COMMIT;")
            set_value(ids[-1], "title", marker + " Unrelated update")
            check("不属于当前范围的资料变化不会作废准备结果", good(small, snapshot["revision"]) == snapshot)
            set_value(ids[-1], "title", marker + " Track 20001")

            # One committed transaction alters all labels. Any concurrent read
            # must see either complete A or complete B, never a mixed snapshot.
            errors = []
            subset = ",".join(str(identifier) for identifier in ids[:1205])
            application_name = marker + "-writer"

            def update_together():
                try:
                    _postgres(f"BEGIN; SET LOCAL application_name={_literal(application_name)}; "
                              f"UPDATE tracks SET artist='Snapshot B' WHERE id IN ({subset}); "
                              "SELECT pg_sleep(3); COMMIT;")
                except Exception as error:
                    errors.append(type(error).__name__)

            concurrent_query = {**small, "sort": "title"}
            a = good(concurrent_query)
            thread = threading.Thread(target=update_together)
            thread.start()
            waiting = False
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and thread.is_alive():
                waiting = _postgres("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE "
                                    f"application_name={_literal(application_name)} AND wait_event='PgSleep');") == "t"
                if waiting:
                    break
                time.sleep(0.05)
            # The writer has updated every row but has not committed. A read
            # here must still see A, not block on row locks or expose B early.
            during = good(concurrent_query)
            reads = [good(concurrent_query) for _ in range(2)]
            thread.join(45)
            assert not thread.is_alive() and not errors, f"Concurrent fixture failure: {errors}"
            b = good(concurrent_query)
            check("并发提交整批标签时，每次响应都是完整一致快照，不混合两次资料",
                  waiting and during == a and a != b and all(value == a or value == b for value in reads)
                  and all(row["artist"] == "Snapshot B" for row in b["items"])
                  and rejected(response(concurrent_query, a["revision"]), "selection_changed"))

            unsafe_id = 9007199254740992
            assert _postgres(f"SELECT count(*) FROM tracks WHERE id={unsafe_id};") == "0"
            _postgres(f"INSERT INTO tracks(id,path,dir,filename,title,year) VALUES ({unsafe_id},"
                      f"{_literal(str(scope / 'unsafe.flac'))},{root_sql},'unsafe.flac',{_literal(marker)},'2026');")
            ids.append(unsafe_id)
            try:
                check("数据库曲目编号超出浏览器安全整数时整体拒绝，避免取整后选错曲目",
                      rejected(response(small), "invalid_selection_snapshot"))
            finally:
                _postgres(f"DELETE FROM tracks WHERE id={unsafe_id} AND path={_literal(str(scope / 'unsafe.flac'))};")

            validation_before = _database_snapshot()

            invalid = [{}, {"query": None}, {"query": []}, {"query": "all"}, {"query": {}, "ids": []}]
            for field in ("q", "artist", "artist_group", "album", "language", "albumtype", "genre", "year", "folder"):
                invalid += [{"query": {field: value}} for value in (None, 1, True, [], "a\0b")]
            for field in ("missing_cover", "missing_lyrics", "no_artist", "no_album", "not_loaded", "folder_recursive"):
                invalid += [{"query": {field: value}} for value in (None, 1, "true", [])]
            invalid += [{"query": {field: 1}} for field in ("page", "page_size", "limit", "ids", "unknown")]
            invalid += [{"query": {"sort": value}} for value in ("unknown", "title DESC;", None)]
            invalid += [{"query": {"order": value}} for value in ("unknown", None)]
            invalid += [{"query": {"album_group": value}} for value in ([], ["a"], ["a", 1], ["", "a"], "[\"a\",\"b\"]")]
            invalid += [{"query": {}, "revision": value} for value in ("", "z" * 64, "a" * 63, 4, [])]
            invalid += [{"query": {"q": "字" * 4001}}, {"query": {"folder": "/" + "a" * 32768}}]
            codes = [client.post(f"{base}{route}", json=payload, timeout=30).status_code for payload in invalid]
            check("整批范围拒绝未知或分页字段、错误JSON类型、越界长度、空分组和无效版本",
                  codes == [422] * len(codes), str(codes))
            unsafe = ["../outside", str(scope.parent.parent / marker), str(scope) + os.sep,
                      str(scope) + os.sep + ".." + os.sep + "elsewhere"]
            path_codes = [response({"folder": path}).status_code for path in unsafe]
            check("筛选快照沿用曲库目录边界，不接受越界、相对或非规范路径",
                  path_codes == [400] * len(unsafe), str(path_codes))
            check("失败、冲突和并发核对都不接触原始音频或生成缓存目录",
                  disk_snapshot() == original_disk and not special.exists() and not nested.exists()
                  and _database_snapshot() == validation_before)
        finally:
            if owned_collections:
                collections_sql = ",".join(_literal(value) + "::uuid" for value in owned_collections)
                _postgres(f"DELETE FROM track_collections WHERE id IN ({collections_sql});")
            # Recover only this UUID's three exact directory values if INSERT
            # committed but the returned JSON could not be parsed.
            directories = ",".join(_literal(str(folder)) for folder in (scope, special, nested))
            recovered = json.loads(_postgres("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'path',path)),'[]'::jsonb) "
                                              f"FROM tracks WHERE dir IN ({directories});"))
            known_ids = set(ids)
            for row in recovered:
                assert Path(row["path"]).is_relative_to(scope) and Path(row["path"]).suffix == ".flac"
                if row["id"] not in known_ids:
                    ids.append(row["id"])
                    known_ids.add(row["id"])
            if ids:
                assert all(isinstance(identifier, int) and identifier > 0 for identifier in ids)
                # IDs are only those returned by this UUID's INSERT. Mutated
                # paths remain under its exact fixture root throughout.
                _postgres("DELETE FROM tracks WHERE id IN (" + ",".join(map(str, ids)) + f") AND dir IN ({directories});")
            assert scope.resolve().parent == music.resolve() and scope.resolve() != music.resolve()
            if sentinel.exists():
                sentinel.unlink()
            if scope.exists():
                scope.rmdir()
            check("整批选择验收只清理自有索引夹具，原有曲库任务清单内容完整保留", _database_snapshot() == before)
