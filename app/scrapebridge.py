"""刮削层：多数据源搜索 + 候选打分 + 结果归一化。

两层设计
--------
1. **迁移层**（`metatidy_core.scrapers`）：从旧项目搬过来的 12+1 个数据源，功能完整。
   本文件按源逐个调用，自己控制并发与超时，避免某个源卡死把整次搜索拖住。
2. **内置源**（本文件）：musicbrainz / itunes / deezer / netease / qq 的轻量实现。
   迁移层不可用时（例如剪裁部署）自动顶上，保证功能 2 永远可用。

打分：优先用迁移层的 `score_candidate`（与旧项目一致，≥120 高 / ≥70 中 / 其余待确认），
不可用时用本文件的本地打分。
"""

from __future__ import annotations

import concurrent.futures
import difflib
import logging
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import requests

log = logging.getLogger("metatidy.scrape")

USER_AGENT = "metatidy/0.1 (https://github.com/jasonb589/metatidy)"
HTTP_TIMEOUT = 12
DEFAULT_LIMIT = 3
PER_SOURCE_TIMEOUT = 20.0

try:  # 简繁互转（可选依赖）
    from zhconv import convert as _zh_convert
except Exception:  # pragma: no cover
    _zh_convert = None


def simple_convert(text: str) -> str:
    """繁简归一，便于「週杰倫 / 周杰伦」这类比对。"""
    if not text:
        return ""
    if _zh_convert is None:
        return text
    try:
        return _zh_convert(text, "zh-cn")
    except Exception:
        return text


# --------------------------------------------------------------------------- 候选


@dataclass
class Candidate:
    """一条刮削候选。字段名与「可写入的标签字段」对齐，方便直接套用。"""

    source: str = ""
    title: str = ""
    artist: str = ""
    album: str = ""
    albumartist: str = ""
    genre: str = ""
    year: str = ""
    date: str = ""
    track: str = ""
    disc: str = ""
    language: str = ""
    composer: str = ""
    lyricist: str = ""
    albumtype: str = ""
    mb_artist_id: str = ""
    release_group_id: str = ""
    isrc: str = ""
    recording_id: str = ""
    context: str = ""
    cover: str = ""
    artist_country: str = ""
    total_tracks: int = 0
    lyrics: str = ""
    duration: float = 0.0
    score: float = 0.0
    confidence: str = "待确认"
    error: str = ""
    raw: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        data = asdict(self)
        data.pop("raw", None)
        return data


# 源注册表：core_names 为迁移层里的数据源名（缺失则跳过该源）
SOURCE_REGISTRY: list[dict[str, Any]] = [
    {"name": "musicbrainz", "label": "MusicBrainz", "needs_key": None, "core_names": ["MusicBrainz"], "builtin": True},
    {"name": "netease", "label": "网易云音乐", "needs_key": None, "core_names": ["Netease"], "builtin": True},
    {"name": "qq", "label": "QQ音乐", "needs_key": None, "core_names": ["QQMusic"], "builtin": True},
    {"name": "kugou", "label": "酷狗音乐", "needs_key": None, "core_names": ["Kugou"]},
    {"name": "kuwo", "label": "酷我音乐", "needs_key": None, "core_names": ["Kuwo"]},
    {"name": "itunes", "label": "iTunes", "needs_key": None, "core_names": ["iTunes_US", "iTunes_CN", "iTunes_TW", "iTunes_HK"], "builtin": True},
    {"name": "deezer", "label": "Deezer", "needs_key": None, "core_names": ["Deezer"], "builtin": True},
    {"name": "lastfm", "label": "Last.fm", "needs_key": "LASTFM_API_KEY", "core_names": ["Last.fm"]},
    {"name": "theaudiodb", "label": "TheAudioDB", "needs_key": None, "core_names": ["TheAudioDB"]},
    {"name": "spotify", "label": "Spotify", "needs_key": "SPOTIFY_CLIENT_ID+SPOTIFY_CLIENT_SECRET", "core_names": ["Spotify"]},
    {"name": "genius", "label": "Genius", "needs_key": "GENIUS_TOKEN", "core_names": ["Genius"]},
    {"name": "ytmusic", "label": "YouTube Music", "needs_key": None, "core_names": ["YouTubeMusic"]},
    {"name": "discogs", "label": "Discogs", "needs_key": "DISCOGS_TOKEN", "core_names": ["Discogs"]},
]

