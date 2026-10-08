"""metatidy 的 HTTP 接口层。

三个功能对应三组接口：
1. 元数据编辑：`/api/tracks/*`（含 preview 差异预览与批量 apply）
2. 元数据搜索/刮削：`/api/search`、`/api/scrape/*`
3. 按目录层级整理移动：`/api/move/preview`（出计划）→ `/api/move/execute`（确认后执行）

设计要点：
- 列表接口只读 SQLite 索引，**绝不读音频文件**，两万首也能秒开
- 列表接口不返回封面二进制，封面走 `/api/tracks/{id}/cover` 单独出图（缩略图落盘缓存）
- 所有耗时操作都是后台任务，前端轮询 `/api/jobs/{id}`
- 动文件（写入标签、移动）一律「先预览、后确认」
"""

from __future__ import annotations

import io
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, db, jobs, mover, scrapebridge, tagio
from .config import (
    SUPPORTED_EXTENSIONS,
    TEMPLATE_PLACEHOLDERS,
    USER_SETTING_DEFAULTS,
    load_settings,
)
from .index import scan
from .normalize import artist_normalizer, normalize_artist_credit
from .templates import TOKEN_RE, validate_template

log = logging.getLogger("metatidy")

STATIC_DIR = Path(__file__).parent / "static"
settings = load_settings()
settings.ensure_dirs()
db.init(settings.db_path)

app = FastAPI(title="metatidy", version=__version__, description="轻量音乐元数据工作台")

# 预览响应里最多回传多少条明细（完整计划会落库，执行用 token）
PREVIEW_DISPLAY_LIMIT = 500


# --------------------------------------------------------------------------- 模型


class PreviewRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    fields: dict[str, Any] = Field(default_factory=dict)
    normalize_artist: bool = True


class ApplyRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    fields: dict[str, Any] = Field(default_factory=dict)
    normalize_artist: bool = True
    overwrite: bool = True


class ScanRequest(BaseModel):
    full: bool = False
    prune: bool = True
    root: str | None = None
    workers: int | None = None


class SearchRequest(BaseModel):
    track_id: int | None = None
    keyword: str = ""
    artist_hint: str = ""
    sources: list[str] | None = None
    limit: int = 3


class ScrapeApplyRequest(BaseModel):
    track_id: int
    candidate: dict[str, Any]
    fields: list[str] = Field(default_factory=lambda: ["title", "artist", "album", "albumartist", "genre", "year", "albumtype"])
    write_cover: bool = False
    write_lyrics: bool = False
    normalize_artist: bool = True
    overwrite: bool = True


class BatchScrapeRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    fields: list[str] = Field(default_factory=lambda: ["title", "artist", "album", "albumartist", "genre", "year", "albumtype"])
    sources: list[str] | None = None
    limit: int = 3
    write_cover: bool = False
    write_lyrics: bool = False
    auto_apply_min_score: float = 0.0  # 0 = 只出候选不自动写
    normalize_artist: bool = True


class MovePreviewRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    filters: dict[str, Any] = Field(default_factory=dict)
    dir_template: str | None = None
    filename_template: str | None = None
    conflict_policy: str | None = None
    limit: int | None = None


class MoveExecuteRequest(BaseModel):
    token: str
    dry_run: bool = False


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


def _apply_aliases(fields: dict, table_artist: dict[str, str], table_album: dict[str, str]) -> dict:
    """写入前套用别名库（只换主艺人/专辑名，保持旧项目语义）。"""
    out = dict(fields)
    if out.get("artist") and table_artist:
        main = str(out["artist"]).split(" & ")[0]
        if main in table_artist:
            rest = str(out["artist"]).split(" & ")[1:]
            out["artist"] = " & ".join([table_artist[main], *rest])
    if out.get("albumartist") and table_artist:
        main = str(out["albumartist"]).split(" & ")[0]
        if main in table_artist:
            out["albumartist"] = table_artist[main]
    if out.get("album") and table_album:
        out["album"] = table_album.get(str(out["album"]), out["album"])
    return out


