"""Index-only artist browsing, exact scopes and coherent full-album snapshots.

UUID-owned rows deliberately point to unavailable or invalid audio. Browsing
must neither parse them nor contact portrait providers or mutate stored data.
"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from pathlib import Path

import requests

from tests.collections_acceptance import _database_snapshot, _literal
from tests.jobs_acceptance import _postgres


def check_artists(base: str, music: Path, check) -> None:
    marker = "ArtistBrowse-" + uuid.uuid4().hex
    root = music.resolve() / marker
    assert root.parent == music.resolve() and not root.exists()
    root.mkdir()
    sentinel = root / "1.flac"
    sentinel.write_bytes(b"Artist browsing must never parse this invalid audio file.\n")
    original_disk = (hashlib.sha256(sentinel.read_bytes()).hexdigest(), sentinel.stat().st_mtime_ns)
    before = _database_snapshot()
    main = marker + " A & B / 原组合"
    album = marker + " 同名专辑"
    va = marker + " Various A"
    vb = marker + " Various B"
    unicode_name = "\u3000" + main + "\u3000"
    special = marker + " Needle 100%_Mix! O'Brien 🎵"
    rows = []
    identifiers = []
    move_tokens = set()
    for n in range(1, 206):
        rows.append({"artist": "  " + main + " " if n % 2 else main,
                     "album": album if n <= 202 else (marker + " Fallback" if n == 203 else "  "),
                     "albumartist": va if n <= 101 else vb if n <= 202 else " ",
                     "track": str(n % 20 + 1), "disc": str(n // 100 + 1)})
    rows.extend([
        {"artist": marker + " Guest", "album": album, "albumartist": va},
        {"artist": marker + " Separate", "album": album, "albumartist": marker + " Different"},
        {"artist": unicode_name, "album": ""}, {"artist": special, "album": ""},
        {"artist": marker + " Empty Albums", "album": " "},
        {"artist": "   ", "album": marker + " Missing Artist"},
        {"artist": "", "album": marker + " Missing Artist"},
    ])
    rows.extend({"artist": marker + f" Small {n:03}", "album": ""} for n in range(27))
    for n, row in enumerate(rows, 1):
        row.update(path=str(root / f"{n}.flac"), dir=str(root), filename=f"{n}.flac", title=f"{marker} track {n}",
                   duration=float(n), size=n * 100, has_cover=n % 2 == 0, has_lyrics=n % 3 == 0, tags_loaded=n % 4 != 0)
        row.setdefault("albumartist", "")
        row.setdefault("track", "")
        row.setdefault("disc", "")
    client = requests.Session()
    client.trust_env = False
    route = "/api/library/artists"

    def get(path=route, *, expected=200, code=None, **params):
        response = client.get(base + path, params=params, timeout=60)
        assert response.status_code == expected, (path, response.status_code, response.text[:600])
        data = response.json()
        if code:
            assert data.get("detail", {}).get("code") == code, data
        return data

    def detail(name=main, **params):
        return get(route + "/detail", artist_group=name, **params)

    def scoped(name, **params):
        return get("/api/tracks", artist_group=name, page_size=1000, **params)

    def patch(identifier, **fields):
        assert identifier in identifiers and set(fields) <= {"artist", "title", "album", "has_cover"}
        values = ",".join(key + "=" + ("true" if value is True else "false" if value is False else _literal(value)) for key, value in fields.items())
        _postgres(f"UPDATE tracks SET {values} WHERE id={identifier} AND dir={_literal(str(root))};")

    try:
        encoded = _literal(json.dumps(rows, ensure_ascii=False))
        inserted = json.loads(_postgres(f"""WITH inserted AS (
            INSERT INTO tracks(path,dir,filename,ext,title,artist,album,albumartist,track,disc,duration,size,
                has_cover,has_lyrics,tags_loaded,path_derived,indexed_at)
            SELECT path,dir,filename,'flac',title,artist,album,albumartist,track,disc,duration,size,
                has_cover,has_lyrics,tags_loaded,NOT tags_loaded,'2026-01-01'::timestamptz + duration * interval '1 second'
            FROM jsonb_to_recordset({encoded}::jsonb) AS source(path text,dir text,filename text,title text,
                artist text,album text,albumartist text,track text,disc text,duration double precision,size bigint,
                has_cover boolean,has_lyrics boolean,tags_loaded boolean) RETURNING id,path,filename)
            SELECT jsonb_agg(to_jsonb(inserted) ORDER BY replace(filename,'.flac','')::integer) FROM inserted;"""))
        identifiers = [row["id"] for row in inserted]
        assert len(identifiers) == len(rows)
        indexed_before = _database_snapshot()
        expected_names = {row["artist"].strip(" ") for row in rows if row["artist"].strip(" ")}
        first = get(q=marker, page_size=24)
        pages = [first] + [get(q=marker, page_size=24, page=page) for page in range(2, first["pages"] + 1)]
        listed = [item for page in pages for item in page["items"]]
        check("艺术家列表完整分页，组合名称不拆分且ASCII空格合并、Unicode空格保留",
              first["total"] == len(expected_names) and len(listed) == len(expected_names)
              and {item["name"] for item in listed} == expected_names and main in expected_names and unicode_name in expected_names
              and first["q"] == marker and first["sort"] == "name" and first["order"] == "asc")
        summary = next(item for item in listed if item["name"] == main)
        check("艺术家摘要汇总全部曲目，并按专辑名与专辑艺术家准确计数",
              summary["track_count"] == 205 and summary["album_count"] == 3 and summary["unalbumed_count"] == 2
              and summary["duration"] == sum(range(1, 206)) and summary["bytes"] == sum(range(1, 206)) * 100
              and summary["missing_cover"] == 103 and summary["missing_lyrics"] == 137 and summary["not_loaded"] == 51
              and isinstance(summary["indexed_at"], (int, float)))
        check("搜索按字面处理百分号下划线感叹号引号与Unicode",
              [item["name"] for item in get(q="100%_Mix! O'Brien 🎵")["items"]] == [special]
              and get(q="not-present-" + marker)["items"] == [])
        for sort, field in [("tracks", "track_count"), ("recent", "indexed_at")]:
            for order in ("asc", "desc"):
                items = get(q=marker, sort=sort, order=order, page_size=100)["items"]
                check(f"艺术家{sort}/{order}排序正确且无重复", [item[field] for item in items] == sorted([item[field] for item in items], reverse=order == "desc")
                      and len({item["name"] for item in items}) == len(items))
        last = get(q=marker, page=999, page_size=24)
        empty = get(q="missing-" + marker, page=999)
        check("艺术家页码回落末页，空结果保留完整空分页", last["page"] == first["pages"]
              and empty["total"] == empty["pages"] == 0 and empty["page"] == 1 and empty["items"] == [])

        albums = detail(page_size=1)
        revision = albums["revision"]
        all_albums = [*albums["items"]]
        for page in range(2, albums["pages"] + 1):
            value = detail(page_size=1, page=page, revision=revision)
            assert value["summary"] == summary and value["revision"] == revision
            all_albums.extend(value["items"])
        contributions = {(item["album"], item["album_artist"]): (item["track_count"], item["artist_track_count"]) for item in all_albums}
        check("艺术家专辑分页显示整张合辑统计和本艺术家贡献，绝不混淆同名专辑",
              albums["summary"] == summary and albums["total"] == 3 and contributions == {
                  (album, va): (102, 101), (album, vb): (101, 101), (marker + " Fallback", main): (1, 1)})
        for item in all_albums:
            group = json.dumps([item["album"], item["album_artist"]], ensure_ascii=False)
            standard = get("/api/albums/detail", album_group=group)["summary"]
            assert {key: value for key, value in item.items() if key != "artist_track_count"} == standard
        check("艺术家专辑卡片字段与原专辑详情完全一致", True)
        tracks = detail(section="tracks", page_size=200, revision=revision)
        second = detail(section="tracks", page_size=200, page=2, revision=revision)
        detail_ids = [item["id"] for item in tracks["items"] + second["items"]]
        check("曲目分页和全局摘要共用版本，超过200首完整到达第二页",
              tracks["summary"] == second["summary"] == summary and tracks["total"] == 205
              and len(tracks["items"]) == 200 and len(second["items"]) == 5
              and set(detail_ids) == set(identifiers[:205]) and len(set(detail_ids)) == 205
              and tracks["revision"] == second["revision"] == revision)
        check("艺术家精确曲库范围包含边缘ASCII空格标签并保留原标签原文",
              scoped(" " + main + " ")["total"] == 205 and scoped(unicode_name)["total"] == 1
              and any(row["artist"].startswith("  ") for row in scoped(main)["items"])
              and get("/api/tracks", artist=main, page_size=1000)["total"] == 102)
        prepared = client.post(base + "/api/tracks/filtered-selection", json={"query": {"artist_group": " " + main + " ", "sort": "path"}}, timeout=60)
        prepared.raise_for_status()
        selection = prepared.json()
        check("艺术家范围贯通整批选择且canonical保留精确分组", selection["query"]["artist_group"] == main
              and selection["total"] == 205 and {item["id"] for item in selection["items"]} == set(identifiers[:205]))
        only_tracks = detail(marker + " Empty Albums")
        check("仅有无专辑曲目的艺术家仍可打开，专辑为空而摘要保留曲目", only_tracks["total"] == 0
              and only_tracks["pages"] == 0 and only_tracks["page"] == 1 and only_tracks["items"] == []
              and only_tracks["summary"]["track_count"] == only_tracks["summary"]["unalbumed_count"] == 1)
        legacy = get("/api/artists", q=marker, page_size=100)
        check("头像工具旧artists接口响应合同保持兼容", all(set(item) == {"name", "track_count", "album_count"} for item in legacy["items"])
              and next(item for item in legacy["items"] if item["name"] == main)["album_count"] == 2)
        check("艺术家浏览和精确选择只读索引，不读音乐不改变数据库", _database_snapshot() == indexed_before
              and original_disk == (hashlib.sha256(sentinel.read_bytes()).hexdigest(), sentinel.stat().st_mtime_ns)
              and list(root.iterdir()) == [sentinel])

        move_response = client.post(base + "/api/move/preview", json={"filters": {"artist_group": " " + main + " "},
             "dir_template": "{artist}/{album}", "filename_template": "{title}.{ext}"}, timeout=60)
        move_response.raise_for_status()
        move_plan = move_response.json()
        move_tokens.add(move_plan["token"])
        check("整理预览遵循艺术家精确范围，不扩大到同名合辑的其他歌手",
              move_plan["total"] == 205 and {item["track_id"] for item in move_plan["items"]} == set(identifiers[:205]))

        # A guest's edit changes whole-album stats and must invalidate the artist
        # detail even when no own track was edited. An unrelated album must not.
        patch(identifiers[206], title="unrelated edit")
        unchanged = detail(revision=revision)
        check("无关艺术家专辑变更不使当前详情失效", unchanged["revision"] == revision)
        patch(identifiers[205], has_cover=False)
        get(route + "/detail", artist_group=main, revision=revision, expected=409, code="artist_changed")
        check("相关合辑的其他歌手改动使旧详情版本失效", True)
        refreshed = detail(section="tracks")
        original_title = rows[0]["title"]
        patch(identifiers[0], title="temporary ABA")
        patch(identifiers[0], title=original_title)
        get(route + "/detail", artist_group=main, revision=refreshed["revision"], expected=409, code="artist_changed")
        check("艺术家详情检测A→B→A索引变化，拒绝混用分页快照", True)

        # One response must not mix summary from one committed update with rows
        # from another. The updater touches only the owned artist's records.
        failures = []
        main_ids = ",".join(map(str, identifiers[:205]))
        def update_snapshots():
            try:
                statements = []
                for value in range(1, 17):
                    amount = value % 2 + 1
                    statements.append(f"BEGIN; UPDATE tracks SET duration={amount},title='snapshot-{amount}' WHERE id=ANY(ARRAY[{main_ids}]::bigint[]); COMMIT; SELECT pg_sleep(0.015);")
                _postgres("\n".join(statements))
            except Exception as exc:
                failures.append(str(exc))
        worker = threading.Thread(target=update_snapshots)
        worker.start()
        consistent = []
        try:
            for _ in range(12):
                response = detail(section="tracks", page_size=200)
                durations = {item["duration"] for item in response["items"]}
                if durations in ({1.0}, {2.0}):
                    consistent.append(response["summary"]["duration"] == next(iter(durations)) * 205
                                      and all(item["title"] == f"snapshot-{int(item['duration'])}" for item in response["items"]))
                else:
                    # A request can precede the first update; it still has the
                    # original complete summary and original per-track values.
                    consistent.append(response["summary"]["duration"] == sum(range(1, 206))
                                      and all(item["title"].startswith(marker + " track ") for item in response["items"]))
        finally:
            worker.join(timeout=50)
        check("并发索引更新时艺术家摘要与当前曲目页保持同一事务快照", not worker.is_alive() and not failures and all(consistent), str(failures))
        for params in [{"artist_group": ""}, {"artist_group": " "}, {"artist_group": "a\0b"}, {"artist_group": "艺" * 4001}, {"artist_group": " " + "艺" * 4000},
                       {"artist_group": main, "revision": "bad"}, {"artist_group": main, "section": "unknown"},
                       {"artist_group": main, "page_size": 101}, {"artist_group": main, "section": "tracks", "page_size": 201},
                       {"artist_group": main, "path": "/arbitrary"}]:
            get(route + "/detail", expected=400, code="invalid_request", **params)
        for params in [{"sort": "wrong"}, {"order": "DROP"}, {"page": 0}, {"page_size": 101}, {"q": "x\0y"}, {"q": "字" * 4001}, {"path": "unknown"}]:
            get(expected=400, code="invalid_request", **params)
        get(route + "/detail", artist_group=marker + " absent", expected=404, code="artist_missing")
        check("无效艺术家参数严格拒绝，缺失艺术家返回明确404", True)
        # Existing navigation cannot silently broaden a move preview to the
        # whole library when a malformed/non-string artist group is supplied.
        invalid_move = client.post(base + "/api/move/preview", json={"filters": {"artist_group": [main]}}, timeout=30)
        check("整理预览拒绝非字符串艺术家范围，不隐式扩大到整库", invalid_move.status_code == 400)
    finally:
        client.close()
        if identifiers:
            _postgres(f"DELETE FROM tracks WHERE id=ANY(ARRAY[{','.join(map(str,identifiers))}]::bigint[]) AND dir={_literal(str(root))};")
        if move_tokens:
            _postgres("DELETE FROM move_plans WHERE token IN (" + ",".join(map(_literal,move_tokens)) + ");")
        assert root.parent == music.resolve() and set(root.iterdir()) == {sentinel}
        sentinel.unlink()
        root.rmdir()
    check("艺术家验收仅清理自有索引与夹具，原数据库保持完整", _database_snapshot() == before)