# 旧项目的默认优先级（国内源在前）
SEARCH_PRIORITY = ["netease", "qq", "kugou", "kuwo", "musicbrainz", "itunes", "deezer"]

# 内置实现覆盖的源
BUILTIN_FUNCS: dict[str, Any] = {}

# 迁移层源名 -> 本层源 id
CORE_NAME_TO_ID = {core_name: spec["name"] for spec in SOURCE_REGISTRY for core_name in spec.get("core_names", [])}

_rate_lock = threading.Lock()
_last_mb_call = 0.0


def _mb_throttle() -> None:
    """MusicBrainz 要求 ≤1 req/s。"""
    global _last_mb_call
    with _rate_lock:
        delta = time.time() - _last_mb_call
        if delta < 1.05:
            time.sleep(1.05 - delta)
        _last_mb_call = time.time()


def _get_json(url: str, params: dict | None = None, headers: dict | None = None) -> Any:
    resp = requests.get(
        url,
        params=params,
        headers={"User-Agent": USER_AGENT, **(headers or {})},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


# --------------------------------------------------------------------------- 内置源实现


def search_musicbrainz(keyword: str, artist_hint: str = "", limit: int = DEFAULT_LIMIT) -> list[Candidate]:
    _mb_throttle()
    query = f'recording:"{keyword}"'
    if artist_hint:
        query += f' AND artist:"{artist_hint}"'
    data = _get_json("https://musicbrainz.org/ws/2/recording", {"query": query, "fmt": "json", "limit": max(1, limit)})
    out: list[Candidate] = []
    for rec in (data.get("recordings") or [])[:limit]:
        credits = rec.get("artist-credit") or []
        artist = " & ".join(c.get("name", "") for c in credits if c.get("name"))
        mbid = ""
        for c in credits:
            if c.get("artist", {}).get("id"):
                mbid = c["artist"]["id"]
                break
        releases = rec.get("releases") or []
        release = releases[0] if releases else {}
        rg = release.get("release-group") or {}
        first_date = release.get("date") or rec.get("first-release-date") or ""
        out.append(
            Candidate(
                source="musicbrainz",
                title=rec.get("title", ""),
                artist=artist,
                album=release.get("title", ""),
                year=(first_date or "")[:4],
                date=first_date,
                albumtype=(rg.get("primary-type") or "").lower(),
                context="studio" if rg.get("primary-type") == "Album" else "",
                cover=(f"https://coverartarchive.org/release-group/{rg['id']}/front-500" if rg.get("id") else ""),
                mb_artist_id=mbid,
                release_group_id=rg.get("id", ""),
                recording_id=rec.get("id", ""),
                total_tracks=int(release.get("track-count") or 0),
                duration=float((rec.get("length") or 0) / 1000.0),
            )
        )
    return out


def search_itunes(keyword: str, artist_hint: str = "", limit: int = DEFAULT_LIMIT) -> list[Candidate]:
    data = _get_json("https://itunes.apple.com/search", {"term": f"{keyword} {artist_hint}".strip(), "entity": "song", "limit": max(1, limit)})
    out: list[Candidate] = []
    for item in (data.get("results") or [])[:limit]:
        artwork = item.get("artworkUrl100") or ""
        out.append(
            Candidate(
                source="itunes",
                title=item.get("trackName", ""),
                artist=item.get("artistName", ""),
                album=item.get("collectionName", ""),
                albumartist=item.get("artistName", ""),
                date=(item.get("releaseDate") or "")[:10],
                year=(item.get("releaseDate") or "")[:4],
                genre=item.get("primaryGenreName", ""),
                cover=artwork.replace("100x100", "600x600") if artwork else "",
                total_tracks=int(item.get("trackCount") or 0),
                track=str(item.get("trackNumber") or ""),
                disc=str(item.get("discNumber") or ""),
                duration=float((item.get("trackTimeMillis") or 0) / 1000.0),
                albumtype="single" if "single" in (item.get("collectionName") or "").lower() else "album",
            )
        )
    return out


def search_deezer(keyword: str, artist_hint: str = "", limit: int = DEFAULT_LIMIT) -> list[Candidate]:
    data = _get_json("https://api.deezer.com/search", {"q": f"{keyword} {artist_hint}".strip(), "limit": max(1, limit)})
    out: list[Candidate] = []
    for item in (data.get("data") or [])[:limit]:
        album = item.get("album") or {}
        out.append(
            Candidate(
                source="deezer",
                title=item.get("title", ""),
                artist=(item.get("artist") or {}).get("name", ""),
                album=album.get("title", ""),
                cover=album.get("cover_xl") or album.get("cover_big") or "",
                total_tracks=int(album.get("nb_tracks") or 0),
                duration=float(item.get("duration") or 0),
                albumtype="album",
            )
        )
    return out


def search_netease(keyword: str, artist_hint: str = "", limit: int = DEFAULT_LIMIT) -> list[Candidate]:
    """网易云公开搜索接口（有风控，失败即返回空，不拖累其它源）。"""
    data = _get_json(
        "https://music.163.com/api/search/get/web",
        {"s": f"{keyword} {artist_hint}".strip(), "type": 1, "offset": 0, "limit": max(1, limit), "total": "true"},
        headers={"Referer": "https://music.163.com/"},
    )
    out: list[Candidate] = []
    for song in ((data.get("result") or {}).get("songs") or [])[:limit]:
        artists = song.get("artists") or song.get("ar") or []
        album = song.get("album") or song.get("al") or {}
        out.append(
            Candidate(
                source="netease",
                title=song.get("name", ""),
                artist=" & ".join(a.get("name", "") for a in artists),
                album=album.get("name", ""),
                cover=album.get("picUrl", ""),
                duration=float((song.get("duration") or song.get("dt") or 0) / 1000.0),
                total_tracks=int(album.get("size") or 0),
                albumtype="album",
            )
        )
    return out


def search_qq(keyword: str, artist_hint: str = "", limit: int = DEFAULT_LIMIT) -> list[Candidate]:
    data = _get_json(
        "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
        {"w": f"{keyword} {artist_hint}".strip(), "format": "json", "n": max(1, limit), "p": 1, "cr": 1, "t": 0, "new_json": 1},
        headers={"Referer": "https://y.qq.com/"},
    )
    songs = (((data.get("data") or {}).get("song") or {}).get("list") or [])[:limit]
    out: list[Candidate] = []
    for song in songs:
        album = song.get("album") or {}
        mid = album.get("mid") or ""
        out.append(
            Candidate(
                source="qq",
                title=song.get("title") or song.get("name", ""),
                artist=" & ".join(s.get("name", "") for s in (song.get("singer") or [])),
                album=album.get("title") or album.get("name", ""),
                cover=f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{mid}.jpg" if mid else "",
                duration=float(song.get("interval") or 0),
                albumtype="album",
            )
        )
    return out


BUILTIN_FUNCS = {
    "musicbrainz": search_musicbrainz,
    "itunes": search_itunes,
    "deezer": search_deezer,
    "netease": search_netease,
    "qq": search_qq,
}


# --------------------------------------------------------------------------- 迁移层接入


def _core_module():
    """惰性导入迁移层；不可用时返回 None。"""
    try:
        from metatidy_core import scrapers as core  # type: ignore

        return core
    except Exception as exc:  # noqa: BLE001
        log.info("metatidy_core.scrapers 不可用：%s", exc)
        return None


# 迁移层源名 -> 实际搜索函数名（不能拼字符串：Last.fm / TheAudioDB / YouTubeMusic / QQMusic 都不规则）
CORE_FUNC_NAMES = {
    "MusicBrainz": "search_musicbrainz_api",
    "Netease": "search_netease_api",
    "QQMusic": "search_qq_api",
    "Kugou": "search_kugou_metadata_api",
    "Kuwo": "search_kuwo_api",
    "Deezer": "search_deezer_api",
    "Last.fm": "search_lastfm_api",
    "TheAudioDB": "search_theaudiodb_api",
    "Spotify": "search_spotify_api",
    "Genius": "search_genius_api",
    "YouTubeMusic": "search_ytmusic_api",
    "Discogs": "search_discogs_api",
}
for _region in ("US", "CN", "TW", "HK"):
    CORE_FUNC_NAMES[f"iTunes_{_region}"] = "search_itunes_api"
del _region


def _core_source_func(core_name: str):
    """把迁移层的源名（'iTunes_TW'、'Last.fm'）解析成可直接调用的函数。"""
    core = _core_module()
    if core is None:
        return None
    fname = CORE_FUNC_NAMES.get(core_name)
    if not fname:
        return None
    func = getattr(core, fname, None)
    return (core_name, func) if callable(func) else None


def core_status() -> dict:
    """迁移层可用性 + 可用源清单（前端/状态接口用）。"""
    core = _core_module()
    available: list[str] = []
    if core is not None:
        for spec in SOURCE_REGISTRY:
            for core_name in spec.get("core_names", []):
                if _core_source_func(core_name):
                    available.append(spec["name"])
                    break
    return {"available": core is not None, "sources": available, "count": len(available)}


def list_sources() -> list[dict]:
    """列出全部数据源及可用状态（前端渲染勾选框）。"""
    core = _core_module()
    out = []
    for spec in SOURCE_REGISTRY:
        migrated = core is not None and any(_core_source_func(n) for n in spec.get("core_names", []))
        if migrated:
            status = "已迁移"
        elif spec.get("builtin"):
            status = "内置"
        else:
            status = "不可用"
        out.append(
            {
                "name": spec["name"],
                "label": spec["label"],
                "needs_key": spec.get("needs_key"),
                "status": status,
                "default_on": spec["name"] in SEARCH_PRIORITY,
            }
        )
    return out


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " & ".join(str(v) for v in value if str(v).strip())
    return str(value).strip()


def _from_core(candidate: Any, source_id: str) -> Candidate:
    """迁移层 Candidate -> 本层 Candidate（字段名对齐可写标签字段）。"""
    get = (lambda k, d=None: candidate.get(k, d)) if isinstance(candidate, dict) else (lambda k, d=None: getattr(candidate, k, d))
    year = _as_text(get("year")) or _as_text(get("date"))[:4]
    return Candidate(
        source=source_id,
        title=_as_text(get("title")),
        artist=_as_text(get("artist")),
        album=_as_text(get("album")),
        albumartist=_as_text(get("album_artist")),
        genre=_as_text(get("genre")),
        year=year,
        date=_as_text(get("date")),
        track=_as_text(get("track_num")),
        disc=_as_text(get("disc_num")),
        language=_as_text(get("language")),
        composer=_as_text(get("composer")),
        lyricist=_as_text(get("lyricist")),
        albumtype=_as_text(get("album_type")),
        mb_artist_id=_as_text(get("artist_mbid")),
        release_group_id=_as_text(get("release_group_id")),
        isrc=_as_text(get("isrc")),
        recording_id=_as_text(get("recording_id")),
        context=_as_text(get("context")),
        cover=_as_text(get("cover")) or _as_text(get("cover_url")),
        artist_country=_as_text(get("artist_country")),
        total_tracks=int(get("total_tracks") or 0),
        lyrics=_as_text(get("lyrics")),
        duration=float(get("duration") or 0),
        score=float(get("score") or 0),
        confidence=_as_text(get("confidence")) or "待确认",
        raw=dict(candidate) if isinstance(candidate, dict) else {},
    )


def _core_results(raw: Any) -> list[Any]:
    """迁移层的单源函数返回「单个 dict（命中）」或「None（未命中）」，iTunes 多地区可能返回 list。

    注意：它的 Candidate 本身就是 dict 子类，所以必须先判 dict 再判序列，
    否则会把字典按 key 迭代，得到一堆字符串。
    """
    if raw is None:
        return []
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, (list, tuple)):
        return [item for item in raw if item is not None]
    return []


