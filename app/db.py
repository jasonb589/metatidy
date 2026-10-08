"""SQLite 索引层。

核心表：
- tracks        每首歌一行，存放全部已解析的标签字段（浏览/搜索只查这里）
- settings      用户可改设置（模板、开关等）
- alias_artist  歌手别名库
- alias_album   专辑别名库
- jobs          后台任务（扫描/刮削/移动）的状态
- move_plans    整理计划（预览后需凭 token 执行，避免「看一眼就动文件」）

线程安全：每线程一个连接（threading.local），写入用全局锁串行化，WAL 模式支持并发读。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

from .config import USER_SETTING_DEFAULTS

_local = threading.local()
_db_path: str = ""
_write_lock = threading.RLock()

# tracks 表里可被编辑/写入的标签字段
EDITABLE_FIELDS: tuple[str, ...] = (
    "title",
    "artist",
    "album",
    "albumartist",
    "genre",
    "year",
    "track",
    "disc",
    "language",
    "composer",
    "lyricist",
    "copyright",
    "albumtype",
    "comment",
    "mb_artist_id",
    "release_group_id",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    path              TEXT NOT NULL UNIQUE,
    dir               TEXT NOT NULL DEFAULT '',
    filename          TEXT NOT NULL DEFAULT '',
    ext               TEXT NOT NULL DEFAULT '',
    mtime             REAL NOT NULL DEFAULT 0,
    size              INTEGER NOT NULL DEFAULT 0,
    title             TEXT DEFAULT '',
    artist            TEXT DEFAULT '',
    album             TEXT DEFAULT '',
    albumartist       TEXT DEFAULT '',
    genre             TEXT DEFAULT '',
    year              TEXT DEFAULT '',
    track             TEXT DEFAULT '',
    disc              TEXT DEFAULT '',
    language          TEXT DEFAULT '',
    composer          TEXT DEFAULT '',
    lyricist          TEXT DEFAULT '',
    copyright         TEXT DEFAULT '',
    albumtype         TEXT DEFAULT '',
    comment           TEXT DEFAULT '',
    mb_artist_id      TEXT DEFAULT '',
    release_group_id  TEXT DEFAULT '',
    has_cover         INTEGER NOT NULL DEFAULT 0,
    has_lyrics        INTEGER NOT NULL DEFAULT 0,
    duration          REAL NOT NULL DEFAULT 0,
    extra             TEXT DEFAULT '{}',
    indexed_at        REAL NOT NULL DEFAULT 0,
    edited_at         REAL NOT NULL DEFAULT 0,
    scraped_at        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_dir    ON tracks(dir);
CREATE INDEX IF NOT EXISTS idx_tracks_albumartist ON tracks(albumartist);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_artist (
    from_name TEXT PRIMARY KEY,
    to_name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_album (
    from_name TEXT PRIMARY KEY,
    to_name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    state      TEXT NOT NULL,
    total      INTEGER NOT NULL DEFAULT 0,
    done       INTEGER NOT NULL DEFAULT 0,
    message    TEXT DEFAULT '',
    error      TEXT DEFAULT '',
    result     TEXT DEFAULT '',
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS move_plans (
    token      TEXT PRIMARY KEY,
    created_at REAL NOT NULL DEFAULT 0,
    payload    TEXT NOT NULL,
    executed   INTEGER NOT NULL DEFAULT 0
);
"""


def init(db_path: str | Path) -> None:
    """初始化数据库（幂等）。"""
    global _db_path
    _db_path = str(db_path)
    Path(_db_path).parent.mkdir(parents=True, exist_ok=True)
    c = conn()
    with _write_lock:
        c.executescript(SCHEMA)
        c.commit()
    # 补种默认设置（不覆盖已有值）
    with _write_lock:
        for k, v in USER_SETTING_DEFAULTS.items():
            c.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (k, json.dumps(v, ensure_ascii=False)),
            )
        c.commit()