def _prepare_fields(fields: dict, normalize_artist: bool) -> dict:
    """清洗用户提交的字段：只保留可编辑列、归一化多歌手。"""
    allowed = set(db.EDITABLE_FIELDS)
    clean = {k: v for k, v in (fields or {}).items() if k in allowed and v is not None}
    if normalize_artist:
        for key in ("artist", "albumartist"):
            if key in clean and clean[key]:
                clean[key] = artist_normalizer()(str(clean[key]))
    return clean


# --------------------------------------------------------------------------- 基础信息


@app.get("/api/status")
def api_status() -> dict:
    stats = db.library_stats()
    core = scrapebridge.core_status()
    return {
        "version": __version__,
        "music_dir": str(settings.music_dir),
        "music_dir_exists": settings.music_dir.exists(),
        "library_root": _library_root(),
        "data_dir": str(settings.data_dir),
        "db_path": str(settings.db_path),
        "supported_formats": sorted(SUPPORTED_EXTENSIONS),
        "stats": stats,
        "scraper": core,
        "docker": Path("/.dockerenv").exists(),
    }


def _library_root() -> str:
    return str(db.get_setting("library_root") or settings.library_root)


@app.get("/api/settings")
def api_settings() -> dict:
    values = db.all_settings()
    values["library_root"] = _library_root()
    return {"values": values, "placeholders": TEMPLATE_PLACEHOLDERS}


@app.put("/api/settings")
def api_settings_update(payload: SettingsUpdate) -> dict:
    known = set(USER_SETTING_DEFAULTS) | {"library_root"}
    saved = {}
    for key, value in (payload.values or {}).items():
        if key not in known:
            continue
        db.set_setting(key, value)
        saved[key] = value
    warnings: list[str] = []
    keys = {p["key"] for p in TEMPLATE_PLACEHOLDERS}
    for field, label in (("dir_template", "目录模板"), ("filename_template", "文件名模板")):
        if field in saved:
            warnings += [f"{label}：{w}" for w in validate_template(str(saved[field]), keys)]
    return {"saved": saved, "warnings": warnings}


@app.get("/api/sources")
def api_sources() -> dict:
    return {"sources": scrapebridge.list_sources()}


# --------------------------------------------------------------------------- 功能 1：元数据编辑


@app.get("/api/tracks")
def api_tracks(
    q: str = "",
    page: int = 1,
    page_size: int = Query(100, ge=1, le=1000),
    sort: str = "artist",
    order: str = "asc",
    language: str = "",
    albumtype: str = "",
    genre: str = "",
    year: str = "",
    artist: str = "",
    album: str = "",
    missing_cover: bool = False,
    missing_lyrics: bool = False,
    no_artist: bool = False,
    no_album: bool = False,
) -> dict:
    filters = {
        "language": language,
        "albumtype": albumtype,
        "genre": genre,
        "year": year,
        "artist": artist,
        "album": album,
        "missing_cover": missing_cover,
        "missing_lyrics": missing_lyrics,
        "no_artist": no_artist,
        "no_album": no_album,
    }
    return db.list_tracks(q=q, page=page, page_size=page_size, sort=sort, order=order, filters=filters)


@app.get("/api/tracks/{track_id}")
def api_track_detail(track_id: int) -> dict:
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(404, "没有这条曲目")
    detail = dict(track)
    detail.pop("extra", None)
    detail["file_exists"] = Path(track["path"]).exists()
    return detail


@app.get("/api/tracks/{track_id}/cover")
def api_track_cover(track_id: int, size: int = Query(0, description="0=原图，其它值为缩略图边长")):
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(404, "没有这条曲目")
    path = Path(track["path"])
    cache = (settings.thumb_cache_dir if size else settings.cover_cache_dir) / f"{track_id}.jpg"
    if cache.exists() and cache.stat().st_mtime >= (track.get("mtime") or 0):
        return FileResponse(cache, media_type="image/jpeg")

    cover = tagio.read_cover(path)
    if not cover:
        raise HTTPException(404, "这首歌没有内嵌封面")
    data, mime = cover
    if size:
        try:
            from PIL import Image

            image = Image.open(io.BytesIO(data))
            image.thumbnail((int(size), int(size)))
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=85)
            data, mime = buffer.getvalue(), "image/jpeg"
        except Exception as exc:  # noqa: BLE001 —— 缩略图失败就退回原图
            log.warning("缩略图生成失败 %s: %s", track["path"], exc)
    try:
        cache.write_bytes(data)
    except OSError:
        pass
    return Response(content=data, media_type=mime)


