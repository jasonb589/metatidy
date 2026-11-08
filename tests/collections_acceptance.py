"""Persistent collection HTTP contracts using UUID-owned Postgres fixtures.

The large fixture is index-only: no scan, audio parser, or real library mutation
is needed. Cleanup is restricted to the UUID collection IDs and owned track
paths created here; the before/after digests include the pre-existing database.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from tests.jobs_acceptance import _postgres


def _literal(value: str) -> str:
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def _database_snapshot() -> str:
    return _postgres("""SELECT jsonb_build_object(
        'tracks',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) FROM tracks t),
        'jobs',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(j)::text),'' ORDER BY id),'')) FROM jobs j),
        'collections',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(c)::text),'' ORDER BY id),'')) FROM track_collections c),
        'members',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(m)::text),'' ORDER BY collection_id,position),'')) FROM track_collection_members m));""")


def _tracks_and_jobs() -> str:
    return _postgres("""SELECT jsonb_build_object(
        'tracks',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) FROM tracks t),
        'jobs',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(j)::text),'' ORDER BY id),'')) FROM jobs j));""")


def _valid_summary(value: dict) -> bool:
    try:
        return (str(uuid.UUID(value["id"])) == value["id"]
                and str(uuid.UUID(value["revision"])) == value["revision"]
                and isinstance(value["name"], str)
                and all(isinstance(value[key], int) and value[key] >= 0 for key in ("track_count", "missing_count"))
                and value["missing_count"] <= value["track_count"]
                and all(isinstance(value[key], (int, float)) and math.isfinite(value[key]) and value[key] > 0
                        for key in ("created_at", "updated_at")))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def check_collections_auth(base: str, check) -> None:
    """The auth middleware must run before UUID, query, and body validation."""
    codes = []
    with requests.Session() as client:
        client.trust_env = False
        codes.append(client.get(f"{base}/api/collections", params={"page_size": "invalid"}, timeout=20).status_code)
        for identifier in (str(uuid.uuid4()), "not-a-uuid"):
            root = f"{base}/api/collections/{identifier}"
            requests_to_make = [
                ("GET", root, None),
                ("POST", f"{base}/api/collections", {"id": identifier, "name": "", "ids": [True]}),
                ("PATCH", root, {"name": "", "revision": "invalid"}),
                ("DELETE", root, {"revision": "invalid"}),
                ("POST", f"{root}/members", {"revision": "invalid", "action": "invalid", "ids": [True]}),
                ("POST", f"{root}/selection", {"revision": "invalid"}),
            ]
            for method, url, body in requests_to_make:
                codes.append(client.request(method, url, json=body, timeout=20).status_code)
    check("曲目清单全部读取与修改入口先鉴权，非法UUID、参数和正文也返回401",
          codes == [401] * len(codes), str(codes))


def check_collections(base: str, music: Path, check, restart=None) -> None:
    nonce = uuid.uuid4().hex
    marker = f"CollectionsFixture-{nonce}"
    library = music.resolve()
    scope = library / f"__collections_acceptance_{nonce}__"
    sentinel = scope / "1.flac"
    assert scope.parent == library and not scope.exists()
    before = _database_snapshot()
    owned_collections: set[str] = set()
    owned_tracks: dict[int, str] = {}
    ids: list[int] = []

    def disk_snapshot():
        return (hashlib.sha256(sentinel.read_bytes()).hexdigest(), sentinel.stat().st_size,
                sentinel.stat().st_mtime_ns, sorted(path.name for path in scope.iterdir()))

    missing_id = 9007199254740991

    with requests.Session() as client:
        client.trust_env = False

        def request(method, route, *, body=None, params=None):
            return client.request(method, f"{base}{route}", json=body, params=params, timeout=90, allow_redirects=False)

        def good(method, route, *, body=None, params=None):
            response = request(method, route, body=body, params=params)
            assert response.status_code == 200, f"{method} {route}: HTTP {response.status_code} {response.text[:300]}"
            return response.json()

        def new_id():
            value = str(uuid.uuid4())
            owned_collections.add(value)
            return value

        def create(name, members, identifier=None):
            identifier = identifier or new_id()
            return good("POST", "/api/collections", body={"id": identifier, "name": name, "ids": members})["collection"]

        def detail(collection, **params):
            return good("GET", f"/api/collections/{collection['id']}", params=params)

        def selection(collection):
            return good("POST", f"/api/collections/{collection['id']}/selection", body={"revision": collection["revision"]})

        def members(collection, action, track_ids):
            return good("POST", f"/api/collections/{collection['id']}/members",
                        body={"revision": collection["revision"], "action": action, "ids": track_ids})

        def saved(collection):
            return json.loads(_postgres(f"""SELECT jsonb_build_object('collection',to_jsonb(c),
                'members',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY position) FROM track_collection_members m
                    WHERE m.collection_id=c.id),'[]'::jsonb)) FROM track_collections c WHERE id={_literal(collection['id'])}::uuid;"""))

        try:
            scope.mkdir()
            sentinel.write_bytes(b"Collection acceptance: index metadata only; these bytes must never be rewritten.\n")
            original_disk = disk_snapshot()
            # 20,001 real index rows exercise both sides of the limit. Only the
            # first path exists: every other entry must remain purely DB-based.
            path_prefix = _literal(str(scope) + os.sep)
            scope_sql = _literal(str(scope))
            inserted = json.loads(_postgres(f"""WITH seeded AS (
                INSERT INTO tracks(path,dir,filename,ext,title,artist,album,size,mtime,tags_loaded,path_derived)
                SELECT {path_prefix} || n::text || '.flac',{scope_sql},n::text || '.flac','flac',
                    {_literal(marker)} || ' Track ' || n::text,'清单验收歌手','清单验收专辑',n,1,false,true
                FROM generate_series(1,20001) n RETURNING id,path,filename)
                SELECT jsonb_agg(to_jsonb(seeded) ORDER BY replace(filename,'.flac','')::integer) FROM seeded;"""))
            for row in inserted:
                owned_tracks[row["id"]] = row["path"]
                ids.append(row["id"])
            assert len(ids) == 20001 and _postgres(f"SELECT count(*) FROM tracks WHERE id={missing_id};") == "0"
            indexed_before = _tracks_and_jobs()

            empty = create(f"{marker} Empty", [])
            empty_detail = detail(empty)
            check("曲目清单可保存空清单，摘要和空分页形状完整且没有隐式加入曲目",
                  _valid_summary(empty) and empty["track_count"] == empty["missing_count"] == 0
                  and empty_detail["total"] == 0 and empty_detail["page"] == 1 and empty_detail["pages"] == 0
                  and empty_detail["items"] == [] and selection(empty)["ids"] == [])

            main_name = f"{marker} 中文🎵 Needle 100%_Mix!'"
            original_ids = [ids[3], ids[0], ids[2], ids[1]]
            original_payload_ids = [ids[3], ids[0], ids[2], ids[0], ids[1], ids[3]]
            main = create("\u3000 " + main_name + " \u3000", original_payload_ids)
            initial_revision = main["revision"]
            main_detail = detail(main)
            check("创建清单规范Unicode名称并按首次出现顺序去重，成员快照来自真实索引",
                  _valid_summary(main) and main["name"] == main_name and main["track_count"] == 4
                  and [item["id"] for item in main_detail["items"]] == original_ids
                  and [item["position"] for item in main_detail["items"]] == [1, 2, 3, 4]
                  and all(item["status"] == "found" and item["track"]["id"] == item["snapshot"]["id"] == item["id"]
                          and item["track"]["title"] == item["snapshot"]["title"] for item in main_detail["items"]))

            max_name = "名称🎵" * 40
            unicode_collection = create(" \u3000" + max_name + "\u3000 ", [])
            invalid_names = ["", " \u3000\n ", max_name + "字", "a\0b", None, 7, []]
            name_codes = [request("POST", "/api/collections", body={"id": new_id(), "name": value, "ids": []}).status_code for value in invalid_names]
            check("清单名称按修剪后的Unicode字符限制120字，空名、NUL及错误类型返回422",
                  unicode_collection["name"] == max_name and len(max_name) == 120 and name_codes == [422] * len(invalid_names), str(name_codes))

            invalid_ids = [None, "1", {}, [0], [-1], [True], [1.0], [str(ids[0])], [9007199254740992], [ids[0]] * 20001]
            invalid_payloads = [{"id": new_id(), "name": marker, "ids": value} for value in invalid_ids]
            invalid_payloads += [{"id": new_id(), "name": marker}, {"name": marker, "ids": []},
                                 {"id": "not-a-uuid", "name": marker, "ids": []}]
            bad_before = _database_snapshot()
            invalid_codes = [request("POST", "/api/collections", body=body).status_code for body in invalid_payloads]
            check("清单ID与成员数组严格校验，拒绝浮点布尔非安全整数及去重前超过20000项",
                  invalid_codes == [422] * len(invalid_payloads) and _database_snapshot() == bad_before, str(invalid_codes))

            missing_create_id = new_id()
            missing_create = request("POST", "/api/collections", body={"id": missing_create_id, "name": marker, "ids": [ids[0], missing_id]})
            check("创建时任一新成员缺失返回409，清单和已找到成员均不部分落库",
                  missing_create.status_code == 409 and _database_snapshot() == bad_before
                  and request("GET", f"/api/collections/{missing_create_id}").status_code == 404)

            # Equal timestamps require a deterministic secondary ID order.
            list_collections = [empty, main] + [create(f"{marker} Page {index:02}", []) for index in range(22)]
            fixture_ids_sql = ",".join(_literal(row["id"]) + "::uuid" for row in list_collections)
            _postgres(f"UPDATE track_collections SET updated_at=to_timestamp(1700000000) WHERE id IN ({fixture_ids_sql});")
            expected = sorted(row["id"] for row in list_collections)
            pages = [good("GET", "/api/collections", params={"q": marker, "page": page, "page_size": 7}) for page in range(1, 5)]
            default_list = good("GET", "/api/collections", params={"q": marker})
            literal = good("GET", "/api/collections", params={"q": main_name.lower()})
            check("清单列表只按名称字面搜索，稳定分页不重不漏且默认每页20条",
                  [item["id"] for page in pages for item in page["items"]] == expected
                  and all(page["total"] == 24 and page["pages"] == 4 for page in pages)
                  and default_list["page_size"] == 20 and len(default_list["items"]) == 20
                  and literal["total"] == 1 and literal["items"][0]["id"] == main["id"]
                  and good("GET", "/api/collections", params={"q": main_name.replace("%", "X")})["total"] == 0
                  and good("GET", "/api/collections", params={"q": marker + " Track"})["total"] == 0)

            last_list = good("GET", "/api/collections", params={"q": marker, "page_size": 7, "page": 9223372036854775807})
            no_list = good("GET", "/api/collections", params={"q": marker + " absent", "page": 999})
            query_cases = [("/api/collections", {"page_size": value}) for value in (0, -1, 101, "NaN")]
            query_cases += [("/api/collections", {"page": value}) for value in ("NaN", 9223372036854775808)]
            query_cases += [("/api/collections", {"q": value}) for value in ("字" * 501, "a\0b")]
            query_cases += [(f"/api/collections/{main['id']}", {"page_size": value}) for value in (0, -1, 201, "NaN")]
            query_cases += [(f"/api/collections/{main['id']}", {"page": value}) for value in ("NaN", 9223372036854775808)]
            query_codes = [request("GET", route, params=params).status_code for route, params in query_cases]
            check("清单搜索分页边界严格校验，超大合法页码夹到末页、空结果页码为1",
                  last_list["page"] == 4 and len(last_list["items"]) == 3
                  and no_list["page"] == 1 and no_list["pages"] == 0 and no_list["items"] == []
                  and query_codes == [422] * len(query_cases)
                  and good("GET", "/api/collections", params={"q": "字" * 500})["total"] == 0, str(query_codes))

            detail_pages = [detail(main, page=page, page_size=2, revision=main["revision"]) for page in (1, 2)]
            check("清单详情按成员位置分页，选择接口返回全部固定顺序而不截断为当前页",
                  [item["id"] for page in detail_pages for item in page["items"]] == original_ids
                  and [item["position"] for page in detail_pages for item in page["items"]] == [1, 2, 3, 4]
                  and all(page["total"] == 4 and page["pages"] == 2 and page["collection"]["id"] == main["id"] for page in detail_pages)
                  and selection(main)["ids"] == original_ids and detail(main, page=999, page_size=2)["page"] == 2
                  and all("file_exists" not in item["track"] and "lyrics" not in item["track"] for item in main_detail["items"]))

            renamed = good("PATCH", f"/api/collections/{main['id']}", body={"revision": main["revision"], "name": f"{marker} Renamed"})["collection"]
            noop_rename = good("PATCH", f"/api/collections/{main['id']}", body={"revision": renamed["revision"], "name": " " + renamed["name"] + " "})["collection"]
            check("重命名真实变化生成新revision，规范后同名无操作保留revision和更新时间",
                  renamed["revision"] != main["revision"] and renamed["created_at"] == main["created_at"]
                  and noop_rename == renamed and selection(renamed)["ids"] == original_ids)
            main = renamed

            appended = members(main, "append", [ids[4], ids[2], ids[5], ids[4]])
            main = appended["collection"]
            appended_order = original_ids + [ids[4], ids[5]]
            noop_append = members(main, "append", [ids[5], ids[0], ids[5]])
            empty_append = members(main, "append", [])
            check("追加成员只在尾部加入新的去重ID，重复及空追加不修改revision",
                  appended["added"] == 2 and appended["removed"] == 0 and main["track_count"] == 6
                  and selection(main)["ids"] == appended_order
                  and noop_append["added"] == empty_append["added"] == 0
                  and noop_append["collection"] == empty_append["collection"] == main)

            removed = members(main, "remove", [ids[0], ids[4], ids[0], ids[19]])
            previous_revision = main["revision"]
            main = removed["collection"]
            main_order = [ids[3], ids[2], ids[1], ids[5]]
            noop_remove = members(main, "remove", [missing_id, ids[19]])
            empty_remove = members(main, "remove", [])
            check("移除成员保留余下顺序并重排位置，重复与非成员不多扣、无操作不换revision",
                  removed["added"] == 0 and removed["removed"] == 2 and main["revision"] != previous_revision
                  and selection(main)["ids"] == main_order
                  and [item["position"] for item in detail(main)["items"]] == [1, 2, 3, 4]
                  and noop_remove["removed"] == empty_remove["removed"] == 0
                  and noop_remove["collection"] == empty_remove["collection"] == main)

            conflict_before = _database_snapshot()
            stale_calls = [
                ("PATCH", f"/api/collections/{main['id']}", {"revision": initial_revision, "name": "stale"}, None),
                ("DELETE", f"/api/collections/{main['id']}", {"revision": initial_revision}, None),
                ("POST", f"/api/collections/{main['id']}/members", {"revision": initial_revision, "action": "append", "ids": [ids[6]]}, None),
                ("POST", f"/api/collections/{main['id']}/members", {"revision": initial_revision, "action": "remove", "ids": [ids[3]]}, None),
                ("POST", f"/api/collections/{main['id']}/selection", {"revision": initial_revision}, None),
                ("GET", f"/api/collections/{main['id']}", None, {"revision": initial_revision}),
            ]
            stale_codes = [request(method, route, body=body, params=params).status_code for method, route, body, params in stale_calls]
            check("旧revision的重命名、增删成员、删除、详情和选择均409且数据库完全不变",
                  stale_codes == [409] * len(stale_calls) and _database_snapshot() == conflict_before, str(stale_codes))

            invalid_revision_calls = []
            for revision in (None, "not-a-uuid"):
                revision_body = {} if revision is None else {"revision": revision}
                invalid_revision_calls.extend([
                    ("PATCH", f"/api/collections/{main['id']}", {**revision_body, "name": "valid"}),
                    ("DELETE", f"/api/collections/{main['id']}", revision_body),
                    ("POST", f"/api/collections/{main['id']}/members", {**revision_body, "action": "remove", "ids": []}),
                    ("POST", f"/api/collections/{main['id']}/selection", revision_body),
                ])
            bad_revision_codes = [request(method, route, body=body).status_code for method, route, body in invalid_revision_calls]
            bad_member_bodies = [{"revision": main["revision"], "action": action, "ids": values}
                                 for action, values in (("unknown", []), ("append", [True]), ("remove", [1.0]), ("append", None))]
            bad_member_codes = [request("POST", f"/api/collections/{main['id']}/members", body=body).status_code for body in bad_member_bodies]
            unknown = str(uuid.uuid4())
            check("缺失或非法revision和成员动作返回422，未知清单404且错误请求无副作用",
                  bad_revision_codes == [422] * len(bad_revision_codes) and bad_member_codes == [422] * len(bad_member_codes)
                  and request("GET", f"/api/collections/{main['id']}", params={"revision": "invalid"}).status_code == 422
                  and request("GET", f"/api/collections/{unknown}").status_code == 404
                  and request("GET", "/api/collections/not-a-uuid").status_code == 422
                  and _database_snapshot() == conflict_before, f"revision={bad_revision_codes}; members={bad_member_codes}")

            replay = create(main_name, original_ids, main["id"])
            changed_name = request("POST", "/api/collections", body={"id": main["id"], "name": main_name + " changed", "ids": original_ids})
            changed_order = request("POST", "/api/collections", body={"id": main["id"], "name": main_name, "ids": list(reversed(original_ids))})
            check("创建UUID以规范化原始payload幂等，后续已修改仍返回同清单且异名或异顺序409",
                  replay == main and changed_name.status_code == changed_order.status_code == 409
                  and _database_snapshot() == conflict_before)

            raced = create(f"{marker} Race", [ids[0]])
            barrier = threading.Barrier(2)

            def race_rename(number):
                with requests.Session() as racing_client:
                    racing_client.trust_env = False
                    barrier.wait(timeout=10)
                    response = racing_client.patch(f"{base}/api/collections/{raced['id']}",
                        json={"revision": raced["revision"], "name": f"{marker} Race {number}"}, timeout=60)
                    return response.status_code, response.json()

            with ThreadPoolExecutor(max_workers=2) as executor:
                race_results = list(executor.map(race_rename, (1, 2)))
            winner = next((body["collection"] for code, body in race_results if code == 200), {})
            check("两个并发修改共享同一revision时仅一个成功，失败方409且不会覆盖获胜结果",
                  sorted(code for code, _ in race_results) == [200, 409]
                  and detail(raced)["collection"] == winner and winner.get("revision") != raced["revision"], str([code for code, _ in race_results]))

            large_ids = list(reversed(ids[:20000]))
            large = create(f"{marker} 20000", large_ids)
            large_detail = detail(large)
            large_last = detail(large, page=999999, page_size=200)
            large_selection = selection(large)
            check("清单可完整持久保存20000首，默认详情100条而选择接口返回全部原顺序",
                  large["track_count"] == 20000 and large["missing_count"] == 0
                  and large_detail["page_size"] == 100 and large_detail["pages"] == 200
                  and [item["id"] for item in large_detail["items"]] == large_ids[:100]
                  and large_last["page"] == 100 and [item["id"] for item in large_last["items"]] == large_ids[-200:]
                  and large_selection["ids"] == large_ids
                  and int(_postgres(f"SELECT count(*) FROM track_collection_members WHERE collection_id={_literal(large['id'])}::uuid;")) == 20000)

            large_before = saved(large)
            capacity = request("POST", f"/api/collections/{large['id']}/members",
                               body={"revision": large["revision"], "action": "append", "ids": [ids[20000]]})
            large_noop = members(large, "append", [ids[0], ids[0]])
            check("追加超过清单20000总成员上限返回409且原子回滚，满额清单重复追加仍是无操作",
                  capacity.status_code == 409 and large_noop["added"] == 0 and large_noop["collection"] == large
                  and saved(large) == large_before)

            invalid_append_before = saved(main)
            invalid_append = request("POST", f"/api/collections/{main['id']}/members",
                                     body={"revision": main["revision"], "action": "append", "ids": [ids[6], missing_id]})
            check("追加中任一新ID缺失会整体409，既有成员和已找到的新曲目都不会部分修改",
                  invalid_append.status_code == 409 and saved(main) == invalid_append_before)

            check("保存、改名及增删清单只更新清单表，不改曲库索引或创建扫描任务",
                  _tracks_and_jobs() == indexed_before and disk_snapshot() == original_disk)

            # Delete an owned index row, then re-create its path with a new ID.
            # Membership must continue identifying the old, now-missing ID.
            removed_track = ids[2]
            old_item = next(item for item in detail(main)["items"] if item["id"] == removed_track)
            old_path = owned_tracks[removed_track]
            _postgres(f"DELETE FROM tracks WHERE id={removed_track} AND path={_literal(old_path)};")
            missing_detail = detail(main)
            missing_item = next(item for item in missing_detail["items"] if item["id"] == removed_track)
            missing_summary = next(item for item in good("GET", "/api/collections", params={"q": main["name"]})["items"]
                                   if item["id"] == main["id"])
            check("删除曲库索引不会级联删除清单成员，缺失计数与原始快照保留且仍可准备全部选择",
                  missing_detail["collection"]["track_count"] == 4 and missing_detail["collection"]["missing_count"] == 1
                  and missing_summary["track_count"] == 4 and missing_summary["missing_count"] == 1
                  and missing_detail["collection"]["revision"] == main["revision"]
                  and missing_item["status"] == "missing" and missing_item["track"] is None
                  and missing_item["snapshot"] == old_item["snapshot"]
                  and selection(main)["ids"] == main_order)

            replacement_id = int(_postgres(f"""INSERT INTO tracks(path,dir,filename,ext,title,artist)
                VALUES({_literal(old_path)},{scope_sql},'3.flac','flac',{_literal(marker + ' Reindexed')},'新索引歌手') RETURNING id;"""))
            owned_tracks[replacement_id] = old_path
            rebound = detail(main)
            replay_missing = create(main_name, original_ids, main["id"])
            existing_missing_append = members(replay_missing, "append", [removed_track])
            check("同路径重建的新索引ID不会自动重绑缺失成员，原创建重试和已有缺失成员追加仍幂等",
                  replacement_id != removed_track and rebound["collection"]["missing_count"] == 1
                  and next(item for item in rebound["items"] if item["id"] == removed_track)["track"] is None
                  and replacement_id not in selection(replay_missing)["ids"]
                  and replay_missing["id"] == main["id"] and replay_missing["revision"] == main["revision"]
                  and existing_missing_append["added"] == 0 and existing_missing_append["collection"] == replay_missing)
            main = replay_missing

            fresh_title = marker + " Fresh indexed title"
            snapshot_before = next(item["snapshot"] for item in detail(main)["items"] if item["id"] == ids[3])
            _postgres(f"UPDATE tracks SET title={_literal(fresh_title)} WHERE id={ids[3]} AND path={_literal(owned_tracks[ids[3]])};")
            fresh = next(item for item in detail(main)["items"] if item["id"] == ids[3])
            check("清单详情实时展示现有索引标签并保留保存时快照，不把标签变化误当成员变化",
                  fresh["track"]["title"] == fresh_title and fresh["snapshot"] == snapshot_before
                  and detail(main)["collection"]["revision"] == main["revision"])

            readonly_before = _database_snapshot()
            persisted_before = saved(main)
            for _ in range(2):
                good("GET", "/api/collections", params={"q": marker, "page_size": 100})
                detail(main, page_size=2, page=2, revision=main["revision"])
                selection(main)
                detail(large, page_size=200, page=70, revision=large["revision"])
            check("清单浏览与准备选择只读数据库，不因离线文件读标签、生成文件或改写任何数据",
                  _database_snapshot() == readonly_before and disk_snapshot() == original_disk
                  and not (scope / "2.flac").exists())

            if restart is not None:
                restart()
            after_restart = detail(main)
            check("清单名称、revision、成员顺序和缺失快照在服务重启后保持数据库持久一致",
                  after_restart["collection"] == main and selection(main)["ids"] == main_order
                  and saved(main) == persisted_before and _database_snapshot() == readonly_before
                  and next(item for item in after_restart["items"] if item["id"] == removed_track)["snapshot"] == old_item["snapshot"],
                  "已实际重启服务" if restart is not None else "独立SQL连接确证持久记录")

            deleted = good("DELETE", f"/api/collections/{main['id']}", body={"revision": main["revision"]})
            check("删除清单只移除该清单及自有成员，原曲库与文件保留且重复删除404",
                  deleted == {"deleted": True, "id": main["id"]}
                  and request("GET", f"/api/collections/{main['id']}").status_code == 404
                  and request("DELETE", f"/api/collections/{main['id']}", body={"revision": main["revision"]}).status_code == 404
                  and _postgres(f"SELECT count(*) FROM track_collection_members WHERE collection_id={_literal(main['id'])}::uuid;") == "0"
                  and detail(empty)["collection"]["id"] == empty["id"] and disk_snapshot() == original_disk)
        finally:
            if owned_collections:
                collection_ids_sql = ",".join(_literal(value) + "::uuid" for value in owned_collections)
                _postgres(f"DELETE FROM track_collections WHERE id IN ({collection_ids_sql});")
            # Exact owned IDs plus the exact owned parent constrain cleanup;
            # no LIKE wildcard, recursive filesystem delete, or library reset.
            # The INSERT may have committed even if its JSON reply could not be
            # parsed. Recover only rows in this exact UUID parent, then verify
            # their paths individually before using their explicit IDs.
            recover = json.loads(_postgres(f"SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'path',path)),'[]'::jsonb) "
                                           f"FROM tracks WHERE dir={_literal(str(scope))};"))
            for row in recover:
                assert Path(row["path"]).parent == scope
                assert Path(row["path"]).suffix == ".flac" and Path(row["path"]).stem.isdigit()
                owned_tracks[row["id"]] = row["path"]
            if owned_tracks:
                assert all(Path(path).parent == scope for path in owned_tracks.values())
                track_ids_sql = ",".join(str(value) for value in owned_tracks)
                _postgres(f"DELETE FROM tracks WHERE id IN ({track_ids_sql}) AND dir={_literal(str(scope))};")
            assert sentinel.parent == scope and scope.parent == library and scope.resolve().is_relative_to(library)
            sentinel.unlink(missing_ok=True)
            if scope.exists():
                scope.rmdir()
            check("清单验收只清理自有UUID清单、成员与索引，原数据库和音乐目录保持完整",
                  not scope.exists() and _database_snapshot() == before)