def conn() -> sqlite3.Connection:
    """取得当前线程的连接（惰性创建）。"""
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(_db_path, timeout=30.0, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA busy_timeout=30000")
        c.execute("PRAGMA temp_store=MEMORY")
        c.execute("PRAGMA cache_size=-32000")
        _local.conn = c
    return c


def close_all() -> None:
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            c.close()
        finally:
            _local.conn = None


# --------------------------------------------------------------------------- 写


def execute(sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
    c = conn()
    with _write_lock:
        cur = c.execute(sql, params)
        c.commit()
        return cur


def executemany(sql: str, seq: Iterable[Sequence[Any]]) -> None:
    c = conn()
    with _write_lock:
        c.executemany(sql, seq)
        c.commit()


def upsert_track(data: dict) -> int:
    """按 path 插入或更新一条曲目索引，返回 rowid。"""
    fields = [
        "path",
        "dir",
        "filename",
        "ext",
        "mtime",
        "size",
        "title",
        "artist",
        "album",
        "albumartist",
        "genre",
        "year",
        "track",
        "disc",
        "language",
        "composer",
        "lyricist",
        "copyright",
        "albumtype",
        "comment",
        "mb_artist_id",
        "release_group_id",
        "has_cover",
        "has_lyrics",
        "duration",
        "extra",
        "indexed_at",
        "edited_at",
        "scraped_at",
    ]
    row = {k: data.get(k) for k in fields}
    row["path"] = data["path"]
    row.setdefault("extra", "{}")
    row["indexed_at"] = data.get("indexed_at") or time.time()
    row["edited_at"] = data.get("edited_at") or 0.0
    row["scraped_at"] = data.get("scraped_at") or 0.0
    for k in fields:
        if row.get(k) is None:
            row[k] = "" if k not in {"mtime", "size", "duration", "indexed_at", "edited_at", "scraped_at"} else 0

    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    updates = ", ".join(f"{k}=excluded.{k}" for k in fields if k != "path")
    sql = (
        f"INSERT INTO tracks ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT(path) DO UPDATE SET {updates}"
    )
    c = conn()
    with _write_lock:
        cur = c.execute(sql, [row[k] for k in fields])
        c.commit()
        rid = cur.lastrowid
    if rid:
        return int(rid)
    got = conn().execute("SELECT id FROM tracks WHERE path=?", (data["path"],)).fetchone()
    return int(got["id"]) if got else 0


def update_track_fields(track_id: int, fields: dict, touch_edited: bool = True) -> None:
    """只更新给定字段（用于元数据编辑落库）。"""
    allowed = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS or k in {"has_cover", "has_lyrics", "duration", "path", "dir", "filename", "ext", "mtime", "size"}}
    if not allowed and not touch_edited:
        return
    sets = [f"{k}=?" for k in allowed]
    params: list[Any] = list(allowed.values())
    if touch_edited:
        sets.append("edited_at=?")
        params.append(time.time())
    params.append(track_id)
    execute(f"UPDATE tracks SET {', '.join(sets)} WHERE id=?", params)


def set_track_path(track_id: int, new_path: str) -> None:
    p = Path(new_path)
    execute(
        "UPDATE tracks SET path=?, dir=?, filename=?, ext=? WHERE id=?",
        (str(p), str(p.parent), p.name, p.suffix.lower(), track_id),
    )


def delete_tracks(paths: Sequence[str]) -> int:
    if not paths:
        return 0
    c = conn()
    n = 0
    with _write_lock:
        for i in range(0, len(paths), 500):
            chunk = paths[i : i + 500]
            marks = ",".join("?" for _ in chunk)
            cur = c.execute(f"DELETE FROM tracks WHERE path IN ({marks})", chunk)
            n += cur.rowcount or 0
        c.commit()
    return n


# --------------------------------------------------------------------------- 读


def get_track(track_id: int) -> dict | None:
    row = conn().execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    return dict(row) if row else None


def get_track_by_path(path: str) -> dict | None:
    row = conn().execute("SELECT * FROM tracks WHERE path=?", (path,)).fetchone()
    return dict(row) if row else None


def _where(q: str, filters: dict | None = None) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    filters = filters or {}
    if q:
        like = f"%{q}%"
        clauses.append(
            "(title LIKE ? OR artist LIKE ? OR album LIKE ? OR albumartist LIKE ?"
            " OR filename LIKE ? OR path LIKE ? OR genre LIKE ? OR year LIKE ?)"
        )
        params.extend([like] * 8)
    for col in ("language", "albumtype", "genre", "year", "artist", "album", "albumartist"):
        val = (filters.get(col) or "").strip() if isinstance(filters.get(col), str) else filters.get(col)
        if val:
            clauses.append(f"{col} = ?")
            params.append(val)
    if filters.get("dir"):
        clauses.append("dir = ?")
        params.append(filters["dir"])
    if filters.get("missing_cover"):
        clauses.append("COALESCE(has_cover,0)=0")
    if filters.get("missing_lyrics"):
        clauses.append("COALESCE(has_lyrics,0)=0")
    if filters.get("no_album"):
        clauses.append("COALESCE(album,'')=''")
    if filters.get("no_artist"):
        clauses.append("COALESCE(artist,'')=''")
    if filters.get("ids"):
        ids = [int(i) for i in filters["ids"]]
        if ids:
            marks = ",".join("?" for _ in ids)
            clauses.append(f"id IN ({marks})")
            params.extend(ids)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


SORT_WHITELIST = {
    "title": "title COLLATE NOCASE",
    "artist": "artist COLLATE NOCASE",
    "album": "album COLLATE NOCASE",
    "year": "year",
    "track": "CAST(track AS INTEGER)",
    "path": "path COLLATE NOCASE",
    "indexed": "indexed_at DESC",
    "edited": "edited_at DESC",
}


def list_tracks(
    q: str = "",
    page: int = 1,
    page_size: int = 100,
    sort: str = "artist",
    order: str = "asc",
    filters: dict | None = None,
    light: bool = True,
) -> dict:
    """分页列出曲目。light=True 时只返回列表需要的列（不返回完整标签/歌词）。"""
    where, params = _where(q, filters)
    sort_expr = SORT_WHITELIST.get(sort, SORT_WHITELIST["artist"])
    direction = "DESC" if str(order).lower() == "desc" else "ASC"
    page = max(1, int(page))
    page_size = max(1, min(1000, int(page_size)))
    offset = (page - 1) * page_size

    total = conn().execute(f"SELECT COUNT(*) AS n FROM tracks{where}", params).fetchone()["n"]
    cols = (
        "id,path,dir,filename,ext,title,artist,album,albumartist,genre,year,track,disc,"
        "language,albumtype,has_cover,has_lyrics,duration,indexed_at,edited_at,scraped_at,mtime,size"
    )
    rows = conn().execute(
        f"SELECT {cols} FROM tracks{where} ORDER BY {sort_expr} {direction}, id ASC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size,
        "items": [dict(r) for r in rows],
    }


def library_stats() -> dict:
    c = conn()
    total = c.execute("SELECT COUNT(*) AS n FROM tracks").fetchone()["n"]
    if not total:
        return {"tracks": 0, "artists": 0, "albums": 0, "missing_cover": 0, "missing_lyrics": 0, "no_artist": 0, "no_album": 0, "bytes": 0, "languages": [], "albumtypes": []}
    row = c.execute(
        "SELECT COUNT(DISTINCT NULLIF(artist,'')) AS artists,"
        " COUNT(DISTINCT NULLIF(album,'')) AS albums,"
        " SUM(CASE WHEN COALESCE(has_cover,0)=0 THEN 1 ELSE 0 END) AS missing_cover,"
        " SUM(CASE WHEN COALESCE(has_lyrics,0)=0 THEN 1 ELSE 0 END) AS missing_lyrics,"
        " SUM(CASE WHEN COALESCE(artist,'')='' THEN 1 ELSE 0 END) AS no_artist,"
        " SUM(CASE WHEN COALESCE(album,'')='' THEN 1 ELSE 0 END) AS no_album,"
        " SUM(size) AS bytes FROM tracks"
    ).fetchone()
    langs = [r["language"] for r in c.execute("SELECT DISTINCT language FROM tracks WHERE COALESCE(language,'')<>'' ORDER BY 1").fetchall()]
    types = [r["albumtype"] for r in c.execute("SELECT DISTINCT albumtype FROM tracks WHERE COALESCE(albumtype,'')<>'' ORDER BY 1").fetchall()]
    out = dict(row)
    out["tracks"] = total
    out["bytes"] = out.get("bytes") or 0
    out["languages"] = langs
    out["albumtypes"] = types
    return out


def all_paths() -> set[str]:
    return {r["path"] for r in conn().execute("SELECT path FROM tracks").fetchall()}


def tracks_for_move(ids: Sequence[int] | None = None, filters: dict | None = None) -> list[dict]:
    """取出需要整理移动的曲目（含全部字段）。"""
    if ids:
        marks = ",".join("?" for _ in ids)
        rows = conn().execute(f"SELECT * FROM tracks WHERE id IN ({marks})", [int(i) for i in ids]).fetchall()
        return [dict(r) for r in rows]
    where, params = _where("", filters or {})
    rows = conn().execute(f"SELECT * FROM tracks{where} ORDER BY artist, album, CAST(track AS INTEGER)", params).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- 设置


def get_setting(key: str, default: Any = None) -> Any:
    row = conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if not row:
        return USER_SETTING_DEFAULTS.get(key, default)
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return default


def set_setting(key: str, value: Any) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def all_settings() -> dict:
    out = dict(USER_SETTING_DEFAULTS)
    for row in conn().execute("SELECT key, value FROM settings").fetchall():
        try:
            out[row["key"]] = json.loads(row["value"])
        except (ValueError, TypeError):
            out[row["key"]] = row["value"]
    return out


# --------------------------------------------------------------------------- 别名库


def aliases(table: str) -> dict[str, str]:
    if table not in {"alias_artist", "alias_album"}:
        raise ValueError("bad table")
    return {r["from_name"]: r["to_name"] for r in conn().execute(f"SELECT * FROM {table}").fetchall()}


def replace_aliases(table: str, mapping: dict[str, str]) -> int:
    if table not in {"alias_artist", "alias_album"}:
        raise ValueError("bad table")
    c = conn()
    with _write_lock:
        c.execute(f"DELETE FROM {table}")
        c.executemany(
            f"INSERT INTO {table}(from_name, to_name) VALUES (?, ?)",
            [(str(k), str(v)) for k, v in mapping.items() if str(k).strip() and str(v).strip()],
        )
        c.commit()
    return len(mapping)


# --------------------------------------------------------------------------- 任务


def job_create(job_id: str, kind: str) -> None:
    now = time.time()
    execute(
        "INSERT INTO jobs(id,kind,state,total,done,message,error,result,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (job_id, kind, "running", 0, 0, "", "", "", now, now),
    )


def job_update(job_id: str, **kw) -> None:
    allowed = {k: v for k, v in kw.items() if k in {"state", "total", "done", "message", "error", "result"}}
    if not allowed:
        return
    sets = ", ".join(f"{k}=?" for k in allowed)
    execute(f"UPDATE jobs SET {sets}, updated_at=? WHERE id=?", [*allowed.values(), time.time(), job_id])


def job_get(job_id: str) -> dict | None:
    row = conn().execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return dict(row) if row else None


def job_list(limit: int = 20) -> list[dict]:
    rows = conn().execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- 整理计划


def plan_save(token: str, payload: dict) -> None:
    execute(
        "INSERT OR REPLACE INTO move_plans(token, created_at, payload, executed) VALUES (?,?,?,0)",
        (token, time.time(), json.dumps(payload, ensure_ascii=False)),
    )


def plan_get(token: str) -> dict | None:
    row = conn().execute("SELECT * FROM move_plans WHERE token=?", (token,)).fetchone()
    if not row:
        return None
    data = json.loads(row["payload"])
    data["_executed"] = bool(row["executed"])
    data["_token"] = token
    return data


def plan_mark_executed(token: str) -> None:
    execute("UPDATE move_plans SET executed=1 WHERE token=?", (token,))
