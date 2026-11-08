"""Duplicate review against real HTTP and PostgreSQL, without audio fixtures.

Every row belongs to a UUID namespace and points below a directory that is
never created. Cleanup uses only exact owned paths/IDs. Canonical Unicode keys
come from PostgreSQL so the test does not substitute Python's lowercasing.
"""
from __future__ import annotations

import json
import math
import re
import uuid
from collections import defaultdict
from pathlib import Path

import requests

from tests.jobs_acceptance import _postgres


LIGHT_FIELDS = {
    "id", "path", "dir", "filename", "ext", "title", "artist", "album", "albumartist",
    "genre", "year", "track", "disc", "language", "albumtype", "has_cover", "has_lyrics",
    "duration", "indexed_at", "edited_at", "scraped_at", "mtime", "size", "tags_loaded", "path_derived",
}
FIELD_TYPES = {
    **{name: "text" for name in (
        "path", "dir", "filename", "ext", "title", "artist", "album", "albumartist",
        "genre", "year", "track", "disc", "language", "albumtype",
    )},
    "has_cover": "boolean", "has_lyrics": "boolean", "duration": "double precision",
    "indexed_at": "timestamptz", "edited_at": "timestamptz", "scraped_at": "timestamptz",
    "mtime": "double precision", "size": "bigint", "tags_loaded": "boolean", "path_derived": "boolean",
}