@app.post("/api/tracks/preview")
def api_preview(payload: PreviewRequest) -> dict:
    """差异预览：只读文件、只算不写，返回每首每字段的 old/new。"""
    if not payload.ids:
        raise HTTPException(400, "至少选择一首")
    fields = _prepare_fields(payload.fields, payload.normalize_artist)
    if not fields:
        raise HTTPException(400, "没有可编辑的字段")
    artist_alias = db.aliases("alias_artist")
    album_alias = db.aliases("alias_album")
    fields = _apply_aliases(fields, artist_alias, album_alias)

    results = []
    changed_total = 0
    for track_id in payload.ids[:PREVIEW_DISPLAY_LIMIT]:
        track = db.get_track(track_id)
        if not track:
            continue
        item = tagio.preview_update(track["path"], fields)
        item["track_id"] = track_id
        item["filename"] = track["filename"]
        item["file_exists"] = Path(track["path"]).exists()
        changed_total += item["count"]
        results.append(item)
    return {"fields": fields, "items": results, "changed_fields": changed_total, "truncated": len(payload.ids) > PREVIEW_DISPLAY_LIMIT}


@app.post("/api/tracks/apply")
def api_apply(payload: ApplyRequest) -> dict:
    """真正把字段写进标签，并同步索引。"""
    if not payload.ids:
        raise HTTPException(400, "至少选择一首")
    fields = _prepare_fields(payload.fields, payload.normalize_artist)
    if not fields:
        raise HTTPException(400, "没有可编辑的字段")
    fields = _apply_aliases(fields, db.aliases("alias_artist"), db.aliases("alias_album"))

    ok, failed = 0, []
    for track_id in payload.ids:
        track = db.get_track(track_id)
        if not track:
            failed.append({"track_id": track_id, "error": "索引里没有这条曲目"})
            continue
        try:
            result = tagio.apply_update(track["path"], fields, overwrite=payload.overwrite)
            db.update_track_fields(track_id, {**fields, "mtime": _safe_mtime(track["path"]), "size": _safe_size(track["path"])})
            ok += 1
            _ = result
        except Exception as exc:  # noqa: BLE001
            failed.append({"track_id": track_id, "path": track["path"], "error": f"{type(exc).__name__}: {exc}"})
    return {"written": ok, "failed": failed, "fields": sorted(fields)}


def _safe_mtime(path: str) -> float:
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return 0.0


def _safe_size(path: str) -> int:
    try:
        return Path(path).stat().st_size
    except OSError:
        return 0


# --------------------------------------------------------------------------- 功能 2：搜索 / 刮削


@app.post("/api/search")
def api_search(payload: SearchRequest) -> dict:
    track = db.get_track(payload.track_id) if payload.track_id else None
    keyword = (payload.keyword or "").strip()
    artist_hint = (payload.artist_hint or "").strip()
    if track and not keyword:
        keyword = track.get("title") or Path(track["path"]).stem
        artist_hint = artist_hint or (track.get("artist") or "")
    if not keyword:
        raise HTTPException(400, "缺少搜索关键词")
    enabled = payload.sources or db.get_setting("enabled_sources")
    result = scrapebridge.search(
        keyword,
        artist_hint=artist_hint,
        track=track,
        sources=enabled,
        limit=max(1, min(10, payload.limit)),
    )
    if track:
        result["track"] = {"id": track["id"], "title": track.get("title"), "artist": track.get("artist"), "duration": track.get("duration")}
    return result


