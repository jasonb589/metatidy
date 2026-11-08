"""Real HTTP/PostgreSQL folder browsing without creating or scanning files.

All mutations are fixture inserts/deletes at exact UUID-owned paths. Indexed
directories deliberately do not exist, including boundary-collision decoys.
"""
from __future__ import annotations

import json
import math
import os
import uuid
from pathlib import Path

import requests

from tests.jobs_acceptance import _postgres


def _literal(value: str) -> str:
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def _database_snapshot() -> str:
    return _postgres("""SELECT jsonb_build_object(
        'tracks',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) FROM tracks t),
        'jobs',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(j)::text),'' ORDER BY id),'')) FROM jobs j));""")


def check_empty_folders(base: str, music: Path, check) -> None:
    """Run before the first scan: the real music files are not indexed yet."""
    root = str(music.resolve())
    before = _database_snapshot()
    response = requests.get(f"{base}/api/folders", timeout=30)
    response.raise_for_status()
    empty = response.json()
    check("目录浏览在首次扫描前返回合法空根目录，不从磁盘自动发现或扫描音乐",
          empty["root"] == empty["current"] == root and empty["parent"] is None
          and empty["breadcrumbs"] == [{"name": Path(root).name or root, "path": root}]
          and empty["scan_root"] == root and empty["can_scan"] is True
          and empty["total"] == empty["total_tracks"] == empty["direct_tracks"] == empty["bytes"] == 0
          and empty["page"] == 1 and empty["page_size"] == 50 and empty["pages"] == 0
          and empty["items"] == [] and _database_snapshot() == before)