def _call_core_source(source_id: str, keyword: str, artist_hint: str, limit: int) -> list[Candidate]:
    """调用迁移层的单个源。每个源只给出「最佳一条」，iTunes 会跑多地区入口并合并去重。"""
    spec = next((s for s in SOURCE_REGISTRY if s["name"] == source_id), None)
    if not spec:
        return []
    found: list[Candidate] = []
    seen: set[tuple[str, str]] = set()
    for core_name in spec.get("core_names", []):
        resolved = _core_source_func(core_name)
        if not resolved:
            continue
        name, func = resolved
        region = name.split("_", 1)[1] if "_" in name else None
        try:
            raw = func(keyword, region, artist_hint) if region else func(keyword, artist_hint)
        except TypeError:
            raw = func(keyword)
        for item in _core_results(raw):
            cand = _from_core(item, source_id)
            key = (cand.title.casefold(), _as_text(cand.artist).casefold())
            if key in seen:
                continue
            seen.add(key)
            found.append(cand)
        if len(found) >= limit:
            break
    return found[:max(1, limit)]


# --------------------------------------------------------------------------- 打分


def _similarity(a: str, b: str) -> float:
    a, b = simple_convert((a or "").strip().lower()), simple_convert((b or "").strip().lower())
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.85
    return difflib.SequenceMatcher(None, a, b).ratio()