@app.post("/api/scrape/apply")
def api_scrape_apply(payload: ScrapeApplyRequest) -> dict:
    """把选中的候选字段写进文件（先算差异，再落盘）。"""
    track = db.get_track(payload.track_id)
    if not track:
        raise HTTPException(404, "没有这条曲目")
    candidate = payload.candidate or {}
    values: dict[str, Any] = {}
    for key in payload.fields:
        if key in candidate and candidate[key] not in (None, ""):
            values[key] = candidate[key]
    # 专辑类型/语言这类候选字段名与标签字段对齐
    if "album_type" in candidate and "albumtype" in payload.fields:
        values["albumtype"] = candidate["album_type"]
    if not values and not payload.write_cover and not payload.write_lyrics:
        raise HTTPException(400, "没有选择要写入的内容")

    values = _prepare_fields(values, payload.normalize_artist)
    values = _apply_aliases(values, db.aliases("alias_artist"), db.aliases("alias_album"))

    cover: bytes | None = None
    cover_mime = "image/jpeg"
    if payload.write_cover and candidate.get("cover"):
        got = scrapebridge.fetch_cover(candidate["cover"])
        if got:
            cover, cover_mime = got

    lyrics = ""
    if payload.write_lyrics:
        lyrics = candidate.get("lyrics") or scrapebridge.fetch_lyrics(
            values.get("title") or track.get("title") or "",
            values.get("artist") or track.get("artist") or "",
            float(candidate.get("duration") or track.get("duration") or 0),
        )

    plan = tagio.preview_update(track["path"], values)
    try:
        tagio.apply_update(
            track["path"],
            values,
            cover=cover,
            cover_mime=cover_mime,
            lyrics=lyrics or None,
            overwrite=payload.overwrite,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"写入失败：{exc}") from exc

    index_update = dict(values)
    index_update["mtime"] = _safe_mtime(track["path"])
    index_update["size"] = _safe_size(track["path"])
    if cover:
        index_update["has_cover"] = 1
    if lyrics:
        index_update["has_lyrics"] = 1
    index_update["scraped_at"] = time.time()
    db.update_track_fields(payload.track_id, index_update)
    return {"written": sorted(values), "changes": plan["changes"], "cover": bool(cover), "lyrics": bool(lyrics)}


@app.post("/api/scrape/batch")
def api_scrape_batch(payload: BatchScrapeRequest) -> dict:
    """批量刮削：后台任务，逐首搜索，可按分数阈值自动写入。"""
    if not payload.ids:
        raise HTTPException(400, "至少选择一首")
    job_id = jobs.start(
        "scrape",
        _run_batch_scrape,
        ids=payload.ids,
        fields=payload.fields,
        sources=payload.sources or db.get_setting("enabled_sources"),
        limit=payload.limit,
        write_cover=payload.write_cover,
        write_lyrics=payload.write_lyrics,
        threshold=payload.auto_apply_min_score,
        normalize_artist=payload.normalize_artist,
    )
    return {"job_id": job_id}