def check_folders(base: str, music: Path, check) -> None:
    nonce = uuid.uuid4().hex
    marker = f"FolderFixture-{nonce}"
    library = music.resolve()
    scope = library / f"__folders_index_only_{nonce}_目录__"
    collision = library / f"{scope.name}-collision"
    outside = library.parent / f"{library.name}2-{nonce}"
    root_file = library / f"{marker}-root.flac"
    assert scope.parent == collision.parent == library
    assert outside.parent == library.parent and not outside.is_relative_to(library)
    assert all(not path.exists() for path in (scope, collision, outside, root_file))
    columns = {
        "path": "text", "dir": "text", "filename": "text", "ext": "text", "size": "bigint",
        "title": "text", "artist": "text", "album": "text", "albumartist": "text", "genre": "text",
        "year": "text", "language": "text", "albumtype": "text", "has_cover": "boolean",
        "has_lyrics": "boolean", "tags_loaded": "boolean", "path_derived": "boolean",
    }
    rows: list[dict] = []
    owned: dict[int, dict] = {}

    def add(directory: Path, name: str, **values):
        path = directory / f"{name}.flac"
        assert path == root_file or any(path.is_relative_to(root) for root in (scope, collision, outside))
        assert not path.exists()
        row = {"path": str(path), "dir": str(directory), "filename": path.name, "ext": "flac",
               "size": 2**31 + len(rows), "title": f"{marker} Track{len(rows):03}", "artist": marker,
               "album": f"{marker} Album", "albumartist": marker, "genre": "FolderFixtureGenre",
               "year": "2026", "language": "中文", "albumtype": "studio", "has_cover": False,
               "has_lyrics": False, "tags_loaded": True, "path_derived": False, **values}
        rows.append(row)
        return row

    top = [add(scope, f"top-{index}", has_cover=index == 0, has_lyrics=index != 1,
               tags_loaded=index != 2, path_derived=index == 2) for index in range(3)]
    for index in range(55):
        child = scope / f"Child-{index:02}"
        add(child, "direct", has_cover=index % 2 == 0)
        add(child / "Disc 1", "nested", has_lyrics=index % 3 == 0)
    special_names = ["percent%name", "percentXname", "under_name", "underXname", "bang!name", "bangXname",
                     "quote'name", "  spaced  ", "spaced", " leading", "trailing "]
    if os.name != "nt":
        special_names.append("back\\slash")
    special = {name: add(scope / name, "literal") for name in special_names}
    special_nested = {name: add(scope / name / "Disc Literal", "literal-descendant") for name in special_names}
    nested_only = add(scope / "OnlyGrandchildren" / "NeedleOnlyGrandchild", "nested-only")
    separated = add(scope / "back" / "slash", "native-separated")
    root_row = add(library, root_file.stem)
    collision_row = add(collision, "collision")
    outside_row = add(outside, "outside")
    owned_paths = {row["path"] for row in rows}
    before = _database_snapshot()

    def inside(row, folder, recursive=True):
        directory = row["dir"]
        prefix = str(folder).rstrip(os.sep) + os.sep
        return directory == str(folder) or recursive and directory.startswith(prefix)

    def expected_children(folder):
        prefix = str(folder).rstrip(os.sep) + os.sep
        grouped = {}
        for row in rows:
            if not row["dir"].startswith(prefix):
                continue
            name = row["dir"][len(prefix):].split(os.sep, 1)[0]
            path = str(Path(folder) / name)
            item = grouped.setdefault(name, {"name": name, "path": path, "track_count": 0, "direct_tracks": 0, "bytes": 0})
            item["track_count"] += 1
            item["direct_tracks"] += row["dir"] == path
            item["bytes"] += row["size"]
        return sorted(grouped.values(), key=lambda item: item["name"].encode("utf-8"))

    with requests.Session() as client:
        def get(route, **params):
            response = client.get(f"{base}{route}", params=params, timeout=60)
            response.raise_for_status()
            return response.json()

        def folders(folder=scope, **params):
            return get("/api/folders", folder=str(folder), **params)

        def tracks(folder=scope, **params):
            return get("/api/tracks", folder=str(folder), page_size=1000, **params)

        def ids(result):
            return {item["id"] for item in result["items"]}

        initial_root = get("/api/folders")
        try:
            fields = ", ".join(columns)
            record = ", ".join(f"{field} {kind}" for field, kind in columns.items())
            document = _literal(json.dumps(rows, ensure_ascii=False))
            inserted = json.loads(_postgres(
                f"WITH inserted AS (INSERT INTO tracks ({fields}) SELECT {fields} "
                f"FROM jsonb_to_recordset({document}::jsonb) AS fixture({record}) RETURNING id,path) "
                "SELECT jsonb_agg(to_jsonb(inserted) ORDER BY id) FROM inserted;"
            ))
            by_path = {row["path"]: row for row in rows}
            assert len(inserted) == len(rows)
            for item in inserted:
                row = by_path[item["path"]]
                row["id"] = item["id"]
                owned[row["id"]] = row
            inserted_snapshot = _database_snapshot()
            expected = expected_children(scope)
            first = folders()
            pages = [first] + [folders(page=page) for page in range(2, first["pages"] + 1)]
            items = [item for page in pages for item in page["items"]]
            scoped = [row for row in rows if inside(row, scope)]
            totals = {"total_tracks": len(scoped), "direct_tracks": len(top), "bytes": sum(row["size"] for row in scoped)}
            check("目录超过50个子项完整分页，按名称稳定排列并汇总所有后代曲目",
                  len(expected) > 50 and items == expected
                  and all(page["total"] == len(expected) and page["page"] == ordinal and page["page_size"] == 50
                          and page["pages"] == math.ceil(len(expected) / 50)
                          and all(page[key] == value for key, value in totals.items())
                          for ordinal, page in enumerate(pages, 1)))
            check("不存在于磁盘的目录仍可从索引浏览，容量使用64位且含快速索引记录",
                  first["bytes"] > 2**32 and first["direct_tracks"] == 3
                  and tracks(folder_recursive="false")["total"] == 3
                  and top[-1]["id"] in ids(tracks(folder_recursive="false"))
                  and all(not path.exists() for path in (scope, collision, outside, root_file)))
            check("目录分页重复读取稳定，负页与超大页夹取且最大页容量100",
                  folders() == first and folders(page=-9) == first and folders(page=0) == first
                  and folders(page=9223372036854775807) == pages[-1]
                  and folders(page_size=100)["items"] == expected)
            literal_terms = ("%", "_", "!", "'")
            literal_results = [(term, folders(q=term, page_size=100)) for term in literal_terms]
            check("子目录搜索将百分号下划线感叹号引号作为字面值，并保持范围汇总",
                  all(result["items"] == [item for item in expected if term in item["name"]]
                      and result["total"] == sum(term in item["name"] for item in expected)
                      and all(result[key] == value for key, value in totals.items())
                      for term, result in literal_results))
            grandchild_search = folders(q="NeedleOnlyGrandchild")
            check("目录搜索仅匹配直接子目录名，不因孙目录名或曲目标签扩大结果",
                  grandchild_search["total"] == grandchild_search["pages"] == 0
                  and grandchild_search["items"] == [] and grandchild_search["page"] == 1
                  and all(grandchild_search[key] == value for key, value in totals.items())
                  and folders(q=marker)["items"] == []
                  and folders(q="  child-0  ", page_size=100)["items"] == [item for item in expected if "child-0" in item["name"].lower()]
                  and folders(q="  spaced  ")["items"] == [item for item in expected if "spaced" in item["name"]])

            deep_path = scope / "OnlyGrandchildren" / "NeedleOnlyGrandchild"
            deep = folders(deep_path)
            middle = folders(deep_path.parent)
            crumb_paths = [library, scope, deep_path.parent, deep_path]
            check("面包屑逐级保留绝对目录身份，只有孙目录有曲目时父级仍可浏览",
                  deep["root"] == str(library) and deep["current"] == str(deep_path)
                  and deep["parent"] == str(deep_path.parent)
                  and deep["breadcrumbs"] == [{"name": path.name or str(path), "path": str(path)} for path in crumb_paths]
                  and deep["total_tracks"] == deep["direct_tracks"] == 1 and deep["bytes"] == nested_only["size"]
                  and deep["total"] == deep["pages"] == 0 and deep["items"] == []
                  and middle["direct_tracks"] == 0 and middle["total_tracks"] == 1
                  and middle["items"] == expected_children(deep_path.parent)
                  and first["parent"] == str(library))
            leading = folders(scope / " leading")
            trailing = folders(scope / "trailing ")
            check("扫描入口返回原样绝对目录，旧扫描器会修剪的尾空格目录明确不可预填",
                  first["scan_root"] == str(scope) and first["can_scan"] is True
                  and deep["scan_root"] == str(deep_path) and deep["can_scan"] is True
                  and leading["scan_root"] == str(scope / " leading") and leading["can_scan"] is True
                  and trailing["scan_root"] == str(scope / "trailing ") and trailing["can_scan"] is False)

            recursive = tracks()
            direct = tracks(folder_recursive="false")
            child = scope / "Child-00"
            child_rows = [row for row in scoped if inside(row, child)]
            check("按目录筛曲默认递归，关闭递归只含当前层且不跨越相邻前缀目录",
                  recursive["total"] == len(scoped) and ids(recursive) == {row["id"] for row in scoped}
                  and ids(direct) == {row["id"] for row in top}
                  and ids(tracks(child)) == {row["id"] for row in child_rows}
                  and ids(tracks(child, folder_recursive="0")) == {row["id"] for row in child_rows if row["dir"] == str(child)}
                  and {collision_row["id"], outside_row["id"], root_row["id"]}.isdisjoint(ids(recursive)))
            check("目录递归布尔参数沿用既有解析规则，显式关闭和默认递归一致可预测",
                  all(ids(tracks(folder_recursive=value)) == ids(recursive) for value in ("", "1", "true", " ON ", "yes"))
                  and all(ids(tracks(folder_recursive=value)) == ids(direct) for value in ("0", "false", " OFF ", "no")))
            filtered = tracks(folder_recursive="false", artist=marker, album=top[1]["album"], genre=top[1]["genre"],
                              language="中文", year="2026", albumtype="studio", missing_cover=1, missing_lyrics=1,
                              q=top[1]["title"], album_group=json.dumps([top[1]["album"], marker]))
            check("目录范围与已有标签、专辑分组、缺失项和搜索筛选使用AND而不替换",
                  ids(filtered) == {top[1]["id"]}
                  and ids(tracks(folder_recursive="false", not_loaded=1)) == {top[2]["id"]}
                  and tracks(artist=f"{marker}-absent")["total"] == 0
                  and tracks(scope / "OnlyGrandchildren", folder_recursive="false")["total"] == 0)
            special_ok = all(ids(tracks(scope / name)) == {row["id"], special_nested[name]["id"]}
                             and ids(tracks(scope / name, folder_recursive="false")) == {row["id"]}
                             and folders(scope / name)["current"] == str(scope / name)
                             for name, row in special.items())
            check("带空格、引号和通配字符的目录路径保持精确身份并可独立筛曲", special_ok)
            if os.name != "nt":
                backslash = special["back\\slash"]
                check("Linux反斜线是目录名字符，不会变成另一层目录分隔符",
                      ids(tracks(scope / "back\\slash")) == {backslash["id"], special_nested["back\\slash"]["id"]}
                      and ids(tracks(scope / "back")) == {separated["id"]}
                      and folders(q="\\")["items"] == [item for item in expected if "\\" in item["name"]]
                      and folders(scope / "back\\slash")["can_scan"] is True)

            root = get("/api/folders")
            root_rows = [row for row in rows if inside(row, library)]
            root_filtered = get("/api/folders", q=scope.name, page_size=100)
            check("根目录保留直属曲目与递归汇总，音乐根相邻music2前缀索引不混入",
                  root["root"] == root["current"] == str(library) and root["parent"] is None
                  and root["total_tracks"] == initial_root["total_tracks"] + len(root_rows)
                  and root["direct_tracks"] == initial_root["direct_tracks"] + 1
                  and root["bytes"] == initial_root["bytes"] + sum(row["size"] for row in root_rows)
                  and root_filtered["total"] == 2 and {item["path"] for item in root_filtered["items"]} == {str(scope), str(collision)}
                  and root_row["id"] in ids(tracks(library, folder_recursive="false"))
                  and outside_row["id"] not in ids(tracks(library)))
            check("省略或空目录参数保持既有曲库列表行为，目录浏览空参数定位根目录",
                  folders("") == root and folders(library) == root
                  and ids(get("/api/tracks", q=marker, page_size=1000)) == {row["id"] for row in rows}
                  and ids(get("/api/tracks", folder="", q=marker, page_size=1000)) == {row["id"] for row in rows})

            invalid_paths = ["relative/path", " ", str(outside), str(library.parent),
                             str(scope) + os.sep, str(scope) + os.sep + os.sep + "Child-00",
                             str(scope) + os.sep + "." + os.sep + "Child-00",
                             str(scope) + os.sep + ".." + os.sep + "Child-00", str(scope) + "\0"]
            invalid_codes = [client.get(f"{base}{route}", params={"folder": path}, timeout=30).status_code
                             for path in invalid_paths for route in ("/api/folders", "/api/tracks")]
            unknown = str(scope / "does-not-exist")
            check("目录范围拒绝相对路径、越界、路径穿越、重复分隔符及NUL，未知子目录404",
                  invalid_codes == [400] * (len(invalid_paths) * 2)
                  and client.get(f"{base}/api/folders", params={"folder": unknown}, timeout=30).status_code == 404
                  and tracks(unknown)["total"] == 0, str(invalid_codes))
            bad_queries = [{"page_size": 0}, {"page_size": -1}, {"page_size": 101}, {"page_size": "NaN"},
                           {"page": "NaN"}, {"page": 9223372036854775808}, {"q": "字" * 201},
                           {"q": "a" * 199 + "  "}, {"q": "x\0y"}]
            query_codes = [client.get(f"{base}/api/folders", params={"folder": str(scope), **params}, timeout=30).status_code
                           for params in bad_queries]
            bool_codes = [client.get(f"{base}/api/tracks", params={"folder": str(scope), "folder_recursive": value}, timeout=30).status_code
                          for value in ("maybe", "2", "null")]
            check("目录分页、搜索长度和递归布尔值严格校验，非法参数返回422",
                  query_codes == [422] * len(bad_queries) and bool_codes == [422] * 3
                  and folders(q="字" * 200)["total"] == 0,
                  f"folders={query_codes}, recursive={bool_codes}")

            check("浏览目录与筛曲不产生扫描任务、不写索引或创建磁盘文件",
                  _database_snapshot() == inserted_snapshot
                  and all(not path.exists() for path in (scope, collision, outside, root_file)))
        finally:
            assert all(path == str(root_file) or any(Path(path).is_relative_to(root) for root in (scope, collision, outside))
                       for path in owned_paths)
            paths_sql = ", ".join(_literal(path) for path in owned_paths)
            ids_sql = " AND id IN (" + ", ".join(str(track_id) for track_id in owned) + ")" if owned else ""
            _postgres(f"DELETE FROM tracks WHERE path IN ({paths_sql}){ids_sql};")
            check("目录验收仅清理自有UUID索引夹具，原曲库及任务数据保持完整",
                  _database_snapshot() == before
                  and _postgres(f"SELECT count(*) FROM tracks WHERE path IN ({paths_sql});") == "0"
                  and all(not path.exists() for path in (scope, collision, outside, root_file)))