def _local_score(candidate: Candidate, track: dict) -> float:
    score = _similarity(candidate.title, track.get("title") or "") * 70
    want_artist = _as_text(track.get("artist")).split(" & ")[0]
    got_artist = _as_text(candidate.artist).split(" & ")[0]
    score += _similarity(want_artist, got_artist) * 40
    want_dur = float(track.get("duration") or 0)
    if want_dur and candidate.duration:
        delta = abs(want_dur - candidate.duration)
        score += 20 if delta <= 3 else (10 if delta <= 8 else (-15 if delta > 30 else 0))
    if candidate.album and track.get("album"):
        score += _similarity(candidate.album, track.get("album")) * 10
    ctx = (candidate.context or candidate.albumtype or "").lower()
    if ctx in {"studio", "album", "lp"}:
        score += 12
    elif ctx in {"single", "compilation", "live", "soundtrack"}:
        score += 2
    for penalty in ("remix", "cover", "live", "instrumental", "伴奏", "翻唱"):
        if penalty in (candidate.title or "").lower() and penalty not in (track.get("title") or "").lower():
            score -= 20
    return max(0.0, round(score, 1))


def _score_with_core(candidates: list[Candidate], keyword: str, artist_hint: str, track: dict | None) -> bool:
    """优先用迁移层的打分（与旧项目口径一致）。成功返回 True，失败退回本地打分。"""
    core = _core_module()
    scorer = getattr(core, "score_candidate", None) if core else None
    payload_cls = getattr(core, "Candidate", None) if core else None
    confidence = getattr(core, "confidence_level", None) if core else None
    if not callable(scorer) or payload_cls is None:
        return False
    fields = getattr(payload_cls, "__dataclass_fields__", {})
    title_hint = (track or {}).get("title")
    duration_hint = (track or {}).get("duration")
    for cand in candidates:
        try:
            rebuilt = payload_cls(**{k: v for k, v in (cand.raw or {}).items() if k in fields})
            cand.score = float(scorer(rebuilt, keyword, artist_hint, title_hint, duration_hint) or 0)
            cand.confidence = confidence(cand.score) if callable(confidence) else _confidence_label(cand.score)
        except Exception as exc:  # noqa: BLE001
            log.info("迁移层打分失败，退回本地打分：%s", exc)
            return False
    return True