def _run_batch_scrape(progress, *, ids, fields, sources, limit, write_cover, write_lyrics, threshold, normalize_artist):
    """批量刮削。

    `auto_apply_min_score <= 0` 表示**只搜索不写入**（人工复核模式），与界面提示一致；
    填正数则只有分数达到阈值的候选会被写入。
    写入路径与单首 `/api/scrape/apply` 完全一致：同样套用别名库、同样支持写封面与歌词。
    """
    progress.set_total(len(ids))
    applied = skipped = failed = 0
    details: list[dict] = []
    artist_alias = db.aliases("alias_artist")
    album_alias = db.aliases("alias_album")
    search_only = float(threshold or 0) <= 0

    for track_id in ids:
        track = db.get_track(track_id)
        if not track:
            progress.step(1)
            continue
        try:
            result = scrapebridge.search(
                track.get("title") or Path(track["path"]).stem,
                artist_hint=track.get("artist") or "",
                track=track,
                sources=sources,
                limit=limit,
            )
            candidates = result.get("candidates") or []
            best = candidates[0] if candidates else None
            if not best:
                skipped += 1
                details.append({"track_id": track_id, "status": "无候选"})
            elif search_only:
                skipped += 1
                details.append({
                    "track_id": track_id,
                    "status": "仅搜索",
                    "score": best.get("score"),
                    "candidate": {k: best.get(k) for k in ("source", "title", "artist", "album", "year", "confidence")},
                })
            elif best.get("score", 0) < float(threshold):
                skipped += 1
                details.append({"track_id": track_id, "status": "低于阈值", "score": best.get("score")})
            else:
                values = {k: best[k] for k in fields if best.get(k)}
                if "albumtype" in fields and best.get("album_type"):
                    values["albumtype"] = best["album_type"]
                values = _prepare_fields(values, normalize_artist)
                values = _apply_aliases(values, artist_alias, album_alias)

                cover = None
                cover_mime = "image/jpeg"
                if write_cover and best.get("cover"):
                    got = scrapebridge.fetch_cover(best["cover"])
                    if got:
                        cover, cover_mime = got
                lyrics = ""
                if write_lyrics:
                    lyrics = best.get("lyrics") or scrapebridge.fetch_lyrics(
                        values.get("title") or track.get("title") or "",
                        values.get("artist") or track.get("artist") or "",
                        values.get("album") or track.get("album") or "",
                        float(best.get("duration") or track.get("duration") or 0),
                    )

                tagio.apply_update(
                    track["path"],
                    values,
                    cover=cover,
                    cover_mime=cover_mime,
                    lyrics=lyrics or None,
                    overwrite=True,
                )
                index_update = {
                    **values,
                    "scraped_at": time.time(),
                    "mtime": _safe_mtime(track["path"]),
                    "size": _safe_size(track["path"]),
                }
                if cover:
                    index_update["has_cover"] = 1
                if lyrics:
                    index_update["has_lyrics"] = 1
                db.update_track_fields(track_id, index_update)
                applied += 1
                details.append({
                    "track_id": track_id,
                    "status": "已写入",
                    "score": best.get("score"),
                    "fields": sorted(values),
                    "cover": bool(cover),
                    "lyrics": bool(lyrics),
                })
        except Exception as exc:  # noqa: BLE001
            failed += 1
            details.append({"track_id": track_id, "status": "失败", "error": f"{type(exc).__name__}: {exc}"})
        progress.step(1, message=track.get("filename") or str(track_id))
    return {
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "search_only": search_only,
        "details": details[:PREVIEW_DISPLAY_LIMIT],
    }


# --------------------------------------------------------------------------- 功能 3：整理移动


@app.post("/api/move/preview")
def api_move_preview(payload: MovePreviewRequest) -> dict:
    """生成整理计划（只算不动），并落库换一个 token 供确认执行。"""
    rows = db.tracks_for_move(payload.ids or None, None if payload.ids else payload.filters)
    if not rows:
        raise HTTPException(400, "没有匹配到曲目")
    values = db.all_settings()
    dir_template = payload.dir_template or values.get("dir_template") or "{language}/{artist}/{album}"
    filename_template = payload.filename_template or values.get("filename_template") or "{title}"
    conflict_policy = payload.conflict_policy or values.get("conflict_policy") or "rename"

    plan = mover.plan_moves(
        rows,
        library_root=_library_root(),
        dir_template=dir_template,
        filename_template=filename_template,
        conflict_policy=conflict_policy,
        unknown_artist=str(values.get("unknown_artist") or "未知艺术家"),
        unknown_album=str(values.get("unknown_album") or "未知专辑"),
        unknown_other=str(values.get("unknown_other") or "未知"),
        artist_normalizer=artist_normalizer(),
        limit=payload.limit,
    )
    token = uuid.uuid4().hex
    stored = {k: v for k, v in plan.items() if k != "items"}
    stored["items"] = plan["items"]
    db.plan_save(token, stored)
    display = dict(plan)
    display["items"] = plan["items"][:PREVIEW_DISPLAY_LIMIT]
    display["token"] = token
    display["display_truncated"] = len(plan["items"]) > PREVIEW_DISPLAY_LIMIT
    display["template_warnings"] = validate_template(dir_template, {p["key"] for p in TEMPLATE_PLACEHOLDERS})
    return display


@app.get("/api/move/plan/{token}")
def api_move_plan(token: str) -> dict:
    plan = db.plan_get(token)
    if not plan:
        raise HTTPException(404, "计划不存在或已过期")
    return plan