def check_duplicates(base: str, music: Path, check) -> None:
    nonce = uuid.uuid4().hex
    marker = f"DuplicateFixture-{nonce}"
    root = music.resolve() / f"__duplicates_index_only_{nonce}__"
    assert root.parent == music.resolve() and not root.exists()
    rows: list[dict] = []
    owned: dict[int, dict] = {}
    owned_paths: set[str] = set()

    def sql_value(value):
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, (int, float)):
            return str(value)
        # Explicit escape strings also preserve a literal backslash regardless
        # of the server's standard_conforming_strings setting.
        return "E'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"

    def add(name: str, artist: str, title: str, **values):
        path = root / f"{name}.flac"
        assert path.parent == root and not path.exists()
        row = {
            **{field: "" for field, kind in FIELD_TYPES.items() if kind == "text"},
            "path": str(path), "dir": str(root), "filename": path.name, "ext": "flac",
            "artist": artist, "title": title, "album": "索引验收专辑", "albumartist": "索引验收艺人",
            "genre": "Test", "year": "2024", "track": "1", "disc": "1", "language": "中文",
            "albumtype": "studio", "has_cover": False, "has_lyrics": False, "duration": 180.5,
            "indexed_at": "2024-01-01T00:00:00Z", "edited_at": None, "scraped_at": None,
            "mtime": 1704067200.25, "size": 4096, "tags_loaded": True, "path_derived": False,
            **values,
        }
        rows.append(row)
        owned_paths.add(row["path"])
        return row

    def pair(name: str, artist: str, title: str, **values):
        return [add(f"{name}-{ordinal}", artist, title, **values) for ordinal in range(2)]

    def insert(batch: list[dict]):
        payload = json.dumps([{field: row[field] for field in FIELD_TYPES} for row in batch], ensure_ascii=False)
        columns = ", ".join(FIELD_TYPES)
        definitions = ", ".join(f"{field} {kind}" for field, kind in FIELD_TYPES.items())
        inserted = json.loads(_postgres(
            f"WITH inserted AS (INSERT INTO tracks ({columns}) SELECT {columns} "
            f"FROM jsonb_to_recordset({sql_value(payload)}::jsonb) AS fixture({definitions}) "
            "RETURNING id, path, lower(BTRIM(artist)) AS artist_key, lower(BTRIM(title)) AS title_key) "
            "SELECT jsonb_agg(to_jsonb(inserted) ORDER BY id) FROM inserted;"
        ))
        by_path = {row["path"]: row for row in batch}
        assert len(inserted) == len(batch)
        for result in inserted:
            row = by_path[result["path"]]
            row.update(id=result["id"], group=[result["artist_key"], result["title_key"]])
            owned[row["id"]] = row

    def patch(row: dict, **values):
        assert row["id"] in owned and set(values) <= set(FIELD_TYPES)
        assert Path(row["path"]).parent == root
        if "path" in values:
            assert Path(values["path"]).parent == root and not Path(values["path"]).exists()
            owned_paths.add(values["path"])
        assignments = ", ".join(f"{field}={sql_value(value)}" for field, value in values.items())
        changed = _postgres(
            f"WITH changed AS (UPDATE tracks SET {assignments} "
            f"WHERE id={row['id']} AND path={sql_value(row['path'])} RETURNING id) "
            "SELECT count(*) FROM changed;"
        )
        assert changed == "1", "Duplicate fixture update lost its exact row"
        row.update(values)

    def delete(row: dict):
        assert row["id"] in owned and Path(row["path"]).parent == root
        deleted = _postgres(
            f"WITH deleted AS (DELETE FROM tracks WHERE id={row['id']} "
            f"AND path={sql_value(row['path'])} RETURNING id) SELECT count(*) FROM deleted;"
        )
        assert deleted == "1", "Duplicate fixture delete lost its exact row"

    def database_digest():
        return _postgres("SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), '')) FROM tracks t;")

    # This earlier ID makes a same-count, same-maximum-ID membership swap possible.
    reserved = add("reserved", f"{marker} Reserved", "Singleton")
    main = []
    for ordinal in range(55):
        durations = [0, -1, "NaN", "Infinity", "-Infinity", 2.5]
        main.append(add(
            f"main-{ordinal:03}", f"  {marker.upper()} MASTER ARTIST  " if ordinal % 2 else f"{marker} Master Artist",
            " CORE Song " if ordinal % 2 else "core song",
            ext=[" FLAC ", "Mp3", "ogg", "", " AAC "][ordinal % 5],
            duration=durations[ordinal] if ordinal < len(durations) else 100 + ordinal / 10,
            size=2**31 + ordinal, has_cover=ordinal % 3 == 0, has_lyrics=ordinal % 4 == 0,
        ))
    ordinary = [pair(f"ordinary-{ordinal:02}", f"{marker} Artist {ordinal:02}", f"Song {ordinal:02}")
                for ordinal in range(24)]
    variants = [
        pair("studio", f"{marker} Split Artist", "Same Tune"),
        pair("live", f"{marker} Split Artist", "Same Tune (Live)"),
        pair("remix", f"{marker} Split Artist", "Same Tune (Remix)"),
        pair("composite", f"{marker} Split Artist & Guest", "Same Tune"),
        pair("reordered", f"Guest & {marker} Split Artist", "Same Tune"),
    ]
    unicode_groups = [
        pair("wide-spaces", f"\u3000{marker} Space\u3000", "\u3000Song\u3000"),
        pair("ascii-spaces", f" {marker} Space ", " Song "),
        pair("unicode-case", f"{marker} İ ÀΣ", "Unİcode Title"),
        pair("tab-title", f"{marker} Tabs", "\t"),
    ]
    excluded = []
    for name, flags in (("unloaded", {"tags_loaded": False}),
                        ("fast", {"tags_loaded": False, "path_derived": True}),
                        ("derived", {"path_derived": True})):
        excluded.extend(pair(name, f"{marker} {name}", "Excluded", **flags))
    excluded.extend(pair("blank-artist", "   ", f"{marker} Blank Artist"))
    excluded.extend(pair("blank-title", f"{marker} Blank Title", "   "))
    excluded.append(add("main-unloaded", main[0]["artist"], main[0]["title"], tags_loaded=False))
    excluded.append(add("main-derived", main[0]["artist"], main[0]["title"], path_derived=True))
    literal_groups = []
    for name, char in (("percent", "%"), ("underscore", "_"), ("escape", "!"),
                       ("quote", "'"), ("doublequote", '"'), ("backslash", "\\")):
        title = f"{marker} {name}{char}needle"
        literal_groups.append((title, pair(f"literal-{name}", f"{marker} Literal", title)))
        pair(f"decoy-{name}", f"{marker} Literal", f"{marker} {name}Xneedle")
    # Both tags exceed 8 KiB, while the URL-encoded pair stays below HTTP's
    # request-target limit. The artist also crosses the former 4,000-char cap.
    long_rows = pair("long-tags", f"{marker} " + "艺" * 4100, "曲" * 2800)
    invalid_durations = pair("invalid-duration", f"{marker} Invalid Duration", "Unknown Length", duration="NaN")
    invalid_durations[1]["duration"] = "-Infinity"
    original_database = database_digest()

    with requests.Session() as client:
        def get(route: str, **params):
            response = client.get(f"{base}{route}", params=params, timeout=60)
            response.raise_for_status()
            return response.json()

        def detail(key, **params):
            return get("/api/duplicates/detail", group=json.dumps(key, ensure_ascii=False), **params)

        def detail_status(key, **params):
            return client.get(f"{base}/api/duplicates/detail",
                              params={"group": json.dumps(key, ensure_ascii=False), **params}, timeout=60).status_code

        def selected(key, revision, track_id):
            response = client.post(f"{base}/api/duplicates/selection",
                                   json={"group": key, "revision": revision, "track_id": track_id}, timeout=60)
            response.raise_for_status()
            return response.json()

        def selection_status(key, revision, track_id):
            return client.post(f"{base}/api/duplicates/selection",
                               json={"group": key, "revision": revision, "track_id": track_id}, timeout=60).status_code

        def stale(key, revision, track_id):
            return (detail_status(key, revision=revision, page=2) == 409
                    and selection_status(key, revision, track_id) == 409)

        try:
            insert(rows)
            main.sort(key=lambda row: row["id"])
            group = main[0]["group"]
            expected: dict[tuple, list[dict]] = defaultdict(list)
            for row in rows:
                if row["tags_loaded"] and not row["path_derived"] and row["artist"].strip(" ") and row["title"].strip(" "):
                    expected[tuple(row["group"])].append(row)
            expected = {key: members for key, members in expected.items() if len(members) >= 2}
            expected_keys = sorted(expected, key=lambda key: tuple(part.encode("utf-8") for part in key))
            first_list = get("/api/duplicates", q=marker)
            pages = [first_list] + [get("/api/duplicates", q=marker, page=page)
                                    for page in range(2, first_list["pages"] + 1)]
            groups = [item for page in pages for item in page["items"]]
            check("疑似重复超过20组完整分页，大小写和ASCII边空格共用PG规范键",
                  len(expected) > 20 and [tuple(item["group"]) for item in groups] == expected_keys
                  and all(page["total"] == len(expected) and page["page_size"] == 20
                          and page["page"] == ordinal and page["pages"] == math.ceil(len(expected) / 20)
                          for ordinal, page in enumerate(pages, 1))
                  and all(item["track_count"] == len(expected[tuple(item["group"])])
                          and set(item) == {"group", "artist", "title", "track_count"} for item in groups))
            by_group = {tuple(item["group"]): item for item in groups}
            excluded_ids = {row["id"] for row in excluded}
            check("快速路径、未加载、路径推导和空白标签不参与疑似重复分组",
                  by_group[tuple(group)]["track_count"] == 55
                  and not excluded_ids.intersection(row["id"] for members in expected.values() for row in members)
                  and tuple(reserved["group"]) not in by_group)
            check("Live、Remix和完整组合艺人保持独立分组",
                  len({tuple(pair_rows[0]["group"]) for pair_rows in variants}) == 5
                  and all(by_group[tuple(pair_rows[0]["group"])]["track_count"] == 2 for pair_rows in variants))
            check("Unicode空格、制表符及PG大小写键可原样往返详情",
                  len({tuple(pair_rows[0]["group"]) for pair_rows in unicode_groups}) == 4
                  and all(detail(pair_rows[0]["group"])["group"] == pair_rows[0]["group"]
                          and detail(pair_rows[0]["group"])["total"] == 2 for pair_rows in unicode_groups))
            check("分组列表分页稳定，负页与超大页安全夹取",
                  get("/api/duplicates", q=marker) == first_list
                  and get("/api/duplicates", q=marker, page=-5) == first_list
                  and get("/api/duplicates", q=marker, page=9223372036854775807) == pages[-1]
                  and get("/api/duplicates", q=f"{marker} absent")["items"] == []
                  and get("/api/duplicates", q=marker, page_size=50)["page_size"] == 50)
            literal_results = [(query, get("/api/duplicates", q=f"  {query}  ")) for query, _ in literal_groups]
            check("搜索按字面处理百分号、下划线、感叹号、引号和反斜线",
                  all(result["total"] == 1 and result["items"][0]["group"] == pair_rows[0]["group"]
                      for (_, result), (_, pair_rows) in zip(literal_results, literal_groups)))

            first = detail(group)
            revision = first["revision"]
            second = detail(group, page=2, revision=revision)
            members = first["items"] + second["items"]
            expected_ids = [row["id"] for row in main]
            check("超过50首详情以稳定ID完整分页，后续页保持同一版本",
                  first["page"] == 1 and first["page_size"] == 50 and len(first["items"]) == 50
                  and second["page"] == 2 and len(second["items"]) == 5
                  and [item["id"] for item in members] == expected_ids
                  and all(page["group"] == group and page["total"] == 55 and page["pages"] == 2
                          and page["revision"] == revision and page["summary"] == first["summary"]
                          for page in (first, second))
                  and re.fullmatch(r"[0-9a-f]{32}", revision) is not None)
            valid_durations = [row["duration"] for row in main if isinstance(row["duration"], (int, float))
                               and math.isfinite(row["duration"]) and row["duration"] > 0]
            expected_summary = {
                "bytes": sum(row["size"] for row in main), "duration_min": min(valid_durations),
                "duration_max": max(valid_durations),
                "formats": sorted({row["ext"].strip(" ").lower() for row in main if row["ext"].strip(" ")}),
                "missing_cover": sum(not row["has_cover"] for row in main),
                "missing_lyrics": sum(not row["has_lyrics"] for row in main),
            }
            invalid_summary = detail(invalid_durations[0]["group"])["summary"]
            check("全组概况正确累计64位容量、格式和缺失标记，时长排除非有限与非正数",
                  first["summary"] == expected_summary
                  and invalid_summary["duration_min"] is None and invalid_summary["duration_max"] is None)
            check("详情只返回完整轻量索引字段，缺失音频不会触发文件探测或补读",
                  not root.exists() and all(set(item) == LIGHT_FIELDS and item["path"] in owned_paths
                                           and type(item["has_cover"]) is int and type(item["has_lyrics"]) is int
                                           and item["tags_loaded"] is True and item["path_derived"] is False
                                           for item in members)
                  and first["items"][0]["edited_at"] == 0.0 and first["items"][0]["scraped_at"] == 0.0)
            one = selected(group, revision.upper(), expected_ids[0])
            check("逐首加入只确认指定曲目并返回当前索引，支持大写版本输入",
                  set(one) == {"group", "revision", "total", "track", "selected_at"}
                  and one["group"] == group and one["revision"] == revision and one["total"] == 55
                  and one["track"] == first["items"][0] and one["selected_at"] > 0
                  and selected(group, revision, expected_ids[-1])["track"] == second["items"][-1])
            check("跨组ID、缺失ID或错误版本不能加入已选",
                  selection_status(group, revision, ordinary[0][0]["id"]) == 409
                  and selection_status(group, revision, 9223372036854775807) == 409
                  and stale(group, "0" * 32, expected_ids[0]))
            check("详情夹页仍验证版本，首次请求后续页必须提供版本",
                  detail(group, page=0) == first and detail(group, page=-1) == first
                  and detail(group, page=9223372036854775807, revision=revision) == second
                  and detail(group, page_size=100)["items"] == members
                  and detail_status(group, page=2) == 422
                  and detail_status(ordinary[0][0]["group"], page=2) == 422)
            missing = [f"{marker.lower()} absent", "missing"]
            check("未知组及单成员组首次404，已有版本的消失分组返回409",
                  all(detail_status(key) == 404 and detail_status(key, revision=revision) == 409
                      and selection_status(key, revision, expected_ids[0]) == 409
                      for key in (missing, reserved["group"])))

            long_group = long_rows[0]["group"]
            long_detail = detail(long_group)
            index_definition = _postgres(
                "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() "
                "AND indexname='idx_tracks_duplicate_group_hash';"
            ).lower()
            check("超过4000字及8KB的多字节标签可分组和逐首确认，哈希索引无原始键长度限制",
                  len(long_group[0]) > 4000 and len(long_group[1].encode("utf-8")) > 8192
                  and long_detail["group"] == long_group and long_detail["total"] == 2
                  and selected(long_group, long_detail["revision"], long_rows[0]["id"])["track"]["id"] == long_rows[0]["id"]
                  and any(item["group"] == long_group for item in get("/api/duplicates", q="艺" * 200)["items"])
                  and index_definition.count("md5(") == 2 and "btrim(artist)" in index_definition
                  and "btrim(title)" in index_definition and "where" in index_definition
                  and "tags_loaded" in index_definition and "path_derived" in index_definition)

            invalid_list = [{"q": "艺" * 201}, {"q": "a" * 199 + "  "}, {"q": "a\0b"},
                            {"page_size": 0}, {"page_size": -1}, {"page_size": 51},
                            {"page_size": "NaN"}, {"page": "NaN"}, {"page": 9223372036854775808}]
            list_codes = [client.get(f"{base}/api/duplicates", params=params, timeout=30).status_code
                          for params in invalid_list]
            invalid_groups = [None, {}, [], ["a"], ["a", "b", "c"], [False, "b"], ["", "b"],
                              ["a", "   "], ["a\0", "b"], ["a", "b\0"]]
            invalid_details = [{}, {"group": "not json"}] + [
                {"group": json.dumps(key)} for key in invalid_groups
            ] + [{"group": json.dumps(group), **params} for params in (
                {"page_size": 0}, {"page_size": 101}, {"page": "NaN"}, {"revision": ""},
                {"revision": "a" * 31}, {"revision": "x" * 32},
            )]
            detail_codes = [client.get(f"{base}/api/duplicates/detail", params=params, timeout=30).status_code
                            for params in invalid_details]
            body = {"group": group, "revision": revision, "track_id": expected_ids[0]}
            invalid_bodies = [{key: value for key, value in body.items() if key != missing_key}
                              for missing_key in body]
            invalid_bodies += [{**body, "group": key} for key in invalid_groups]
            invalid_bodies += [{**body, "track_id": value} for value in (0, -1, 1.5, True, "7", None)]
            invalid_bodies += [{**body, "revision": value} for value in (None, 12, "a" * 31, "x" * 32)]
            body_codes = [client.post(f"{base}/api/duplicates/selection", json=payload, timeout=30).status_code
                          for payload in invalid_bodies]
            check("三个疑似重复接口严格校验搜索、分页、JSON分组、版本和曲目ID",
                  list_codes == [422] * len(invalid_list) and detail_codes == [422] * len(invalid_details)
                  and body_codes == [422] * len(invalid_bodies),
                  f"list={list_codes}, detail={detail_codes}, selection={body_codes}")
            read_snapshot = database_digest()
            detail(group)
            selected(group, revision, expected_ids[0])
            get("/api/duplicates", q=marker)
            check("浏览详情和逐首确认均不写索引，也不创建音频或侧车文件",
                  database_digest() == read_snapshot and not root.exists())

            # The last row is outside the first comparison page. Every mutable
            # light-track field must invalidate even a different selected row.
            off_page = main[-1]
            changes = {
                "path": str(root / "changed-path.flac"), "dir": str(root / "changed-directory"),
                "filename": "changed-filename.flac", "ext": "aiff",
                "artist": " " + off_page["artist"] + " ", "title": " " + off_page["title"] + " ",
                "album": "Changed album", "albumartist": "Changed album artist", "genre": "Changed genre",
                "year": "2025", "track": "2", "disc": "2", "language": "Changed language", "albumtype": "live",
                "has_cover": not off_page["has_cover"], "has_lyrics": not off_page["has_lyrics"],
                "duration": off_page["duration"] + 1, "mtime": off_page["mtime"] + 1, "size": off_page["size"] + 1,
                "indexed_at": "2024-01-01T00:00:01Z", "edited_at": "2024-01-02T00:00:00Z",
                "scraped_at": "2024-01-03T00:00:00Z",
            }
            failed_fields = []
            for field, value in changes.items():
                original = off_page[field]
                try:
                    patch(off_page, **{field: value})
                    fresh = detail(group)
                    if not (fresh["revision"] != revision and fresh["total"] == 55
                            and fresh["items"] == first["items"] and stale(group, revision, expected_ids[0])):
                        failed_fields.append(field)
                finally:
                    patch(off_page, **{field: original})
            check("页外任一比较字段改变均使旧详情和另一首曲目的加入请求409",
                  not failed_fields and detail(group)["revision"] == revision,
                  "未使版本失效的字段：" + ", ".join(failed_fields) if failed_fields else f"覆盖{len(changes)}个比较字段")

            added = add("new-member", main[0]["artist"], main[0]["title"])
            insert([added])
            after_add = detail(group)
            add_ok = after_add["total"] == 56 and after_add["revision"] != revision and stale(group, revision, expected_ids[0])
            delete(added)
            check("新增与删除成员分别使旧版本409，回到相同索引内容后版本一致",
                  add_ok and stale(group, after_add["revision"], expected_ids[0])
                  and detail(group)["revision"] == revision)

            outgoing = main[0]
            reserved_values = {field: reserved[field] for field in ("artist", "title")}
            outgoing_title = outgoing["title"]
            try:
                patch(outgoing, title=f"{marker} parked")
                patch(reserved, artist=outgoing["artist"], title=outgoing_title)
                swapped = detail(group, page_size=100)
                swapped_ids = [item["id"] for item in swapped["items"]]
                swap_ok = (swapped["total"] == 55 and max(swapped_ids) == max(expected_ids)
                           and set(swapped_ids) == ((set(expected_ids) - {outgoing["id"]}) | {reserved["id"]})
                           and swapped["revision"] != revision and stale(group, revision, expected_ids[1]))
            finally:
                patch(reserved, **reserved_values)
                patch(outgoing, title=outgoing_title)
            check("相同数量且最大ID不变的成员替换仍被版本校验识别", swap_ok and detail(group)["revision"] == revision)

            eligibility_ok = []
            for field, value in (("tags_loaded", False), ("path_derived", True)):
                original = off_page[field]
                try:
                    patch(off_page, **{field: value})
                    fresh = detail(group)
                    eligibility_ok.append(fresh["total"] == 54 and fresh["revision"] != revision
                                          and stale(group, revision, expected_ids[0]))
                finally:
                    patch(off_page, **{field: original})
            check("标签加载状态或路径推导状态改变会移出分组并拒绝旧版本",
                  all(eligibility_ok) and detail(group)["revision"] == revision)
            small = ordinary[0]
            small_before = detail(small[0]["group"])
            try:
                patch(small[1], tags_loaded=False)
                collapsed_ok = (detail_status(small[0]["group"]) == 404
                                and stale(small[0]["group"], small_before["revision"], small[0]["id"])
                                and get("/api/duplicates", q=small[0]["artist"])["total"] == 0)
            finally:
                patch(small[1], tags_loaded=True)
            check("双成员组退为单成员后不再列出，旧版本不能继续比较或加入",
                  collapsed_ok and detail(small[0]["group"])["revision"] == small_before["revision"])
        finally:
            # Paths were generated locally under this UUID root, never obtained
            # from an API response. Even partial setup cannot target real audio.
            assert all(Path(path).parent == root for path in owned_paths)
            paths_sql = ", ".join(sql_value(path) for path in owned_paths)
            ids_sql = " AND id IN (" + ", ".join(str(track_id) for track_id in owned) + ")" if owned else ""
            _postgres(f"DELETE FROM tracks WHERE path IN ({paths_sql}){ids_sql};")
            remaining = _postgres(f"SELECT count(*) FROM tracks WHERE path IN ({paths_sql});")
            check("疑似重复验收清理仅移除自有索引行，原曲库数据与磁盘均保持完整",
                  remaining == "0" and database_digest() == original_database and not root.exists())