def _confidence_label(score: float) -> str:
    if score >= 120:
        return "高"
    if score >= 70:
        return "中"
    return "待确认"


def score_candidate(candidate: Candidate, track: dict) -> tuple[float, str]:
    """对外的单条打分（本地实现）。"""
    score = _local_score(candidate, track)
    return score, _confidence_label(score)


# --------------------------------------------------------------------------- 对外搜索


def search(
    keyword: str,
    *,
    artist_hint: str = "",
    track: dict | None = None,
    sources: list[str] | None = None,
    limit: int = DEFAULT_LIMIT,
    timeout: float = PER_SOURCE_TIMEOUT,
) -> dict:
    """并发扇出到多个数据源。返回 {candidates, source_status}。

    - 每个源独立线程 + 独立超时：慢源最多拖 20 秒，不影响其它源出结果
    - 单个源报错只记录状态，不抛给调用方
    """
    valid = {s["name"] for s in SOURCE_REGISTRY}
    enabled = [s for s in (sources or SEARCH_PRIORITY) if s in valid]
    if not enabled:
        enabled = SEARCH_PRIORITY
    if track and track.get("mb_artist_id") and "musicbrainz" in enabled:
        enabled = ["musicbrainz"] + [s for s in enabled if s != "musicbrainz"]

    core = _core_module()
    candidates: list[Candidate] = []
    status: list[dict] = []

    def run(name: str) -> tuple[str, list[Candidate], str]:
        try:
            if core is not None:
                found = _call_core_source(name, keyword, artist_hint, limit)
                if found:
                    return name, found, ""
                if not any(_core_source_func(n) for n in next((s for s in SOURCE_REGISTRY if s["name"] == name), {}).get("core_names", [])):
                    # 迁移层没有这个源，试试内置实现
                    if name in BUILTIN_FUNCS:
                        return name, BUILTIN_FUNCS[name](keyword, artist_hint, limit), ""
                    return name, [], "迁移层未提供该源，且无内置实现"
                return name, [], ""
            if name in BUILTIN_FUNCS:
                return name, BUILTIN_FUNCS[name](keyword, artist_hint, limit), ""
            return name, [], "迁移层不可用，且该源没有内置实现"
        except Exception as exc:  # noqa: BLE001
            return name, [], f"{type(exc).__name__}: {exc}"

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(1, len(enabled)))) as pool:
        futures = {pool.submit(run, name): name for name in enabled}
        for future in concurrent.futures.as_completed(futures, timeout=timeout * 2 + 10):
            name = futures[future]
            try:
                _, found, error = future.result(timeout=timeout)
            except Exception as exc:  # noqa: BLE001
                status.append({"source": name, "count": 0, "error": f"超时：{type(exc).__name__}"})
                continue
            status.append({"source": name, "count": len(found), **({"error": error} if error else {})})
            candidates.extend(found)

    if track:
        scored = _score_with_core(candidates, keyword, artist_hint, track) if core is not None else False
        for cand in candidates:
            if not scored:
                cand.score, cand.confidence = score_candidate(cand, track)
            elif not cand.confidence:
                cand.confidence = _confidence_label(cand.score)

    # 正规录音室专辑优先：迁移层的 filter_album_context 专治「单曲相似度天然更高」这个坑
    if len(candidates) > 1 and core is not None:
        filter_ctx = getattr(core, "filter_album_context", None)
        if callable(filter_ctx):
            try:
                originals = {id(c.raw): c for c in candidates if c.raw}
                filtered = filter_ctx([c.raw for c in candidates if c.raw], True)
                kept = [originals[id(item)] for item in (filtered or []) if id(item) in originals]
                if kept and len(kept) < len(candidates):
                    candidates = kept
            except Exception as exc:  # noqa: BLE001
                log.info("filter_album_context 跳过：%s", exc)

    order = {name: idx for idx, name in enumerate(enabled)}
    candidates.sort(key=lambda c: (-c.score, order.get(c.source, 99)))

    return {
        "keyword": keyword,
        "artist_hint": artist_hint,
        "sources": enabled,
        "candidates": [c.as_dict() for c in candidates],
        "source_status": status,
        "core": core_status(),
    }