@app.post("/api/move/execute")
def api_move_execute(payload: MoveExecuteRequest) -> dict:
    plan = db.plan_get(payload.token)
    if not plan:
        raise HTTPException(404, "计划不存在，请重新预览")
    if plan.get("_executed") and not payload.dry_run:
        raise HTTPException(409, "这个计划已经执行过了，请重新预览")
    if payload.dry_run:
        return mover.execute_plan(plan, dry_run=True)
    job_id = jobs.start("move", _run_move, plan=plan, token=payload.token)
    return {"job_id": job_id}


def _run_move(progress, *, plan, token):
    movable = [it for it in plan.get("items", []) if it.get("action") not in {"in_place", "conflict_skip", "invalid"}]
    progress.set_total(len(movable))
    summary = mover.execute_plan(plan, dry_run=False, on_progress=lambda i, t, name: progress.step(1, message=name))
    db.plan_mark_executed(token)
    return summary


# --------------------------------------------------------------------------- 任务


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict:
    job = db.job_get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    job["percent"] = round((job["done"] / job["total"] * 100), 1) if job.get("total") else 0.0
    return job


@app.get("/api/jobs")
def api_jobs() -> dict:
    return {"jobs": db.job_list()}


@app.post("/api/scan")
def api_scan(payload: ScanRequest | None = Body(default=None)) -> dict:
    payload = payload or ScanRequest()
    job_id = jobs.start(
        "scan",
        scan,
        root=payload.root,
        full=payload.full,
        prune=payload.prune,
        workers=payload.workers or settings.scan_workers,
    )
    return {"job_id": job_id}


# --------------------------------------------------------------------------- 别名库


@app.get("/api/aliases/{kind}")
def api_aliases(kind: str) -> dict:
    table = {"artist": "alias_artist", "album": "alias_album"}.get(kind)
    if not table:
        raise HTTPException(400, "kind 只能是 artist 或 album")
    return {"items": [{"from": k, "to": v} for k, v in db.aliases(table).items()]}


@app.put("/api/aliases/{kind}")
def api_aliases_save(kind: str, payload: dict = Body(...)) -> dict:
    table = {"artist": "alias_artist", "album": "alias_album"}.get(kind)
    if not table:
        raise HTTPException(400, "kind 只能是 artist 或 album")
    items = payload.get("items") or []
    mapping = {str(i.get("from", "")).strip(): str(i.get("to", "")).strip() for i in items if isinstance(i, dict)}
    mapping = {k: v for k, v in mapping.items() if k and v}
    db.replace_aliases(table, mapping)
    return {"saved": len(mapping)}


# --------------------------------------------------------------------------- 其它


@app.get("/api/template/test")
def api_template_test(
    dir_template: str = "{language}/{artist}/{album}",
    filename_template: str = "{track:02} - {title}",
    track_id: int | None = None,
) -> dict:
    """用一首真实曲目试渲染模板，方便调层级。"""
    if track_id:
        track = db.get_track(track_id)
    else:
        rows = db.list_tracks(page_size=1)["items"]
        track = rows[0] if rows else None
    if not track:
        raise HTTPException(404, "索引里还没有曲目，先扫描一次")
    try:
        from .templates import target_path

        values = db.all_settings()
        target = target_path(
            track,
            _library_root(),
            dir_template,
            filename_template,
            unknown_artist=str(values.get("unknown_artist")),
            unknown_album=str(values.get("unknown_album")),
            unknown_other=str(values.get("unknown_other")),
            artist_normalizer=artist_normalizer(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"模板渲染失败：{exc}") from exc
    return {
        "track": {"id": track["id"], "title": track.get("title"), "artist": track.get("artist"), "album": track.get("album")},
        "source": track["path"],
        "target": str(target),
        "warnings": validate_template(dir_template, {p["key"] for p in TEMPLATE_PLACEHOLDERS}),
    }


@app.exception_handler(Exception)
async def _unhandled(_request, exc: Exception):  # pragma: no cover
    log.exception("未处理异常")
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
else:  # pragma: no cover
    @app.get("/")
    def _no_ui() -> dict:
        return {"detail": "静态界面缺失", "api": "/docs"}