# --------------------------------------------------------------------------- 封面 / 歌词


def fetch_cover(url: str, max_bytes: int = 6 * 1024 * 1024) -> tuple[bytes, str] | None:
    """下载封面（限制大小，避免把巨型图塞进标签）。"""
    if not url:
        return None
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT, stream=True)
        resp.raise_for_status()
        mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        chunks: list[bytes] = []
        size = 0
        for chunk in resp.iter_content(65536):
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                log.warning("封面过大，已放弃：%s", url)
                return None
        return b"".join(chunks), mime
    except Exception as exc:  # noqa: BLE001
        log.warning("下载封面失败 %s: %s", url, exc)
        return None


def fetch_lyrics(title: str, artist_hint: str = "", album: str = "", duration: float = 0.0) -> str:
    """取歌词：优先迁移层的 fetch_lyrics（返回可能是 (歌词, 来源) 元组）。"""
    core = _core_module()
    func = getattr(core, "fetch_lyrics", None) if core else None
    if not callable(func):
        return ""
    try:
        result = func(title, artist_hint, album, duration)
    except TypeError:
        try:
            result = func(title, artist_hint)
        except Exception as exc:  # noqa: BLE001
            log.warning("获取歌词失败 %s: %s", title, exc)
            return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("获取歌词失败 %s: %s", title, exc)
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        for key in ("lyrics", "text", "lrc", "content"):
            if isinstance(result.get(key), str):
                return result[key]
        return ""
    if isinstance(result, (list, tuple)):
        for item in result:
            if isinstance(item, str) and item.strip():
                return item
    return ""


def find_regex(text: str, pattern: str, group: int = 1, default: str = "") -> str:
    """小工具：从文本里抽字段。"""
    m = re.search(pattern, text or "")
    return m.group(group) if m else default
