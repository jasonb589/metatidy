"""12 个音乐数据源的搜索函数 + 统一的候选搜索接口（纯逻辑，无 GUI 依赖）。

迁移自 ``media_toolkit.py`` 的「音频元数据」搜索区块，逐函数对照搬迁：

======================  ============================================  ==========
源（engine key）         搜索函数                                       需要 Key
======================  ============================================  ==========
Netease                 :func:`search_netease_api`                    否
QQMusic                 :func:`search_qq_api`                         否
Kugou                   :func:`search_kugou_metadata_api`             否
Kuwo                    :func:`search_kuwo_api`                       否
MusicBrainz             :func:`search_musicbrainz_api`                否
iTunes_US/CN/TW/HK      :func:`search_itunes_api`                     否
Deezer                  :func:`search_deezer_api`                     否
Last.fm                 :func:`search_lastfm_api`                     否（内置免费 Key）
TheAudioDB              :func:`search_theaudiodb_api`                 否（内置测试 Key）
YouTubeMusic            :func:`search_ytmusic_api`                    否（需 ytmusicapi 库）
Spotify                 :func:`search_spotify_api`                    SPOTIFY_CLIENT_ID/SECRET
Genius                  :func:`search_genius_api`                     GENIUS_ACCESS_TOKEN
Discogs（源码附带）       :func:`search_discogs_api`                    DISCOGS_TOKEN
======================  ============================================  ==========

外加：Cover Art Archive 封面获取（:func:`fetch_cover_art_archive`）、歌词获取
（:func:`fetch_lyrics`）、搜索缓存、熔断、重试、匹配打分与候选上下文识别。

统一入口：``search_all(keyword, artist_hint, title_hint, duration_hint, sources, limit)``。
缓存与熔断状态都可注入（见 :func:`set_search_cache` / :func:`set_circuit_breaker_registry`）。
"""

from __future__ import annotations

import base64
import base64
import io
import json
import logging
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

from . import config
from .normalize import (
    HAS_FUZZ,
    _fuzz,
    ai_prompt,
    ai_render,
    classify_album_context,
    filter_album_context,
    is_chinese_text,
    is_fuzzy_match,
    is_track_title_match,
    normalize_artist_credit,
)
# 兼容别名：只为让下面的函数体与源码逐行对应（单一实现仍在 normalize.py）
from .normalize import sanitize_filename as normalize_sanitize_filename
from .normalize import simple_convert as norm_simple
from .normalize import translate_raw_genre as norm_translate_raw_genre

LOGGER = logging.getLogger(__name__)

MUSIC_HEADERS = config.MUSIC_HEADERS
HEADERS = config.SEARCH_HEADERS
MB_HEADERS = {"User-Agent": config.MB_USER_AGENT}

# 源码 MUSIC_SEARCH_ENGINES（运行时再追加国际源），保持原顺序用于
# :func:`search_best_match_global` 的行为等价。
MUSIC_SEARCH_ENGINES = ['Netease', 'QQMusic', 'iTunes_US', 'Deezer', 'iTunes_CN', 'iTunes_TW', 'iTunes_HK']
EXTRA_ENGINES = ['MusicBrainz', 'Kuwo', 'Kugou', 'Last.fm', 'TheAudioDB', 'Spotify', 'Genius', 'YouTubeMusic', 'Discogs']

# ── 默认搜索顺序：网易云 → QQ音乐 → 酷狗/酷我 → MusicBrainz → iTunes/Deezer → 其余 ──
SEARCH_PRIORITY: Tuple[str, ...] = (
    'Netease',
    'QQMusic',
    'Kugou',
    'Kuwo',
    'MusicBrainz',
    'iTunes_US',
    'iTunes_CN',
    'iTunes_TW',
    'iTunes_HK',
    'Deezer',
    'Last.fm',
    'TheAudioDB',
    'Spotify',
    'Genius',
    'YouTubeMusic',
    'Discogs',
)

# 已知 MBID 时提到最前的源（跨专辑稳定的艺人/发行组身份靠它）
MBID_FIRST_SOURCES: Tuple[str, ...] = ('MusicBrainz',)

__all__ = [
    "SEARCH_PRIORITY",
    "MBID_FIRST_SOURCES",
    "MUSIC_SEARCH_ENGINES",
    "EXTRA_ENGINES",
    "Candidate",
    "CircuitBreaker",
    "CircuitBreakerRegistry",
    "get_circuit_breaker",
    "set_circuit_breaker_registry",
    "safe_api_call",
    "safe_call",
    "retry_on_failure",
    "MemorySearchCache",
    "NullSearchCache",
    "get_search_cache",
    "set_search_cache",
    "get_cached_search",
    "set_cached_search",
    "get_cached_album_result",
    "set_cached_album_result",
    "SearchCache",
    "ordered_sources",
    "search_all",
    "search_best_match_global",
    "search_netease_api",
    "search_itunes_api",
    "search_deezer_api",
    "search_qq_api",
    "search_kuwo_api",
    "search_kugou_metadata_api",
    "search_musicbrainz_api",
    "search_lastfm_api",
    "search_theaudiodb_api",
    "search_spotify_api",
    "search_genius_api",
    "search_ytmusic_api",
    "search_discogs_api",
    "ordered_sources",
    "SOURCE_FUNCTIONS",
    "score_candidate",
    "confidence_level",
    "throttle_between_files",
    "RateLimiter",
    "MUSICBRAINZ_MIN_INTERVAL",
    "probe_image_size",
    "download_cover_image",
    "cover_art_archive_url",
    "fetch_cover_art_archive",
    "fetch_release_group_title",
    "merge_candidate_metadata",
    "download_cover_with_fallback",
    "save_cover_file",
    "fetch_lyrics",
    "global_fetch_lyrics",
    "get_netease_lyrics",
    "get_qq_lyrics",
    "get_lrclib_lyrics",
    "get_kugou_lyrics",
    "extract_credits_from_lyrics",
    "enhance_metadata",
    "cross_source_fill_year",
    "fill_missing_metadata",
]


# ==================== 🔁 重试 / 熔断 / 限速 ====================

def retry_on_failure(max_retries=3, base_delay=1.0, backoff=2.0, exceptions=(Exception,)):
    """指数退避重试装饰器（照抄源码）。

    重试间隔 ``base_delay * (backoff ** attempt)`` 秒；默认 3 次 / 1s 起 / 2 倍退避。
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            last_exc = None
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_exc = e
                    if attempt < max_retries - 1:
                        delay = base_delay * (backoff ** attempt)
                        time.sleep(delay)
            raise last_exc
        return wrapper
    return decorator


class CircuitBreaker:
    """简单的断路器：连续失败 N 次后熔断 M 秒，期间快速失败（照抄源码）。"""

    def __init__(self, name="default", failure_threshold=5, cooldown_seconds=120):
        self.name = name
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self._failures = 0
        self._last_failure_time = 0
        self._lock = threading.Lock()

    @property
    def is_open(self):
        """断路器是否打开（熔断中）。"""
        with self._lock:
            if self._failures >= self.failure_threshold:
                if time.time() - self._last_failure_time < self.cooldown_seconds:
                    return True
                # 冷却期过 → 半开状态，重置计数器
                self._failures = 0
            return False

    def record_success(self):
        """记一次成功：清零失败计数。"""
        with self._lock:
            self._failures = 0

    def record_failure(self):
        """记一次失败。"""
        with self._lock:
            self._failures += 1
            self._last_failure_time = time.time()


class CircuitBreakerRegistry:
    """按引擎维护断路器实例（线程安全，可整体注入替换）。"""

    def __init__(self, failure_threshold=5, cooldown_seconds=120):
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._lock = threading.Lock()

    def get(self, engine_name: str) -> CircuitBreaker:
        """取（或创建）某引擎的断路器。"""
        with self._lock:
            if engine_name not in self._breakers:
                # 每个引擎独立熔断：5 次连续失败 → 120s 冷却
                self._breakers[engine_name] = CircuitBreaker(
                    name=engine_name,
                    failure_threshold=self.failure_threshold,
                    cooldown_seconds=self.cooldown_seconds,
                )
            return self._breakers[engine_name]

    def clear(self) -> None:
        """清空全部熔断状态（测试用）。"""
        with self._lock:
            self._breakers.clear()


_registry_lock = threading.Lock()
_registry: CircuitBreakerRegistry = CircuitBreakerRegistry()


def get_circuit_breaker(engine_name: str) -> CircuitBreaker:
    """获取或创建引擎级断路器（线程安全）。"""
    return _registry.get(engine_name)


def set_circuit_breaker_registry(registry) -> None:
    """注入自定义熔断注册表（默认进程内内存实现）。"""
    global _registry
    with _registry_lock:
        _registry = registry


def safe_api_call(engine_name, func, *args, **kwargs):
    """带断路器和重试的 API 调用包装器（照抄源码逻辑）。

    熔断中直接返回 ``None``；失败重试 1 次（间隔 1s / 2s），仍失败则记 failure。
    """
    breaker = get_circuit_breaker(engine_name)
    if breaker.is_open:
        LOGGER.debug("熔断中，跳过 %s", engine_name)
        return None  # 熔断中，快速失败
    max_retries = 2  # 总共 2 次尝试（首次 + 1 次重试）
    last_error = None
    for attempt in range(max_retries):
        try:
            result = func(*args, **kwargs)
            breaker.record_success()
            return result
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                delay = 1.0 * (2 ** attempt)
                time.sleep(delay)
    breaker.record_failure()
    LOGGER.debug("%s 调用失败：%s", engine_name, last_error)
    return None


# 规格里的别名写法
safe_call = safe_api_call


class RateLimiter:
    """最小间隔限速器（线程安全）：MusicBrainz 要求 ≤ 1 req/s。"""

    def __init__(self, min_interval: float):
        self.min_interval = float(min_interval)
        self._lock = threading.Lock()
        self._last_call = 0.0

    def wait(self) -> None:
        """必要时阻塞，保证两次调用间隔不小于 ``min_interval``。"""
        with self._lock:
            now = time.time()
            delta = now - self._last_call
            if delta < self.min_interval:
                time.sleep(self.min_interval - delta)
            self._last_call = time.time()


MUSICBRAINZ_MIN_INTERVAL = 1.0
_musicbrainz_limiter = RateLimiter(MUSICBRAINZ_MIN_INTERVAL)

# 源码里 UI 层的「每文件间隔 1.5~3 秒」风控保护，供批量流程复用
FILE_THROTTLE_RANGE = (1.5, 3.0)


def throttle_between_files() -> None:
    """批量刮削时每个文件之间的风控间隔（源码 ``random.uniform(1.5, 3.0)``）。"""
    time.sleep(random.uniform(*FILE_THROTTLE_RANGE))


def _musicbrainz_get(url, **kwargs):
    """带 1 req/s 限速的 MusicBrainz GET（源码无显式限速，见 PORT_NOTES）。"""
    _musicbrainz_limiter.wait()
    kwargs.setdefault('headers', MB_HEADERS)
    return requests.get(url, **kwargs)


# ==================== 💾 搜索缓存（可注入） ====================

SEARCH_CACHE_TTL = 86400  # 24 小时
ALBUM_CACHE_TTL = 86400


class MemorySearchCache:
    """进程内内存缓存：``(keyword, artist) → (写入时间, 结果)``，带 TTL 与容量上限。

    缓存键、TTL、淘汰策略与源码一致（搜索结果上限 2000 条，超限删最老 20%；
    专辑缓存上限 500 条，超限删最老 100 条）。
    """

    def __init__(self, ttl=SEARCH_CACHE_TTL, album_ttl=ALBUM_CACHE_TTL,
                 max_entries=2000, album_max_entries=500):
        self.ttl = ttl
        self.album_ttl = album_ttl
        self.max_entries = max_entries
        self.album_max_entries = album_max_entries
        self._search: Dict[Tuple[str, str], Tuple[float, Any]] = {}
        self._album: Dict[str, Tuple[float, Any]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def search_key(keyword, artist_hint):
        return ((keyword or '').lower().strip(), (artist_hint or '').lower().strip())

    def get(self, keyword, artist_hint):
        key = self.search_key(keyword, artist_hint)
        with self._lock:
            entry = self._search.get(key)
            if entry and time.time() - entry[0] < self.ttl:
                return entry[1]
        return None

    def set(self, keyword, artist_hint, result):
        if not result:
            return
        key = self.search_key(keyword, artist_hint)
        with self._lock:
            self._search[key] = (time.time(), result)
            if len(self._search) > self.max_entries:
                sorted_entries = sorted(self._search.items(), key=lambda x: x[1][0])
                for old_key, _ in sorted_entries[:int(self.max_entries * 0.2)]:
                    del self._search[old_key]

    def get_album(self, album_name):
        if not album_name:
            return None
        key = str(album_name).lower().strip()
        with self._lock:
            entry = self._album.get(key)
            if entry and time.time() - entry[0] < self.album_ttl:
                return entry[1]
        return None

    def set_album(self, album_name, best_result):
        if not album_name or not best_result:
            return
        key = str(album_name).lower().strip()
        with self._lock:
            self._album[key] = (time.time(), dict(best_result))  # 浅拷贝防止共享修改
            if len(self._album) > self.album_max_entries:
                sorted_entries = sorted(self._album.items(), key=lambda x: x[1][0])
                for old_key, _ in sorted_entries[:100]:
                    del self._album[old_key]

    def clear(self):
        """清空缓存（测试用）。"""
        with self._lock:
            self._search.clear()
            self._album.clear()


class NullSearchCache(MemorySearchCache):
    """不缓存的实现（测试/无状态部署用）。"""

    def __init__(self):
        super().__init__()

    def get(self, keyword, artist_hint):
        return None

    def set(self, keyword, artist_hint, result):
        return None

    def get_album(self, album_name):
        return None

    def set_album(self, album_name, best_result):
        return None


# 规格别名
SearchCache = MemorySearchCache

_cache_lock = threading.Lock()
_search_cache_impl: MemorySearchCache = MemorySearchCache()


def get_search_cache() -> MemorySearchCache:
    """取当前缓存实现（默认进程内内存）。"""
    return _search_cache_impl


def set_search_cache(cache) -> None:
    """注入自定义缓存实现（需提供 get/set/get_album/set_album）。"""
    global _search_cache_impl
    with _cache_lock:
        _search_cache_impl = cache


def get_cached_search(keyword, artist_hint):
    """从搜索缓存中获取结果，过期返回 ``None``。"""
    return get_search_cache().get(keyword, artist_hint)


def set_cached_search(keyword, artist_hint, result):
    """写入搜索缓存（仅缓存有结果的成功搜索）。"""
    get_search_cache().set(keyword, artist_hint, result)


def get_cached_album_result(album_name):
    """从专辑缓存中获取已知专辑的最佳结果。"""
    return get_search_cache().get_album(album_name)


def set_cached_album_result(album_name, best_result):
    """将最佳搜索结果关联到专辑名，方便同专辑后续文件复用。"""
    get_search_cache().set_album(album_name, best_result)


# ==================== 🎼 候选对象 ====================

# Candidate 的固定字段（= 源码 dict 里出现过的键名，未做任何改名）
_FIELD_NAMES: Tuple[str, ...] = (
    'title', 'artist', 'album', 'album_artist', 'year', 'date', 'genre', 'language',
    'album_type', 'source', 'context', 'cover', 'cover_url', 'artist_country',
    'artist_mbid', 'release_group_id', 'total_tracks', 'lyrics', 'duration', 'score',
    # ── 源码里同级的其余字段（评分 / 增强 / 去重都要用）──
    'sort_score', 'pixels', 'selection_score', 'song_id', 'recording_id',
    'release_group_primary_type', 'release_group_secondary_types', 'track_num',
    'disc_num', 'total_discs', 'composer', 'lyricist', 'isrc', 'format',
    'disambiguation', 'explicit', 'popularity', 'confidence',
)


@dataclass
class Candidate(dict):
    """一个搜索候选（音乐元数据）。

    既是一个 ``@dataclass``（字段可属性访问、类型清晰），也是 ``dict`` 子类，
    因此 ``json.dumps(candidate)`` 可直接序列化，且源码里的 ``c.get('title')`` /
    ``c['context'] = ...`` 等字典写法全部照旧可用。

    源码里出现过的字段全部保留（未改名）：``title / artist / album / year / date /
    genre / language / album_type / source / context / cover / cover_url /
    artist_country / artist_mbid / release_group_id / total_tracks / lyrics /
    duration / score``，外加 ``sort_score / pixels / song_id / recording_id /
    isrc / track_num / disc_num / composer / lyricist / format ...``。
    未预声明的键（如各源的私有字段）自动收进 :attr:`extra`，并同样进入 dict 视图。
    """

    title: str = ""
    artist: str = ""
    album: str = ""
    album_artist: str = ""
    year: str = ""
    date: str = ""
    genre: Optional[str] = None
    language: str = ""
    album_type: str = ""
    source: str = ""
    context: str = ""
    cover: str = ""
    cover_url: str = ""
    artist_country: str = ""
    artist_mbid: str = ""
    release_group_id: str = ""
    total_tracks: int = 0
    lyrics: Optional[str] = None
    duration: int = 0
    score: int = 0
    sort_score: int = 0
    pixels: int = 0
    selection_score: int = 0
    song_id: Any = None
    recording_id: str = ""
    release_group_primary_type: str = ""
    release_group_secondary_types: List[str] = field(default_factory=list)
    track_num: Any = None
    disc_num: Any = None
    total_discs: Any = None
    composer: str = ""
    lyricist: str = ""
    isrc: str = ""
    format: Any = None
    disambiguation: str = ""
    explicit: Any = None
    popularity: Any = None
    confidence: str = ""
    # 未预声明的键（含 ``_field_sources`` / ``_cover_candidates`` 等内部字段）
    extra: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        extra = dict(self.extra or {})
        object.__setattr__(self, 'extra', extra)
        dict.clear(self)
        for name in _FIELD_NAMES:
            dict.__setitem__(self, name, getattr(self, name))
        for key, value in extra.items():
            dict.__setitem__(self, key, value)
        if not self.cover and self.cover_url:
            self.cover = self.cover_url

    # ── 属性/字典双向同步 ──
    def __setattr__(self, key, value):
        if key.startswith('_') or key == 'extra':
            object.__setattr__(self, key, value)
            return
        if key in _FIELD_NAMES:
            object.__setattr__(self, key, value)
            dict.__setitem__(self, key, value)
            if key == 'cover_url' and not value:
                dict.__setitem__(self, 'cover', '')
            return
        extra = self.__dict__.get('extra')
        if extra is None:
            object.__setattr__(self, 'extra', {})
            extra = self.__dict__['extra']
        extra[key] = value
        dict.__setitem__(self, key, value)

    def __setitem__(self, key, value):
        self.__setattr__(key, value)

    def __delitem__(self, key):
        self.extra.pop(key, None)
        dict.pop(self, key, None)

    def setdefault(self, key, default=None):
        if key not in self:
            self[key] = default
        return dict.__getitem__(self, key)

    def update(self, *args, **kwargs):
        """批量写入（自动分流到字段或 :attr:`extra`）。"""
        for key, value in dict(*args, **kwargs).items():
            self[key] = value

    def get(self, key, default=None):
        return dict.get(self, key, default)

    def to_dict(self) -> Dict[str, Any]:
        """转成普通 dict（``json.dumps`` 友好）。"""
        return dict(self)

    @classmethod
    def from_dict(cls, data) -> "Candidate":
        """从普通 dict 构造（未知键进 :attr:`extra`）。"""
        data = dict(data or {})
        known = {name: data.pop(name) for name in list(data) if name in _FIELD_NAMES}
        extra = {}
        extra.update(data)
        extra.update(known.pop('extra', {}) or {})
        candidate = cls(**known, extra=extra)
        if not candidate.cover and candidate.cover_url:
            candidate.cover = candidate.cover_url
        return candidate


# ==================== 🎧 12 个数据源（逐函数照抄） ====================

def search_netease_api(keyword, filename_artist_hint):
    """网易云搜索 — 收集所有歌手匹配结果，优先返回歌名最匹配的。

    先试新版 ``cloudsearch/pc``，失败或空结果时退回旧版 ``search/get/web``（降级）。
    :return: 候选 dict 或 ``None``
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
    }

    def _build_result(song, artist_name):
        """从搜索结果构建统一格式"""
        al = song.get('al', {}) or song.get('album', {})
        raw_pic = al.get('picUrl', '')
        if not raw_pic:
            return None
        cover_url = str(raw_pic).split('?')[0]
        if cover_url.startswith('http://'):
            cover_url = cover_url.replace('http://', 'https://')
        pub_time = song.get('publishTime', 0) or al.get('publishTime', 0)
        date, year = '', ''
        if pub_time:
            time_struct = time.localtime(pub_time / 1000)
            date = time.strftime('%Y-%m-%d', time_struct)
            year = time.strftime('%Y', time_struct)
        s_title = norm_simple(song.get('name', ''))
        s_album = norm_simple(al.get('name', ''))
        is_single = (s_title == s_album)
        duration_val = 0
        try:
            duration_val = int(song.get('dt', 0) or song.get('duration', 0)) // 1000
        except Exception:
            pass
        return {
            'source': 'Netease', 'cover_url': cover_url, 'song_id': song.get('id'),
            'genre': None, 'date': date, 'year': year,
            'album_type': al.get('type', '') or ('单曲' if is_single else '专辑'),
            'total_tracks': int(al.get('trackCount') or 0),
            'title': s_title, 'artist': norm_simple(artist_name),
            'album': s_album, 'album_artist': norm_simple(artist_name),
            'duration': duration_val,
        }

    def _title_score(title):
        """计算歌名与搜索词的匹配度（用于引擎内部排序）"""
        if not title:
            return 0
        t = title.lower()
        kw = keyword.lower()
        if t == kw or t in kw or kw in t:
            return 100
        # 中文逐字重叠
        if is_chinese_text(t) and is_chinese_text(kw):
            return len(set(t) & set(kw)) * 10
        # 词元命中
        kw_words = set(kw.split())
        t_words = set(t.split())
        return len(kw_words & t_words) * 15

    all_matches = []

    # 新版 cloudsearch API
    try:
        api_url = "https://music.163.com/api/cloudsearch/pc"
        params = {'s': keyword, 'type': 1, 'offset': 0, 'limit': 10}
        resp = requests.post(api_url, data=params, headers=headers, timeout=300)
        if resp.status_code == 200:
            data = resp.json()
            songs = data.get('result', {}).get('songs', [])
            for song in songs:
                ar = song.get('ar', [])
                artist_name = normalize_artist_credit([item.get('name', '') for item in ar])
                if is_fuzzy_match(filename_artist_hint, artist_name):
                    r = _build_result(song, artist_name)
                    if r:
                        all_matches.append(r)
    except Exception:
        LOGGER.debug("网易云 cloudsearch 失败，走旧版接口", exc_info=True)

    # 旧版 search API 兜底
    if not all_matches:
        try:
            api_url = "https://music.163.com/api/search/get/web"
            params = {'s': keyword, 'type': 1, 'offset': 0, 'total': 'true', 'limit': 10}
            resp = requests.post(api_url, headers=headers, data=params, timeout=300)
            if resp.status_code != 200:
                resp = requests.get(api_url, headers=headers, params=params, timeout=300)
            if resp.status_code == 200:
                data = resp.json()
                if 'result' in data and 'songs' in data['result']:
                    for song in data['result']['songs']:
                        artist_name = normalize_artist_credit([item.get('name', '') for item in song.get('artists', [])])
                        if is_fuzzy_match(filename_artist_hint, artist_name):
                            # 统一适配旧版字段
                            song['al'] = song.get('album', {})
                            r = _build_result(song, artist_name)
                            if r:
                                all_matches.append(r)
        except Exception:
            LOGGER.debug("网易云旧版接口也失败", exc_info=True)

    if not all_matches:
        return None
    # 按歌名匹配度排序，返回最佳
    all_matches.sort(key=lambda x: _title_score(x.get('title', '')), reverse=True)
    return all_matches[0]


def search_itunes_api(keyword, region, filename_artist_hint):
    """iTunes 搜索（按地区，如 ``US`` / ``CN`` / ``TW`` / ``HK``）。

    :param region: 国家/地区代码，直接进 ``country`` 参数
    """
    base_url = "https://itunes.apple.com/search"
    params = {"term": keyword, "media": "music", "entity": "song", "limit": 5, "country": region, "lang": "zh_cn"}
    try:
        # 源码没带 UA，实测 Apple 会对匿名请求返回 resultCount=0；补上公共 UA（见 PORT_NOTES）
        resp = requests.get(base_url, params=params, timeout=300, headers=MUSIC_HEADERS)
        data = resp.json()
        if data['resultCount'] > 0:
            for res in data['results']:
                if is_fuzzy_match(filename_artist_hint, res.get('artistName')):
                    raw_url = res.get("artworkUrl100", "")
                    if not raw_url:
                        continue
                    cover_url = re.sub(r'/\d+x\d+[a-z]*\.([a-z]+)', r'/10000x10000bb.\1', raw_url)
                    raw_genre = res.get('primaryGenreName', '')
                    genre = norm_translate_raw_genre(raw_genre)
                    release_date = res.get('releaseDate', '')
                    date = release_date[:10] if release_date else ""
                    year = date[:4] if date else ""
                    s_album = norm_simple(res.get('collectionName', ''))
                    s_title = norm_simple(res.get('trackName', ''))
                    is_single = ('Single' in s_album) or (s_title == s_album and res.get('trackCount') == 1)
                    return {'source': f'iTunes-{region}', 'cover_url': cover_url, 'genre': genre,
                            'date': date, 'year': year,
                            'album_type': res.get('collectionType', '') or ('单曲' if is_single else '专辑'),
                            'title': s_title, 'artist': norm_simple(res.get('artistName')),
                            'album': s_album, 'album_artist': norm_simple(res.get('collectionArtistName', res.get('artistName'))),
                            'total_tracks': int(res.get('trackCount') or 0),
                            'track_num': res.get('trackNumber')}
    except Exception:
        LOGGER.debug("iTunes(%s) 搜索失败", region, exc_info=True)
    return None


def search_deezer_api(keyword, filename_artist_hint):
    """Deezer 搜索 — 命中后补一次专辑详情以拿到准确的发行日期。"""
    base_url = "https://api.deezer.com/search"
    params = {"q": keyword, "limit": 3}
    try:
        resp = requests.get(base_url, params=params, timeout=300)
        data = resp.json()
        if 'data' in data and len(data['data']) > 0:
            for res in data['data']:
                artist_name = res.get('artist', {}).get('name', '')
                if is_fuzzy_match(filename_artist_hint, artist_name):
                    album = res.get('album', {})
                    cover_base = album.get('cover_xl', album.get('cover_medium', ''))
                    if not cover_base:
                        continue
                    cover_url = cover_base.replace("1000x1000", "1400x1400")
                    s_title = norm_simple(res.get('title'))
                    s_album = norm_simple(album.get('title'))
                    # Deezer 年份提取 — album.release_date 格式 YYYY-MM-DD
                    release_date = album.get('release_date', '') or res.get('release_date', '')
                    album_id = album.get('id')
                    if album_id:
                        try:
                            album_resp = requests.get(f"https://api.deezer.com/album/{album_id}", timeout=15)
                            if album_resp.status_code == 200:
                                release_date = str(album_resp.json().get('release_date') or release_date)
                        except Exception:
                            pass
                    date_str = release_date[:10] if release_date else ''
                    year_str = date_str[:4] if date_str else ''
                    duration_val = res.get('duration', 0)
                    return {'source': 'Deezer', 'cover_url': cover_url, 'genre': None,
                            'title': s_title, 'artist': norm_simple(artist_name),
                            'album': s_album, 'album_artist': norm_simple(artist_name),
                            'album_type': '单曲' if s_title == s_album else '专辑',
                            'date': date_str, 'year': year_str, 'total_tracks': int(album.get('track_count') or 0),
                            'duration': int(duration_val) if duration_val else 0}
    except Exception:
        LOGGER.debug("Deezer 搜索失败", exc_info=True)
    return None


def search_qq_api(keyword, filename_artist_hint):
    """QQ 音乐搜索 — 收集歌手匹配的候选后按歌名匹配度排序取最佳。"""
    api_url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
    headers = {'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0'}
    params = {'w': keyword, 'n': 10, 'p': 1, 'format': 'json', 'cr': 1, 't': 0}
    try:
        resp = requests.get(api_url, params=params, headers=headers, timeout=300)
        json_data = resp.json()
        song_list = json_data.get('data', {}).get('song', {}).get('list', [])
        all_matches = []
        for song in song_list:
            singers = song.get('singer', [])
            artist_name = singers[0]['name'] if singers else "Unknown"
            if is_fuzzy_match(filename_artist_hint, artist_name):
                album_mid = song.get('albummid')
                cover_url = ""
                if album_mid:
                    cover_url = f"https://y.gtimg.cn/music/photo_new/T002R1000x1000M000{album_mid}.jpg?max_age=2592000"
                pub_time = song.get('time_public', '') or song.get('pub_time', '')
                year = pub_time[:4] if pub_time else ""
                s_title = norm_simple(song.get('songname'))
                s_album = norm_simple(song.get('albumname'))
                is_single = (s_title == s_album) or (len(s_album) == 0)
                duration_val = 0
                try:
                    duration_val = int(song.get('interval', 0) or 0)
                except Exception:
                    pass
                all_matches.append({'source': 'QQMusic', 'cover_url': cover_url, 'song_id': song.get('songmid'),
                                    'genre': None, 'date': pub_time, 'year': year,
                                    'album_type': '单曲' if is_single else '专辑',
                                    'title': s_title, 'artist': norm_simple(artist_name),
                                    'album': s_album, 'album_artist': norm_simple(artist_name),
                                    'duration': duration_val})
        if all_matches:
            # 歌名匹配度排序
            def _qq_score(m):
                t = (m.get('title') or '').lower()
                kw = keyword.lower()
                if t in kw or kw in t:
                    return 100
                if is_chinese_text(t) and is_chinese_text(kw):
                    return len(set(t) & set(kw)) * 10
                return len(set(t.split()) & set(kw.split())) * 15

            all_matches.sort(key=_qq_score, reverse=True)
            return all_matches[0]
    except Exception:
        LOGGER.debug("QQ 音乐搜索失败", exc_info=True)
    return None


def search_kuwo_api(keyword, filename_artist_hint):
    """酷我搜索 — HTTPS 失败自动退回 HTTP；封面 URL 由 ALBUMID 拼出。"""
    try:
        # 优先 HTTPS，不支持时自动退回 HTTP
        for proto in ('https', 'http'):
            try:
                search_url = f"{proto}://search.kuwo.cn/r.s?all={keyword}&ft=music&itemset=web_2013&client=kt&rformat=json&encoding=utf8"
                resp = requests.get(search_url, timeout=300)
                break
            except Exception:
                continue
        content = resp.content.decode('utf-8').replace("'", '"')
        json_str = re.search(r'jsondata\s*=\s*(\{.*?\})', content, re.DOTALL)
        if not json_str:
            return None
        data = json.loads(json_str.group(1))
        if 'abslist' not in data:
            return None
        for song in data['abslist']:
            artist_name = norm_simple(song.get('ARTIST', '').replace('&nbsp;', ' '))
            if is_fuzzy_match(filename_artist_hint, artist_name):
                web_id = song.get('ALBUMID', '')
                cover_url = ""
                if web_id:
                    try:
                        cover_url = f"https://img4.kuwo.cn/star/albumcover/1080/{int(web_id[-2:])}/{int(web_id[-4:-2])}/{web_id}.jpg"
                    except Exception:
                        pass
                if not cover_url:
                    continue
                s_title = norm_simple(song.get('SONGNAME', '').replace('&nbsp;', ' '))
                s_album = norm_simple(song.get('ALBUM', '').replace('&nbsp;', ' '))
                # Kuwo 年份提取 — RELEASE_DATE 格式 YYYY-MM-DD
                release_date = song.get('RELEASE_DATE', '') or song.get('ALBUMDATE', '') or ''
                date_str = release_date[:10] if release_date else ''
                year_str = date_str[:4] if date_str else ''
                duration_val = 0
                try:
                    duration_val = int(song.get('DURATION', 0) or song.get('PLAYTIME', 0))
                except Exception:
                    pass
                return {'source': 'Kuwo', 'cover_url': cover_url, 'song_id': song.get('MUSICRID', '').replace('MUSIC_', ''),
                        'genre': None, 'album_type': '专辑', 'title': s_title, 'artist': artist_name,
                        'album': s_album, 'album_artist': artist_name,
                        'date': date_str, 'year': year_str, 'duration': duration_val}
    except Exception:
        LOGGER.debug("酷我搜索失败", exc_info=True)
    return None


def search_kugou_metadata_api(keyword, filename_artist_hint):
    """酷狗搜索 — 先搜 hash，再拉播放详情拿封面/专辑/发行时间。"""
    try:
        search_url = f"https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={keyword}&page=1&pagesize=5"
        resp = requests.get(search_url, timeout=300)
        data = resp.json()
        candidates = data.get('data', {}).get('info', [])
        for song in candidates:
            artist_name = norm_simple(song.get('singername', ''))
            if is_fuzzy_match(filename_artist_hint, artist_name):
                file_hash = song.get('hash')
                detail_url = f"https://www.kugou.com/yy/index.php?r=play/getdata&hash={file_hash}"
                headers = {'Cookie': 'kg_mid=12345', 'User-Agent': 'Mozilla/5.0'}
                d_resp = requests.get(detail_url, headers=headers, timeout=300)
                d_data = d_resp.json().get('data', {})
                cover_url = d_data.get('img', '').replace('{size}', '480')
                if not cover_url:
                    continue
                s_title = norm_simple(d_data.get('song_name'))
                s_album = norm_simple(d_data.get('album_name'))
                if not s_album:
                    s_album = s_title
                # Kugou 年份提取 — trans_param.publish_time (毫秒时间戳) 或 publish_info
                trans_param = d_data.get('trans_param', {}) or {}
                pub_time_ms = trans_param.get('publish_time', 0) or trans_param.get('ctime', 0)
                date_str, year_str = '', ''
                if pub_time_ms:
                    try:
                        ts = int(pub_time_ms) / 1000 if int(pub_time_ms) > 1e12 else int(pub_time_ms)
                        time_struct = time.localtime(ts)
                        date_str = time.strftime('%Y-%m-%d', time_struct)
                        year_str = time.strftime('%Y', time_struct)
                    except Exception:
                        pass
                # 备用：从 publish_info 字段提取年份
                if not year_str:
                    pub_info = d_data.get('publish_info', '') or d_data.get('pub_time', '') or ''
                    if pub_info:
                        year_match = re.search(r'(\d{4})', str(pub_info))
                        if year_match:
                            year_str = year_match.group(1)
                            date_str = pub_info[:10] if len(pub_info) >= 10 else year_str
                duration_val = 0
                try:
                    duration_val = int(d_data.get('timelength', 0) // 1000)
                except Exception:
                    pass
                return {'source': 'Kugou', 'cover_url': cover_url, 'song_id': str(file_hash),
                        'genre': None, 'album_type': '单曲', 'title': s_title,
                        'artist': norm_simple(d_data.get('author_name')),
                        'album': s_album, 'album_artist': norm_simple(d_data.get('author_name')),
                        'date': date_str, 'year': year_str, 'duration': duration_val}
    except Exception:
        LOGGER.debug("酷狗搜索失败", exc_info=True)
    return None


def search_musicbrainz_api(keyword, filename_artist_hint):
    """MusicBrainz 搜索 — 返回发行组 ID / 歌手国家与 MBID / 发行组类型等权威字段。

    优先取 official 发行、按日期最早排序；封面 URL 指向 Cover Art Archive 的
    ``release-group/{id}/front``（不下载图片本身）。
    """
    base_url = "https://musicbrainz.org/ws/2/recording"
    query = f'recording:"{keyword}" AND artist:"{filename_artist_hint}"'
    params = {"query": query, "fmt": "json", "limit": 3}
    try:
        resp = _musicbrainz_get(base_url, params=params, timeout=300)
        data = resp.json()
        if 'recordings' in data and len(data['recordings']) > 0:
            for rec in data['recordings']:
                credit_items = rec.get('artist-credit', []) or []
                artist_names = [
                    item.get('name') or (item.get('artist') or {}).get('name', '')
                    for item in credit_items
                ]
                artist_names = [str(name).strip() for name in artist_names if str(name).strip()]
                artist_credit = normalize_artist_credit(artist_names)
                artist_info = (credit_items[0] if credit_items else {}).get('artist', {})
                if not is_fuzzy_match(filename_artist_hint, artist_credit):
                    continue
                releases = rec.get('releases', [])
                if not releases:
                    continue

                def _release_date(item):
                    return str(item.get('date') or '9999')

                ordered_releases = sorted(
                    [item for item in releases if str(item.get('status', '')).lower() == 'official']
                    or releases,
                    key=lambda item: (
                        _release_date(item),
                        0 if item.get('media') else 1,
                        str(item.get('title') or ''),
                    ),
                )
                release = ordered_releases[0]
                release_group = release.get('release-group', {}) or {}
                release_group_id = release_group.get('id')
                cover_url = f"https://coverartarchive.org/release-group/{release_group_id}/front" if release_group_id else ""
                date_str = ""
                year_str = ""
                for rel in ordered_releases:
                    d = rel.get('date', '')
                    if d and len(d) >= 4:
                        if not year_str or d[:4] < year_str:
                            year_str = d[:4]
                            date_str = d
                raw_release_type = ", ".join(str(item) for item in release_group.get('secondary-types') or [])
                if not raw_release_type:
                    raw_release_type = str(release_group.get('primary-type') or '')
                # 发行组信息：「单曲 vs 正式专辑」识别、以及「同一张专辑」判定都靠它
                release_group_primary_type = str(release_group.get('primary-type') or '')
                release_group_secondary_types = [
                    str(item) for item in release_group.get('secondary-types') or []]
                try:
                    total_tracks = sum(
                        int(media.get('track-count') or 0)
                        for media in (release.get('media') or []))
                except (TypeError, ValueError):
                    total_tracks = 0
                genre_tags = {}
                for tag_item in rec.get('tags', [])[:5]:
                    name = str(tag_item.get('name') or '').strip()
                    if name:
                        genre_tags[name] = int(tag_item.get('count') or 0)
                genre = ', '.join(name for name, _count in sorted(genre_tags.items(), key=lambda pair: pair[1], reverse=True))
                isrcs = rec.get('isrcs') or []
                # 提取歌手国籍（MusicBrainz artist.country 是 ISO 国家码如 JP, US, CN）
                artist_country = artist_info.get('country', '')
                # MBID：跨专辑稳定的艺人身份，用来归并同一人的多套写法
                artist_mbid = str(artist_info.get('id') or '')
                duration_val = 0
                try:
                    duration_val = int(rec.get('length', 0) or 0) // 1000
                except Exception:
                    pass
                return {'source': 'MusicBrainz', 'cover_url': cover_url, 'genre': genre,
                        'recording_id': rec.get('id'),
                        'date': date_str, 'year': year_str, 'album_type': raw_release_type,
                        'title': norm_simple(rec.get('title')), 'artist': artist_credit,
                        'album': release.get('title', '') if release else "",
                        'album_artist': artist_credit,
                        'artist_country': artist_country, 'artist_mbid': artist_mbid,
                        'release_group_id': release_group_id or '',
                        'release_group_primary_type': release_group_primary_type,
                        'release_group_secondary_types': release_group_secondary_types,
                        'total_tracks': total_tracks,
                        'duration': duration_val,
                        'isrc': str(isrcs[0]) if isrcs else '',
                        'disambiguation': str(rec.get('disambiguation') or ''),
                        'format': ', '.join(media.get('format', '') for media in release.get('media', []) if media.get('format'))}
    except Exception:
        LOGGER.debug("MusicBrainz 搜索失败", exc_info=True)
    return None


def search_lastfm_api(keyword, filename_artist_hint):
    """Last.fm 搜索 — 国际曲库超全，提供高清封面/流派/艺人标签（内置免费 Key）。"""
    try:
        url = "https://ws.audioscrobbler.com/2.0/"
        params = {
            "method": "track.search",
            "track": keyword,
            "api_key": config.LASTFM_API_KEY,
            "format": "json",
            "limit": 5,
        }
        resp = requests.get(url, params=params, timeout=300, headers=MUSIC_HEADERS)
        data = resp.json()
        results = data.get('results', {}).get('trackmatches', {}).get('track', [])
        if not results:
            return None

        for track in results:
            artist_name = track.get('artist', '')
            if not is_fuzzy_match(filename_artist_hint, artist_name):
                continue

            # 获取详细信息（包含专辑封面）
            track_info = None
            try:
                info_params = {
                    "method": "track.getInfo",
                    "api_key": config.LASTFM_API_KEY,
                    "artist": artist_name,
                    "track": track.get('name', ''),
                    "format": "json"
                }
                info_resp = requests.get(url, params=info_params, timeout=300, headers=MUSIC_HEADERS)
                track_info = info_resp.json().get('track', {})
            except Exception:
                pass

            # 提取封面（last.fm 返回 extralarge > large > medium > small）
            cover_url = ""
            if track_info:
                album = track_info.get('album', {})
                for size in ['extralarge', 'large', 'medium']:
                    img = next((i.get('#text', '') for i in album.get('image', []) if i.get('size') == size), '')
                    if img:
                        cover_url = img
                        break

            if not cover_url:
                continue

            s_title = norm_simple(track_info.get('name', track.get('name', ''))) if track_info else norm_simple(track.get('name', ''))
            s_artist = norm_simple(artist_name)

            # 获取流派标签
            genre_tags = []
            if track_info and track_info.get('toptags', {}).get('tag'):
                genre_tags = [t.get('name', '') for t in track_info['toptags']['tag'][:5]]

            album_name = ""
            if track_info and track_info.get('album'):
                album_name = track_info['album'].get('title', '')
            if not album_name:
                album_name = s_title  # fallback

            # Last.fm 年份提取 — wiki.published 或 wiki.content 中可能含发行日期
            date_str, year_str = '', ''
            if track_info:
                wiki = track_info.get('wiki', {}) or {}
                published = wiki.get('published', '') or wiki.get('summary', '')
                if published:
                    year_match = re.search(r'(\d{4})', str(published))
                    if year_match:
                        year_str = year_match.group(1)
                        date_str = year_str
                # 备用：从 album 节点提取
                if not year_str and track_info.get('album'):
                    album_node = track_info['album']
                    for k in ['releasedate', 'release_date', 'intYearReleased']:
                        val = album_node.get(k, '')
                        if val:
                            year_match = re.search(r'(\d{4})', str(val))
                            if year_match:
                                year_str = year_match.group(1)
                                date_str = str(val).strip()
                                break

            # 时长提取
            duration_val = 0
            if track_info:
                try:
                    duration_val = int(track_info.get('duration', 0) or 0)
                except Exception:
                    pass

            return {
                'source': 'Last.fm',
                'cover_url': cover_url,
                'genre': ', '.join(genre_tags) if genre_tags else None,
                'title': s_title,
                'artist': s_artist,
                'album': norm_simple(album_name),
                'album_artist': s_artist,
                'album_type': '单曲' if s_title == album_name else '专辑',
                'date': date_str, 'year': year_str, 'duration': duration_val
            }
    except Exception:
        LOGGER.debug("Last.fm 搜索失败", exc_info=True)
    return None


def search_theaudiodb_api(keyword, filename_artist_hint):
    """TheAudioDB 搜索 — 专辑封面分辨率极高（1920px+），含艺术家简介。"""
    try:
        url = f"https://www.theaudiodb.com/api/v1/json/{config.THEAUDIODB_API_KEY}/searchtrack.php"
        params = {"s": filename_artist_hint if filename_artist_hint else keyword}
        resp = requests.get(url, params=params, timeout=300, headers=MUSIC_HEADERS)
        data = resp.json()
        tracks = data.get('track', [])
        if not tracks:
            return None

        for track in tracks:
            track_artist = track.get('strArtist', '')
            if not is_fuzzy_match(filename_artist_hint, track_artist):
                continue

            track_title = track.get('strTrack', '')
            # 获取专辑详情（含高清封面）
            album_id = track.get('idAlbum', '')
            album_info = None
            cover_url = ""

            if album_id:
                try:
                    album_url = f"https://www.theaudiodb.com/api/v1/json/{config.THEAUDIODB_API_KEY}/album.php"
                    album_resp = requests.get(album_url, params={"m": album_id}, timeout=300, headers=MUSIC_HEADERS)
                    album_data = album_resp.json()
                    albums = album_data.get('album', [])
                    if albums:
                        album_info = albums[0]
                        # 封面优先级：strAlbumThumbHD > strAlbumThumb > strAlbumCDart
                        cover_url = (album_info.get('strAlbumThumbHD') or
                                     album_info.get('strAlbumThumb') or
                                     album_info.get('strAlbumCDart') or '')
                except Exception:
                    pass

            if not cover_url:
                continue

            s_title = norm_simple(track_title)
            s_artist = norm_simple(track_artist)
            s_album = norm_simple(album_info.get('strAlbum', track.get('strAlbum', ''))) if album_info else norm_simple(track.get('strAlbum', ''))

            # 提取流派和年份
            genre = None
            year = ""
            if album_info:
                genre = album_info.get('strGenre') or album_info.get('strStyle')
                year = album_info.get('intYearReleased', '')

            return {
                'source': 'TheAudioDB',
                'cover_url': cover_url,
                'genre': genre,
                'year': str(year) if year else '',
                'title': s_title,
                'artist': s_artist,
                'album': s_album or s_title,
                'album_artist': s_artist,
                'album_type': '专辑'
            }
    except Exception:
        LOGGER.debug("TheAudioDB 搜索失败", exc_info=True)
    return None


_SPOTIFY_TOKEN = None
_SPOTIFY_TOKEN_EXPIRY = 0
_SPOTIFY_TOKEN_LOCK = threading.Lock()


def _get_spotify_token():
    """获取 Spotify Client Credentials access token（线程安全 + 自动刷新）。

    未配置 ``SPOTIFY_CLIENT_ID`` / ``SPOTIFY_CLIENT_SECRET`` 时返回 ``None``。
    """
    global _SPOTIFY_TOKEN, _SPOTIFY_TOKEN_EXPIRY
    now = time.time()
    with _SPOTIFY_TOKEN_LOCK:
        if _SPOTIFY_TOKEN and now < _SPOTIFY_TOKEN_EXPIRY - 60:
            return _SPOTIFY_TOKEN
    client_id = config.get_credential("spotify_client_id")
    client_secret = config.get_credential("spotify_client_secret")
    if not client_id or not client_secret:
        return None
    try:
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        resp = requests.post("https://accounts.spotify.com/api/token",
                             headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/x-www-form-urlencoded"},
                             data={"grant_type": "client_credentials"}, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            with _SPOTIFY_TOKEN_LOCK:
                _SPOTIFY_TOKEN = data.get("access_token")
                _SPOTIFY_TOKEN_EXPIRY = now + data.get("expires_in", 3600)
            return _SPOTIFY_TOKEN
    except Exception:
        LOGGER.debug("Spotify token 获取失败", exc_info=True)
    return None


def search_spotify_api(keyword, filename_artist_hint):
    """Spotify 搜索 — 全球最大正版曲库，含 popularity/preview_url/ISRC/explicit。

    需要 ``SPOTIFY_CLIENT_ID`` + ``SPOTIFY_CLIENT_SECRET``；缺失时返回 ``None``。
    """
    token = _get_spotify_token()
    if not token:
        return None
    try:
        headers = {"Authorization": f"Bearer {token}"}
        q = keyword
        if filename_artist_hint:
            q = f"track:{keyword} artist:{filename_artist_hint}"
        params = {"q": q, "type": "track", "limit": 5, "market": "from_token"}
        resp = requests.get("https://api.spotify.com/v1/search", headers=headers, params=params, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        tracks = data.get("tracks", {}).get("items", [])
        if not tracks and filename_artist_hint:
            params2 = {"q": keyword, "type": "track", "limit": 5, "market": "from_token"}
            resp2 = requests.get("https://api.spotify.com/v1/search", headers=headers, params=params2, timeout=30)
            if resp2.status_code == 200:
                tracks = resp2.json().get("tracks", {}).get("items", [])
        for track in tracks:
            artists = track.get("artists", [])
            artist_names = [a.get("name", "") for a in artists]
            combined_artist = ", ".join(artist_names)
            if not is_fuzzy_match(filename_artist_hint, combined_artist):
                continue
            album = track.get("album", {})
            images = album.get("images", [])
            cover_url = images[0]["url"] if images else ""
            if not cover_url:
                continue
            s_title = norm_simple(track.get("name", ""))
            s_album = norm_simple(album.get("name", ""))
            release_date = album.get("release_date", "")
            date_str = release_date[:10] if release_date else ""
            year_str = release_date[:4] if release_date else ""
            duration_val = int(track.get("duration_ms", 0) // 1000)
            isrc = track.get("external_ids", {}).get("isrc", "")
            track_num = track.get("track_number", 0)
            disc_num = track.get("disc_number", 0)
            return {
                'source': 'Spotify',
                'cover_url': cover_url,
                'song_id': track.get("id"),
                'genre': None,
                'date': date_str, 'year': year_str,
                'album_type': album.get("album_type", "album").capitalize(),
                'title': s_title, 'artist': norm_simple(combined_artist),
                'album': s_album, 'album_artist': norm_simple(", ".join(a.get("name", "") for a in album.get("artists", []))),
                'track_num': track_num, 'disc_num': disc_num,
                'duration': duration_val, 'isrc': isrc,
                'explicit': track.get("explicit", False),
                'popularity': track.get("popularity", 0),
            }
    except Exception:
        LOGGER.debug("Spotify 搜索失败", exc_info=True)
    return None


_genius_token_cache = ""


def _load_genius_token():
    """读取 Genius Access Token（内存 → 环境变量 → 配置文件）；缺失返回 ``''``。"""
    global _genius_token_cache
    if _genius_token_cache:
        return _genius_token_cache
    _genius_token_cache = config.get_credential("genius_access_token")
    return _genius_token_cache


def search_genius_api(keyword, filename_artist_hint):
    """Genius 搜索 — 最佳歌词源 + 歌曲元数据（需 ``GENIUS_ACCESS_TOKEN``）。"""
    token = _load_genius_token()
    if not token:
        return None
    try:
        headers = {"Authorization": f"Bearer {token}"}
        q = f"{keyword} {filename_artist_hint}" if filename_artist_hint else keyword
        params = {"q": q}
        resp = requests.get("https://api.genius.com/search", headers=headers, params=params, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        hits = data.get("response", {}).get("hits", [])
        for hit in hits:
            result = hit.get("result", {})
            artist_name = result.get("primary_artist", {}).get("name", "")
            if not is_fuzzy_match(filename_artist_hint, artist_name):
                continue
            s_title = norm_simple(result.get("title", ""))
            s_artist = norm_simple(artist_name)
            cover_url = result.get("song_art_image_url", "") or result.get("header_image_url", "")
            if not cover_url:
                cover_url = result.get("primary_artist", {}).get("image_url", "")
            if not cover_url:
                continue
            full_title = result.get("full_title", "")
            year_match = re.search(r'\((\d{4})\)', full_title) if full_title else None
            year_str = year_match.group(1) if year_match else ""
            return {
                'source': 'Genius',
                'cover_url': cover_url,
                'song_id': str(result.get("id", "")),
                'genre': None,
                'title': s_title,
                'artist': s_artist,
                'album': norm_simple(result.get("album", {}).get("name", s_title)) if result.get("album") else s_title,
                'album_artist': s_artist,
                'album_type': '单曲',
                'year': year_str,
                'date': year_str,
            }
    except Exception:
        LOGGER.debug("Genius 搜索失败", exc_info=True)
    return None


try:  # 可选依赖：源码里缺失时 search_ytmusic_api 直接返回 None
    from ytmusicapi import YTMusic as _YTMusic

    HAS_YTMLIB = True
except ImportError:  # pragma: no cover
    _YTMusic = None
    HAS_YTMLIB = False

_ytmusic_instance = None
_ytmusic_lock = threading.Lock()


def _get_ytmusic():
    """获取 YouTube Music 实例（线程安全懒初始化）；库缺失返回 ``None``。"""
    global _ytmusic_instance
    if not HAS_YTMLIB:
        return None
    if _ytmusic_instance is not None:
        return _ytmusic_instance
    with _ytmusic_lock:
        if _ytmusic_instance is not None:
            return _ytmusic_instance
        try:
            _ytmusic_instance = _YTMusic()
        except Exception:
            return None
    return _ytmusic_instance


def search_ytmusic_api(keyword, filename_artist_hint):
    """YouTube Music 搜索 — 高分辨率封面 + 浏览量热度（需 ``ytmusicapi`` 库）。"""
    yt = _get_ytmusic()
    if yt is None:
        return None
    try:
        q = f"{keyword} {filename_artist_hint}" if filename_artist_hint else keyword
        results = yt.search(q, filter="songs", limit=5)
        if not results:
            return None
        for r in results:
            artists = r.get("artists", [])
            artist_names = [a.get("name", "") for a in artists]
            combined_artist = ", ".join(artist_names)
            if not is_fuzzy_match(filename_artist_hint, combined_artist):
                continue
            thumbnails = r.get("thumbnails", [])
            cover_url = ""
            max_size = 0
            for thumb in thumbnails:
                w = thumb.get("width", 0)
                h = thumb.get("height", 0)
                if w * h > max_size:
                    max_size = w * h
                    cover_url = thumb.get("url", "")
            if not cover_url:
                continue
            s_title = norm_simple(r.get("title", ""))
            album_info = r.get("album", {}) or {}
            s_album = norm_simple(album_info.get("name", s_title))
            year_str = str(r.get("year", "")) if r.get("year") else ""
            duration_val = 0
            dur_str = r.get("duration", "")
            if dur_str:
                parts = dur_str.split(":")
                try:
                    if len(parts) == 2:
                        duration_val = int(parts[0]) * 60 + int(parts[1])
                except Exception:
                    pass
            return {
                'source': 'YouTubeMusic',
                'cover_url': cover_url,
                'song_id': r.get("videoId", ""),
                'genre': None,
                'title': s_title,
                'artist': norm_simple(combined_artist),
                'album': s_album,
                'album_artist': norm_simple(combined_artist),
                'album_type': '单曲' if not s_album or s_title == s_album else '专辑',
                'date': year_str, 'year': year_str,
                'duration': duration_val,
            }
    except Exception:
        LOGGER.debug("YouTube Music 搜索失败", exc_info=True)
    return None


_discogs_token_cache = ""


def _load_discogs_token():
    """读取 Discogs Token（内存 → 环境变量 → 配置文件）；缺失返回 ``''``。"""
    global _discogs_token_cache
    if _discogs_token_cache:
        return _discogs_token_cache
    _discogs_token_cache = config.get_credential("discogs_token")
    return _discogs_token_cache


def search_discogs_api(keyword, filename_artist_hint):
    """Discogs 搜索 — 实体唱片数据库，提供母带/SACD/黑胶等发行信息（需 Token）。"""
    token = _load_discogs_token()
    if not token:
        return None
    try:
        headers = {
            "Authorization": f"Discogs token={token}",
            "User-Agent": "CyberMediaToolkit/3.0"
        }
        q = keyword
        if filename_artist_hint:
            q = f"{keyword} {filename_artist_hint}"
        params = {"q": q, "type": "master", "per_page": 3}
        resp = requests.get("https://api.discogs.com/database/search", headers=headers, params=params, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        results = data.get("results", [])
        for r in results:
            title_full = r.get("title", "")
            sep_idx = title_full.find(" - ")
            if sep_idx > 0:
                discogs_artist = title_full[:sep_idx].strip()
                discogs_title = title_full[sep_idx + 3:].strip()
            else:
                discogs_artist = ""
                discogs_title = title_full
            if not is_fuzzy_match(filename_artist_hint, discogs_artist):
                continue
            cover_url = r.get("cover_image", "")
            if not cover_url:
                continue
            year_str = str(r.get("year", "")) if r.get("year") else ""
            formats = ", ".join(r.get("format", [])) if r.get("format") else ""
            genres = ", ".join(r.get("genre", [])) if r.get("genre") else ""
            styles = ", ".join(r.get("style", [])) if r.get("style") else ""
            genre_combined = f"{genres} ({styles})" if styles else genres
            return {
                'source': 'Discogs',
                'cover_url': cover_url,
                'song_id': str(r.get("id", "")),
                'genre': genre_combined if genre_combined else None,
                'title': norm_simple(discogs_title),
                'artist': norm_simple(discogs_artist),
                'album': norm_simple(discogs_title),
                'album_artist': norm_simple(discogs_artist),
                'album_type': '专辑',
                'date': year_str, 'year': year_str,
                'format': formats if formats else None,
            }
    except Exception:
        LOGGER.debug("Discogs 搜索失败", exc_info=True)
    return None


# ==================== 🗂️ 引擎注册表 / 统一入口 ====================

def _itunes_runner(region: str):
    """生成绑定地区的 iTunes 搜索闭包（统一 ``(keyword, artist_hint)`` 签名）。"""
    def _run(keyword, artist_hint):
        return search_itunes_api(keyword, region, artist_hint)
    return _run


# engine key → 统一签名的搜索函数 (keyword, artist_hint) -> dict|None
SOURCE_FUNCTIONS: Dict[str, Callable[[str, str], Optional[dict]]] = {
    'Netease': search_netease_api,
    'QQMusic': search_qq_api,
    'Kugou': search_kugou_metadata_api,
    'Kuwo': search_kuwo_api,
    'MusicBrainz': search_musicbrainz_api,
    'iTunes_US': _itunes_runner('US'),
    'iTunes_CN': _itunes_runner('CN'),
    'iTunes_TW': _itunes_runner('TW'),
    'iTunes_HK': _itunes_runner('HK'),
    'Deezer': search_deezer_api,
    'Last.fm': search_lastfm_api,
    'TheAudioDB': search_theaudiodb_api,
    'Spotify': search_spotify_api,
    'Genius': search_genius_api,
    'YouTubeMusic': search_ytmusic_api,
    'Discogs': search_discogs_api,
}


def ordered_sources(sources=None, mbid_hint=False) -> List[str]:
    """给出实际要查询的源顺序。

    :param sources: 显式指定源名列表（``None`` = 全部 :data:`SEARCH_PRIORITY`）
    :param mbid_hint: 已知 MBID 时把 MusicBrainz 提到最前
    :return: 可用且顺序正确的源名列表（不可用/需要 Key 而缺失的会被剔除）
    """
    if sources:
        wanted = [str(name) for name in sources]
    else:
        wanted = list(SEARCH_PRIORITY)
    result = [name for name in wanted if config.source_available(name)]
    if mbid_hint:
        head = [name for name in MBID_FIRST_SOURCES if name in result]
        result = head + [name for name in result if name not in head]
    return result


def _candidate_from_result(result) -> Candidate:
    """把某个源返回的原始 dict 包装成 :class:`Candidate`（字段名不改动）。"""
    if isinstance(result, Candidate):
        return result
    return Candidate.from_dict(result or {})


def _title_sim_score(candidate, keyword, title_hint) -> int:
    """计算候选歌名与搜索关键词的相似度，返回 ``-50 ~ +60``（照抄源码评分）。"""
    res_title = (candidate.get('title') or '').lower()
    if not res_title or not keyword:
        return 0
    kw_lower = keyword.lower()
    # 完全匹配：最高分（短关键词不能包含在长标题中）
    if res_title == kw_lower:
        return 60
    if res_title in kw_lower or kw_lower in res_title:
        if len(kw_lower) <= 2 and len(res_title) > len(kw_lower) + 2:
            return 10
        return 50
    # title_hint 直接匹配
    if title_hint:
        th_lower = title_hint.lower()
        if th_lower == res_title:
            return 55
        if th_lower in res_title or res_title in th_lower:
            if len(th_lower) <= 2 and len(res_title) > len(th_lower) + 2:
                return 15
            return 45
        # 中文逐字重叠
        if is_chinese_text(th_lower) and is_chinese_text(res_title):
            common = len(set(th_lower) & set(res_title))
            if common > 0:
                return 20 + common * 5  # 每重叠一字 +5
        if HAS_FUZZ and _fuzz and _fuzz.token_set_ratio(th_lower, res_title) >= 80:
            return 35
    # 关键词词元命中
    kw_words = [w for w in kw_lower.split() if len(w) >= 2]
    title_words = res_title.split()
    hits = sum(1 for kw in kw_words if any(kw in tw or tw in kw for tw in title_words))
    if hits > 0:
        return 25 + hits * 5
    # 完全不相关
    return -50


def score_candidate(candidate: Candidate, keyword, artist_hint, title_hint=None,
                    duration_hint=None) -> int:
    """按源码权重给候选打分并写入 ``sort_score`` / ``score`` / ``confidence``。

    权重：源基础分（iTunes 80 / MusicBrainz 78 / 网易云 75 / Spotify 85 …）
    + 封面像素面积 + 有年份 + 时长接近 + 歌名相似度 + 上下文加成
    （studio +30 / single +15 / soundtrack +5 / live −15 / compilation −40）。

    :return: 分值（置信度分档：≥120 高 / ≥70 中 / 其余 待确认）
    """
    score = 0
    src = candidate.get('source') or ''
    is_cn_song = is_chinese_text(artist_hint) or is_chinese_text(keyword)
    # Engine base: reduce dominance, cap at 80 so title sim matters more
    if 'iTunes' in src:
        score = 80
    elif 'MusicBrainz' in src:
        score = 78
    elif src == 'Netease':
        score = 75 if is_cn_song else 65
    elif src == 'QQMusic':
        score = 72 if is_cn_song else 55
    elif src == 'Kuwo':
        score = 68 if is_cn_song else 45
    elif src == 'Kugou':
        score = 65 if is_cn_song else 35
    elif src == 'Deezer':
        score = 65
    elif src == 'Last.fm':
        score = 72
    elif src == 'TheAudioDB':
        score = 68
    elif src == 'Spotify':
        score = 85  # 最大正版曲库，数据质量极高
    elif src == 'Genius':
        score = 70  # 歌词最佳，但元数据较少
    elif src == 'YouTubeMusic':
        score = 68  # 封面好但元数据有限
    elif src == 'Discogs':
        score = 78  # 实体唱片元数据权威
    if candidate.get('pixels', 0) > 2000000:
        score += 20
    elif candidate.get('pixels', 0) > 900000:
        score += 10
    if candidate.get('year'):
        score += 10
    if duration_hint and candidate.get('duration'):
        try:
            duration_delta = abs(int(candidate.get('duration')) - int(duration_hint))
            if duration_delta <= 2:
                score += 25
            elif duration_delta <= 5:
                score += 15
            elif duration_delta <= 10:
                score += 5
            else:
                score -= min(30, (duration_delta - 10) // 5)
        except (TypeError, ValueError):
            pass
    # 歌名相似度：防止同名歌手的错误歌曲（只计算一次）
    title_sim = _title_sim_score(candidate, keyword, title_hint)
    score += title_sim
    # Title sim below 0 → strong penalty, don't let context bonuses rescue bad matches
    context_bonus = {'studio': 30, 'single': 15, 'soundtrack': 5, 'live': -15, 'compilation': -40}
    if title_sim >= 0:
        score += context_bonus.get(candidate.get('context', 'unknown'), 0)
    else:
        # 歌名完全不匹配 → 大幅扣分，无视上下文
        score += context_bonus.get(candidate.get('context', 'unknown'), 0) - 30
    candidate['sort_score'] = score
    candidate['score'] = score
    candidate['confidence'] = confidence_level(score)
    return score


def confidence_level(score) -> str:
    """按源码分档给出置信度：``高``(≥120) / ``中``(≥70) / ``待确认``。"""
    try:
        score = int(score)
    except (TypeError, ValueError):
        score = 0
    return "高" if score >= 120 else ("中" if score >= 70 else "待确认")


def probe_image_size(url):
    """探测封面像素面积（优先 Content-Length，其次下载 8KB 头解尺寸）。"""
    if not url:
        return 0
    try:
        resp = requests.get(url, stream=True, timeout=300, headers=MUSIC_HEADERS)
        if resp.status_code == 200:
            if 'Content-Length' in resp.headers:
                return int(resp.headers['Content-Length'])
            chunk = next(resp.iter_content(8192))
            from PIL import Image as _Image
            with _Image.open(io.BytesIO(chunk)) as img:
                return img.size[0] * img.size[1]
    except Exception:
        pass
    return 0


def _collect_candidates(engines, keyword, artist_hint, skip_report=None,
                        max_workers=None, probe=True) -> List[Candidate]:
    """并发跑一组引擎，返回成功命中的候选（内部函数）。

    :param engines: engine key 列表（见 :data:`SOURCE_FUNCTIONS`）
    :param skip_report: 传入 dict 时记录 ``{源: 跳过原因}``
    """
    candidates: List[Candidate] = []
    if not engines:
        return candidates
    with ThreadPoolExecutor(max_workers=max_workers or len(engines) + 2) as executor:
        futures = {}
        for engine in engines:
            func = SOURCE_FUNCTIONS.get(engine)
            if func is None:
                continue
            reason = config.source_skip_reason(engine)
            if reason:
                LOGGER.info("跳过数据源：%s", reason)
                if skip_report is not None:
                    skip_report[engine] = reason
                continue
            futures[executor.submit(safe_api_call, engine, func, keyword, artist_hint)] = engine
        for future in as_completed(futures):
            engine = futures[future]
            try:
                res = future.result()
            except Exception as exc:  # safe_api_call 已吞掉异常，这里只是兜底
                LOGGER.debug("%s 结果异常：%s", engine, exc)
                continue
            if not res:
                continue
            candidate = _candidate_from_result(res)
            if probe and candidate.get('cover_url') and not candidate.get('pixels'):
                candidate['pixels'] = probe_image_size(candidate['cover_url'])
            candidates.append(candidate)
    return candidates


def _relaxed_search(keyword, artist_hint, title_hint, skip_report=None) -> List[Candidate]:
    """所有引擎都失败时的放宽搜索（照抄源码兜底分支）。"""
    candidates: List[Candidate] = []
    artist_hint_fallback = artist_hint if artist_hint else keyword
    relaxed = [('Netease', search_netease_api, (keyword, "")),
               ('QQMusic', search_qq_api, (keyword, "")),
               ('iTunes_US', _itunes_runner('US'), (keyword, "")),
               ('Deezer', search_deezer_api, (keyword, "")),
               ('Spotify', search_spotify_api, (keyword, ""))]
    with ThreadPoolExecutor(max_workers=1) as executor:
        futures = {executor.submit(safe_api_call, name, func, *args): name for name, func, args in relaxed}
        for f in as_completed(futures):
            res = f.result()
            if not res:
                continue
            # 用原始 artist_hint 做二次校验：至少标题或歌手含有关键词
            res_title = res.get('title', '').lower()
            res_artist = res.get('artist', '').lower()
            fallback_words = artist_hint_fallback.lower().split()
            match_ok = False
            for w in fallback_words:
                if w and len(w) >= 2 and (w in res_title or w in res_artist):
                    match_ok = True
                    break
            # title_hint 也要检查 — 防止放宽后拿到同名歌手的错歌
            if match_ok and title_hint:
                th_lower = title_hint.lower()
                if th_lower not in res_title and res_title not in th_lower:
                    match_ok = False  # 歌名必须双向包含才算匹配
            if match_ok:
                candidate = _candidate_from_result(res)
                candidate['pixels'] = probe_image_size(candidate.get('cover_url'))
                candidates.append(candidate)
    return candidates


def search_all(keyword, artist_hint=None, title_hint=None, duration_hint=None,
               sources=None, limit=3, prefer_original_album=True, use_cache=True,
               mbid_hint=False, report=None, probe=True):
    """统一搜索入口：并发查询多个数据源并按源码规则打分排序。

    :param keyword: 搜索词（通常为 ``"歌手 歌名"``）
    :param artist_hint: 文件名/标签给出的歌手，用于 :func:`is_fuzzy_match` 过滤
    :param title_hint: 歌名提示，参与相似度评分与预过滤
    :param duration_hint: 本地时长（秒），接近的候选加分
    :param sources: 指定源名列表（``None`` = :data:`SEARCH_PRIORITY` 全量）
    :param limit: 返回候选数量上限
    :param prefer_original_album: 是否优先录音室专辑（过滤单曲/精选集干扰）
    :param use_cache: 是否使用搜索缓存（命中则直接返回缓存候选）
    :param mbid_hint: 已知 MBID 时把 MusicBrainz 提到最前
    :param report: 传入 dict 时回填 ``{'used': [...], 'skipped': {...}, 'cache_hit': bool}``
    :param probe: 是否探测封面像素面积（网络请求，测试可关）
    :return: 按评分降序的 :class:`Candidate` 列表（最多 ``limit`` 条）
    """
    keyword = str(keyword or '')
    artist_hint = str(artist_hint or '')
    title_hint = str(title_hint or '')
    if report is not None:
        report.setdefault('used', [])
        report.setdefault('skipped', {})
        report['cache_hit'] = False

    if use_cache:
        cached = get_cached_search(keyword, artist_hint)
        if cached:
            if report is not None:
                report['cache_hit'] = True
            candidate = _candidate_from_result(cached)
            return [candidate][:max(1, int(limit or 1))]

    # 请求过的源里，缺 Key 的在这里给出可读原因（不因缺 Key 让整个搜索失败）
    requested = [str(name) for name in (sources or SEARCH_PRIORITY)]
    for name in requested:
        reason = config.source_skip_reason(name)
        if reason:
            LOGGER.info("跳过数据源：%s", reason)
            if report is not None:
                report['skipped'][name] = reason
    engines = ordered_sources(sources, mbid_hint=mbid_hint)
    provider_query = title_hint or keyword
    candidates = _collect_candidates(
        engines, provider_query, artist_hint,
        skip_report=(report or {}).get('skipped') if report is not None else None,
        probe=probe,
    )
    if report is not None:
        report['used'] = [name for name in engines if name not in report['skipped']]

    if not candidates:
        # 所有引擎均失败 — 放宽匹配条件再试
        candidates = _relaxed_search(provider_query, artist_hint, title_hint,
                                     skip_report=(report or {}).get('skipped') if report is not None else None)
    if not candidates:
        return []

    # ── 歌名预过滤：有 title_hint 时，去掉完全不相关的候选 ──
    if title_hint:
        filtered = [c for c in candidates if not (c.get('title') or '') or is_track_title_match(title_hint, c.get('title'))]
        if filtered:
            candidates = filtered
        else:
            # 全部候选歌名都不匹配 → 宁可跳过也不写错歌
            return []

    # 专辑上下文识别：单曲不能被当成正式专辑
    for c in candidates:
        c['context'] = classify_album_context(c)
    for c in candidates:
        score_candidate(c, keyword, artist_hint, title_hint, duration_hint)

    candidates = filter_album_context(candidates, prefer_original_album)
    candidates.sort(key=lambda x: x.get('sort_score', 0), reverse=True)

    best = candidates[0]
    # Reject if title sim is too low for the best candidate
    if best.get('sort_score', 0) < 25:
        return []

    # ── 写入搜索缓存 ──
    if use_cache and best:
        set_cached_search(keyword, artist_hint, best)
        set_cached_album_result(best.get('album', ''), best)

    if not limit or limit <= 0:
        return candidates
    return candidates[:int(limit)]


def search_best_match_global(keyword, artist_hint, title_hint=None, duration_hint=None,
                             prefer_original_album=True):
    """多引擎并发搜索最佳匹配（源码同名函数，行为等价）。

    :return: ``(best, candidates)``；无候选或分数过低时 ``(None, None/候选列表)``
    """
    # ── 缓存命中 → 直接返回 ──
    cached = get_cached_search(keyword, artist_hint)
    if cached:
        return cached, None

    engines = MUSIC_SEARCH_ENGINES + EXTRA_ENGINES
    provider_query = title_hint or keyword
    candidates = _collect_candidates(engines, provider_query, artist_hint)
    if not candidates:
        # 所有引擎均失败 — 放宽匹配条件再试
        candidates = _relaxed_search(keyword, artist_hint, title_hint)
    if not candidates:
        return None, None
    # ── 歌名预过滤：有 title_hint 时，去掉完全不相关的候选 ──
    if title_hint and candidates:
        filtered = [c for c in candidates if not (c.get('title') or '') or is_track_title_match(title_hint, c.get('title'))]
        if filtered:
            candidates = filtered
        else:
            # 全部候选歌名都不匹配 → 宁可跳过也不写错歌
            return None, None
    # 专辑上下文识别：单曲不能被当成正式专辑
    for c in candidates:
        c['context'] = classify_album_context(c)
    for c in candidates:
        score_candidate(c, keyword, artist_hint, title_hint, duration_hint)

    candidates = filter_album_context(candidates, prefer_original_album)
    candidates.sort(key=lambda x: x.get('sort_score', 0), reverse=True)
    best = candidates[0]
    # Reject if title sim is too low for the best candidate
    if best.get('sort_score', 0) < 25:
        return None, candidates
    if len(candidates) > 1 and config.get_credential("siliconflow_api_key"):
        idx = ai_pick_best_album(title_hint or keyword, artist_hint, candidates[:5])
        if idx < len(candidates):
            best = candidates[idx]
    # ── 写入搜索缓存 ──
    if best:
        set_cached_search(keyword, artist_hint, best)
        set_cached_album_result(best.get('album', ''), best)
    return best, candidates


# ==================== 🤖 可选 AI 选择（源码同名逻辑） ====================

def ai_pick_best_album(song_title, artist, candidates):
    """AI 从候选里挑最可能是原始发行专辑的编号；未配置 Key 时返回 ``0``。"""
    if not config.get_credential("siliconflow_api_key") or len(candidates) <= 1:
        return 0
    desc = "\n".join(
        f"{i}. 专辑：{c.get('album', '')}，年份：{c.get('year', '')}，类型：{c.get('context', 'unknown')}，来源：{c.get('source', '')}"
        for i, c in enumerate(candidates[:5])
    )
    prompt = ai_render(
        ai_prompt(
            "music_album_pick",
            "歌曲「{title}」由「{artist}」演唱。请判断哪张专辑最有可能是原始发行专辑"
            "（优先正式录音室专辑，避免精选集/合集）。\n{candidates}\n\n只输出编号，如：0",
        ),
        title=song_title, artist=artist, candidates=desc,
    )
    from .normalize import call_siliconflow
    content = call_siliconflow(prompt, temperature=0.0, max_tokens=5)
    if not content:
        return 0
    try:
        idx = int(re.findall(r'\d+', content)[0])
        return min(idx, len(candidates) - 1)
    except Exception:
        return 0


# ==================== 🖼️ 封面（Cover Art Archive / 下载 / 合并） ====================

def cover_art_archive_url(release_group_id=None, release_id=None, size=None) -> str:
    """拼 Cover Art Archive 封面 URL。

    :param release_group_id: 发行组 ID（优先，跨地区最稳定）
    :param release_id: 具体发行 ID（无发行组 ID 时使用）
    :param size: ``'front'`` / ``'front-500'`` / ``'front-1200'`` 等后缀
    :return: 封面 URL；两个 ID 都为空时返回 ``''``
    """
    rgid = str(release_group_id or '').strip()
    rid = str(release_id or '').strip()
    if rgid:
        base = f"https://coverartarchive.org/release-group/{rgid}"
    elif rid:
        base = f"https://coverartarchive.org/release/{rid}"
    else:
        return ''
    return f"{base}/{size or 'front'}"


def fetch_cover_art_archive(release_group_id=None, release_id=None, size=None,
                            timeout=30):
    """从 Cover Art Archive 取封面图片数据。

    :return: ``(图片字节, mime)``；取不到返回 ``(None, None)``
    """
    url = cover_art_archive_url(release_group_id, release_id, size)
    if not url:
        return None, None
    try:
        resp = requests.get(url, headers=MUSIC_HEADERS, timeout=timeout, allow_redirects=True)
        if resp.status_code != 200 or len(resp.content) < 1000:
            return None, None
        content_type = resp.headers.get('Content-Type', 'image/jpeg')
        mime = 'image/jpeg' if ('jpeg' in content_type or 'jpg' in content_type) else 'image/png'
        return resp.content, mime
    except Exception:
        LOGGER.debug("Cover Art Archive 取封面失败：%s", url, exc_info=True)
        return None, None


def fetch_release_group_title(release_group_id, timeout=30):
    """按发行组 ID 取正式专辑标题 —— 同一张专辑的权威名字（同批次内缓存）。"""
    rgid = str(release_group_id or '').strip()
    if not rgid:
        return ''
    if rgid in _release_group_titles:
        return _release_group_titles[rgid]
    title = ''
    try:
        resp = requests.get(
            f"https://musicbrainz.org/ws/2/release-group/{rgid}",
            params={"fmt": "json"},
            headers=MB_HEADERS, timeout=timeout)
        if resp.status_code == 200:
            title = str((resp.json() or {}).get('title') or '').strip()
    except Exception:
        title = ''
    _release_group_titles[rgid] = title
    return title


_release_group_titles: Dict[str, str] = {}


def download_cover_image(cover_url):
    """下载封面图片数据；小于 300x300 的一律丢弃。

    :return: ``(图片字节, mime)``；失败返回 ``(None, None)``
    """
    if not cover_url:
        return None, None
    try:
        resp = requests.get(cover_url, headers=MUSIC_HEADERS, timeout=300)
        if resp.status_code == 200 and len(resp.content) > 1000:
            content_type = resp.headers.get('Content-Type', 'image/jpeg')
            mime = 'image/jpeg' if 'jpeg' in content_type or 'jpg' in content_type else 'image/png'
            from PIL import Image as _Image
            pil_img = _Image.open(io.BytesIO(resp.content))
            w, h = pil_img.size
            if w < 300 or h < 300:
                return None, None
            return resp.content, mime
    except Exception:
        pass
    return None, None


def _cover_candidate_is_related(best, candidate):
    """高优先级源只能为「同一首歌」改进封面。"""
    best_title = best.get('title', '')
    candidate_title = candidate.get('title', '')
    if best_title and candidate_title and not is_track_title_match(best_title, candidate_title):
        return False
    best_artist = best.get('artist', '')
    candidate_artist = candidate.get('artist', '')
    if best_artist and candidate_artist and not is_fuzzy_match(best_artist, candidate_artist):
        return False
    return True


def merge_candidate_metadata(best, candidates):
    """跨源合并元数据，同时守住「封面来源」与「同一首歌」两条规则。

    iTunes → 网易云 → 其它有封面的源；其余字段按候选顺序补空值。
    """
    best = enhance_metadata(best)
    field_sources = dict(best.get('_field_sources') or {})
    ranked = []
    for source_priority, candidate in enumerate(candidates or []):
        source_name = str(candidate.get('source') or '')
        if 'iTunes' in source_name:
            priority = 0
        elif source_name == 'Netease':
            priority = 1
        elif candidate.get('cover_url'):
            priority = 2
        else:
            continue
        ranked.append((priority, source_priority, candidate))

    cover_candidates = []
    seen_covers = set()
    for _, _, candidate in ranked:
        url = str(candidate.get('cover_url') or '').strip()
        if not url:
            continue
        key = (url, candidate.get('source'))
        if key in seen_covers or not _cover_candidate_is_related(best, candidate):
            continue
        seen_covers.add(key)
        cover_candidates.append({
            'url': url,
            'source': candidate.get('source'),
            'pixels': int(candidate.get('pixels') or 0),
            'selection_score': int(candidate.get('selection_score') or 0),
        })

    other_candidates = [
        item for item in cover_candidates
        if 'iTunes' not in str(item.get('source') or '') and item.get('source') != 'Netease'
    ]
    other_candidates.sort(
        key=lambda item: (
            int(item.get('pixels') or 0),
            int(item.get('selection_score') or 0),
        ),
        reverse=True,
    )

    ordered = [item for item in cover_candidates if 'iTunes' in str(item.get('source') or '')]
    ordered += [item for item in cover_candidates if item.get('source') == 'Netease']
    ordered += other_candidates

    if ordered:
        chosen = ordered[0]
        best['cover_url'] = chosen['url']
        best['cover'] = chosen['url']
        field_sources['cover_url'] = chosen['source']
        best['_cover_candidates'] = ordered
    best['_field_sources'] = field_sources
    related = [
        candidate for candidate in candidates or []
        if _cover_candidate_is_related(best, candidate)
    ]
    enrich_fields = (
        'genre', 'composer', 'lyricist', 'artist_country', 'album_type',
        'date', 'year', 'track_num', 'total_tracks', 'disc_num', 'isrc',
        'language', 'format',
    )
    for field_name in enrich_fields:
        if best.get(field_name):
            continue
        for candidate in related:
            value = str(candidate.get(field_name) or '').strip()
            if value:
                best[field_name] = value
                field_sources[field_name] = candidate.get('source') or 'cross-source'
                break
    best['_field_sources'] = field_sources
    return best


def download_cover_with_fallback(metadata):
    """按合并后的封面优先顺序下载，返回第一个可用封面。

    :return: ``(图片字节, mime, 来源源名, 命中序号)``；全部失败 ``(None, None, '', -1)``
    """
    candidates = list(metadata.get('_cover_candidates') or [])
    if not candidates and metadata.get('cover_url'):
        candidates = [{
            'url': metadata.get('cover_url'),
            'source': (metadata.get('_field_sources') or {}).get('cover_url', ''),
        }]

    for index, candidate in enumerate(candidates):
        image_data, image_mime = download_cover_image(candidate.get('url'))
        if not image_data:
            continue
        source = str(candidate.get('source') or '')
        metadata['cover_url'] = candidate.get('url')
        metadata['cover'] = candidate.get('url')
        metadata.setdefault('_field_sources', {})['cover_url'] = source
        return image_data, image_mime, source, index
    return None, None, '', -1


def save_cover_file(filepath, image_data, artist, album, cover_dir=None):
    """把封面另存为与音频同名的 jpg 文件（``{cover_dir}/{安全文件名}.jpg``）。"""
    if not image_data:
        return None
    cover_root = cover_dir or os.path.join(
        os.path.dirname(filepath) if os.path.exists(os.path.dirname(filepath)) else os.getcwd(),
        "Covers")
    os.makedirs(cover_root, exist_ok=True)
    # 使用音频文件 basename（不含扩展名）作为封面文件名，确保一一对应
    base = os.path.splitext(os.path.basename(filepath))[0]
    safe_name = normalize_sanitize_filename(base)
    cover_path = os.path.join(cover_root, f"{safe_name}.jpg")
    try:
        with open(cover_path, 'wb') as f:
            f.write(image_data)
        return cover_path
    except Exception:
        return None


# ==================== 📝 歌词 ====================

def get_netease_lyrics(song_id):
    """按网易云歌曲 ID 取 LRC 歌词（``lrc`` 缺失时退回 ``klyric``）。"""
    if not song_id:
        return None
    api_url = f"https://music.163.com/api/song/lyric?id={song_id}&lv=1&kv=-1&tv=-1"
    headers = {'Referer': 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0'}
    try:
        resp = requests.get(api_url, headers=headers, timeout=300)
        data = resp.json()
        lrc = data.get('lrc', {}).get('lyric')
        if not lrc:
            lrc = data.get('klyric', {}).get('lyric')
        return lrc
    except Exception:
        return None


def get_qq_lyrics(song_mid):
    """按 QQ 音乐 songmid 取 LRC 歌词（base64 解码）。"""
    if not song_mid:
        return None
    try:
        url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"
        headers = {'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0'}
        params = {'songmid': song_mid, 'g_tk': '5381', 'format': 'json', 'inCharset': 'utf8', 'outCharset': 'utf-8', 'nobase64': 0}
        resp = requests.get(url, params=params, headers=headers, timeout=300)
        data = resp.json()
        lyric_blob = data.get('lyric', '')
        if not lyric_blob:
            return None
        return base64.b64decode(lyric_blob).decode('utf-8', errors='ignore')
    except Exception:
        return None


def get_lrclib_lyrics(title, artist, album="", duration=0):
    """LRCLIB 取歌词：先精确查询，失败再搜索并按「歌手+歌名+时长」综合评分排序。"""
    try:
        params = {'track_name': title, 'artist_name': artist, 'album_name': album, 'duration': duration}
        params = {k: v for k, v in params.items() if v}
        resp = requests.get("https://lrclib.net/api/get", params=params, timeout=300)
        if resp.status_code == 200:
            data = resp.json()
            return data.get('syncedLyrics', data.get('plainLyrics'))
        resp = requests.get("https://lrclib.net/api/search", params={'q': f"{title} {artist}"}, timeout=300)
        if resp.status_code == 200:
            results = resp.json()
            if results and isinstance(results, list):
                # ── 综合评分排序：artist 匹配 + title 匹配 + duration 校验 ──
                def _lyrics_score(res):
                    res_artist = (res.get('artistName') or '').lower()
                    res_title = (res.get('trackName') or '').lower()
                    res_duration = res.get('duration') or 0
                    score = 0
                    # Artist 匹配
                    if artist:
                        art_lower = artist.lower()
                        if art_lower in res_artist or res_artist in art_lower:
                            score += 30
                        elif HAS_FUZZ and _fuzz:
                            art_ratio = _fuzz.token_sort_ratio(art_lower, res_artist)
                            if art_ratio >= 85:
                                score += 25
                            elif art_ratio >= 70:
                                score += 15
                    # Title 匹配
                    if title:
                        tit_lower = title.lower()
                        if tit_lower == res_title:
                            score += 40
                        elif tit_lower in res_title or res_title in tit_lower:
                            score += 30
                        elif HAS_FUZZ and _fuzz:
                            tit_ratio = _fuzz.token_sort_ratio(tit_lower, res_title)
                            if tit_ratio >= 85:
                                score += 25
                            elif tit_ratio >= 70:
                                score += 10
                    # Duration 校验
                    if duration and res_duration:
                        try:
                            diff = abs(int(res_duration) - int(duration))
                            if diff <= 3:
                                score += 20
                            elif diff <= 10:
                                score += 10
                            elif diff > 30:
                                score -= 15  # 时长差距过大 → 惩罚
                        except Exception:
                            pass
                    # 优先 synced lyrics
                    if res.get('syncedLyrics'):
                        score += 5
                    return score

                results.sort(key=_lyrics_score, reverse=True)
                for res in results:
                    if res.get('syncedLyrics'):
                        return res['syncedLyrics']
                for res in results:
                    if res.get('plainLyrics'):
                        return res['plainLyrics']
    except Exception:
        pass
    return None


def get_kugou_lyrics(keyword, duration=None):
    """酷狗取歌词：先评分挑最匹配的 hash，再换取 LRC 下载地址。"""
    try:
        search_url = f"https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={keyword}&page=1&pagesize=5"
        resp = requests.get(search_url, timeout=300)
        data = resp.json()
        candidates = data.get('data', {}).get('info', [])
        if not candidates:
            return None
        # ── 综合评分：歌名匹配 + 歌手匹配 + 时长校验 ──
        kw_parts = keyword.lower().split()
        kw_title = kw_parts[0] if kw_parts else keyword.lower()
        kw_artist = ' '.join(kw_parts[1:]) if len(kw_parts) > 1 else ''

        def _kugou_score(c):
            s_name = (c.get('songname') or '').lower()
            s_artist = (c.get('singername') or '').lower()
            score = 0
            # 歌名匹配
            if kw_title in s_name or s_name in kw_title:
                score += 4
            elif HAS_FUZZ and _fuzz and _fuzz.token_sort_ratio(kw_title, s_name) >= 80:
                score += 3
            # 歌手匹配
            if kw_artist:
                if kw_artist in s_artist or s_artist in kw_artist:
                    score += 3
                elif HAS_FUZZ and _fuzz and _fuzz.token_sort_ratio(kw_artist, s_artist) >= 75:
                    score += 2
            # 合并关键词匹配（兜底）
            kw_lower = keyword.lower()
            if kw_lower in s_name or s_name in kw_lower:
                score += 2
            if kw_lower in s_artist or s_artist in kw_lower:
                score += 1
            # 时长校验
            if duration and c.get('duration'):
                try:
                    diff = abs(int(c['duration']) - int(duration))
                    if diff <= 5:
                        score += 2
                    elif diff <= 15:
                        score += 1
                    elif diff > 30:
                        score -= 3  # 时长差距过大 → 惩罚
                except Exception:
                    pass
            return score

        best_idx = 0
        best_score = -1
        for idx, c in enumerate(candidates):
            score = _kugou_score(c)
            if score > best_score:
                best_score = score
                best_idx = idx
        best_hash = candidates[best_idx].get('hash')
        if not best_hash:
            return None
        lrc_url = f"https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash={best_hash}&album_audio_id="
        lrc_resp = requests.get(lrc_url, timeout=300)
        lrc_data = lrc_resp.json()
        if lrc_data.get('status') == 200 and lrc_data.get('candidates'):
            info = lrc_data['candidates'][0]
            access_key = info.get('accesskey')
            id_val = info.get('id')
            dl_url = f"https://lyrics.kugou.com/download?ver=1&client=pc&id={id_val}&accesskey={access_key}&fmt=lrc&charset=utf8"
            dl_resp = requests.get(dl_url, timeout=300)
            json_res = dl_resp.json()
            b64_lrc = json_res.get('content')
            if b64_lrc:
                return base64.b64decode(b64_lrc).decode('utf-8', errors='ignore')
    except Exception:
        pass
    return None


def fetch_lyrics(title, artist, album="", duration=0, netease_id=None, qq_mid=None):
    """全局歌词抓取：网易云 → QQ 音乐 → LRCLIB → 酷狗（源码 ``global_fetch_lyrics``）。

    :param title: 歌名
    :param artist: 歌手
    :param album: 专辑（LRCLIB 精确查询用）
    :param duration: 时长（秒），用于匹配校验
    :param netease_id: 网易云歌曲 ID（有则优先）
    :param qq_mid: QQ 音乐 songmid（有则次优先）
    :return: ``(歌词文本, 来源名)``；全都失败返回 ``(None, "None")``
    """
    if netease_id:
        lrc = get_netease_lyrics(netease_id)
        if lrc:
            return lrc, "网易云"
    if qq_mid:
        lrc = get_qq_lyrics(qq_mid)
        if lrc:
            return lrc, "QQ音乐"
    lrc = get_lrclib_lyrics(title, artist, album, duration)
    if lrc:
        return lrc, "Lrclib.net"
    lrc = get_kugou_lyrics(f"{title} {artist}", duration)
    if lrc:
        return lrc, "酷狗音乐"
    return None, "None"


# 源码原名（兼容旧调用方）
global_fetch_lyrics = fetch_lyrics


def extract_credits_from_lyrics(lrc_text):
    """从 LRC 头部提取作曲/作词（正则规则版，不调用 AI）。

    :return: ``{'composer': ..., 'lyricist': ...}``（可能只有其中一个键）
    """
    if not lrc_text:
        return {}
    result = {}

    # 取前 30 行（创作者信息通常在头部）
    lines = lrc_text.split('\n')[:30]

    # 模式 2：中文元数据行 — "作词：XXX" / "作曲：XXX" / "编曲：XXX" 等
    chinese_patterns = [
        (r'作词[：:]\s*(.+?)(?:[/／].*)?$', 'lyricist'),
        (r'作曲[：:]\s*(.+?)(?:[/／].*)?$', 'composer'),
        (r'编曲[：:]\s*(.+?)(?:[/／].*)?$', 'arranger'),
        (r'词[：:]\s*(.+?)(?:[/／].*)?$', 'lyricist'),
        (r'曲[：:]\s*(.+?)(?:[/／].*)?$', 'composer'),
        (r'填词[：:]\s*(.+?)(?:[/／].*)?$', 'lyricist'),
        (r'制作人[：:]\s*(.+?)(?:[/／].*)?$', 'producer'),
        (r'混音[：:]\s*(.+?)(?:[/／].*)?$', 'mixer'),
    ]
    for line in lines:
        clean = re.sub(r'\[\d{2,}:\d{2}(?:\.\d+)?\]', '', line).strip()
        for pattern, key in chinese_patterns:
            m = re.match(pattern, clean)
            if m:
                val = m.group(1).strip()
                # 清理常见噪音
                val = re.sub(r'[（(].*?[）)]', '', val).strip()
                if key == 'lyricist' and not result.get('lyricist') and val:
                    result['lyricist'] = norm_simple(val)
                elif key == 'composer' and not result.get('composer') and val:
                    result['composer'] = norm_simple(val)

    # 模式 3：英文元数据行
    english_patterns = [
        (r'(?:Composer|Music)\s*[：:]\s*(.+)', 'composer'),
        (r'(?:Lyricist|Lyrics|Words)\s*[：:]\s*(.+)', 'lyricist'),
        (r'Music\s+by\s+(.+)', 'composer'),
        (r'(?:Words|Lyrics)\s+by\s+(.+)', 'lyricist'),
        (r'Written\s+by\s+(.+)', 'lyricist'),
    ]
    for line in lines:
        clean = re.sub(r'\[\d{2,}:\d{2}(?:\.\d+)?\]', '', line).strip()
        for pattern, key in english_patterns:
            m = re.match(pattern, clean, re.IGNORECASE)
            if m:
                val = m.group(1).strip()
                val = re.sub(r'[（(].*?[）)]', '', val).strip()
                if key == 'composer' and not result.get('composer') and val:
                    result['composer'] = val
                elif key == 'lyricist' and not result.get('lyricist') and val:
                    result['lyricist'] = val

    # 模式 4：LRC 中有非时间轴元数据（部分歌词文件的特殊格式）
    # 如 "[00:00.00]作曲：周杰伦 / 作词：方文山"
    for line in lines:
        ts_match = re.match(r'\[\d{2,}:\d{2}(?:\.\d+)?\](.+)', line)
        if not ts_match:
            continue
        body = ts_match.group(1).strip()
        # 检查是否同时包含作曲和作词
        composer_m = re.search(r'作曲[：:]\s*(.+?)(?:[/／].*?(?:作词|编曲)|$)', body)
        lyricist_m = re.search(r'作词[：:]\s*(.+?)(?:[/／].*?(?:作曲|编曲)|$)', body)
        if composer_m and not result.get('composer'):
            val = composer_m.group(1).strip()
            result['composer'] = norm_simple(val)
        if lyricist_m and not result.get('lyricist'):
            val = lyricist_m.group(1).strip()
            result['lyricist'] = norm_simple(val)

    return result


# ==================== 🔎 增强元数据（作曲/作词/音轨号） ====================

def enhance_metadata_netease(song_id):
    """通过网易云歌曲详情 API 获取作曲/作词/音轨号。"""
    try:
        url = f"https://music.163.com/api/song/detail?ids=%5B{song_id}%5D"
        headers = {'Referer': 'https://music.163.com/', 'User-Agent': MUSIC_HEADERS['User-Agent']}
        resp = requests.get(url, headers=headers, timeout=300)
        data = resp.json()
        songs = data.get('songs', [])
        if songs:
            song = songs[0]
            composer = song.get('pc', {}).get('name', '') if song.get('pc') else ''
            lyricist = ''
            lc = song.get('lc')
            if lc and lc.get('name'):
                lyricist = lc['name']
            result = {}
            if composer:
                result['composer'] = norm_simple(composer)
            if lyricist:
                result['lyricist'] = norm_simple(lyricist)
            no = song.get('no')
            if no:
                result['track_num'] = no
            return result
    except Exception:
        pass
    return {}


def enhance_metadata_qq(song_mid):
    """通过 QQ 音乐歌曲详情获取作曲/作词。"""
    try:
        url = "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg"
        headers = {'Referer': 'https://y.qq.com/', 'User-Agent': MUSIC_HEADERS['User-Agent']}
        params = {'songmid': song_mid, 'format': 'json', 'tpl': 'yqq_song_detail'}
        resp = requests.get(url, params=params, headers=headers, timeout=300)
        data = resp.json()
        song_data = data.get('data', [{}])[0] if data.get('data') else {}
        result = {}
        composer = song_data.get('composer', '')
        if composer:
            result['composer'] = norm_simple(composer)
        # QQ 音乐的 lyricist 字段可能叫 lyricist 或 writer
        lyricist = song_data.get('lyricist', '') or song_data.get('writer', '')
        if lyricist:
            result['lyricist'] = norm_simple(lyricist)
        return result
    except Exception:
        pass
    return {}


def extract_musicbrainz_work_credits(relations):
    """从 MusicBrainz work relations 提取作曲/作词（writer 同时填两栏）。"""
    result = {}
    writers = []
    for relation in relations or []:
        rel_type = str(relation.get('type') or '').lower()
        artist_name = str((relation.get('artist') or {}).get('name') or '').strip()
        if not artist_name:
            continue
        if rel_type == 'composer':
            result.setdefault('composer', normalize_artist_credit(artist_name))
        elif rel_type == 'lyricist':
            result.setdefault('lyricist', normalize_artist_credit(artist_name))
        elif rel_type == 'writer':
            writers.append(artist_name)

    if writers:
        joined = normalize_artist_credit(writers)
        result.setdefault('composer', joined)
        result.setdefault('lyricist', joined)
    return result


def enhance_metadata_musicbrainz(best):
    """拉 MusicBrainz work 关系补作曲/作词（1 req/s 限速）。"""
    recording_id = str(best.get('recording_id') or '').strip()
    if not recording_id:
        return {}
    try:
        recording_resp = _musicbrainz_get(
            f'https://musicbrainz.org/ws/2/recording/{recording_id}',
            params={'fmt': 'json', 'inc': 'work-rels'},
            timeout=30,
        )
        recording_resp.raise_for_status()
        relations = recording_resp.json().get('relations') or []
        work_ids = [
            (relation.get('work') or {}).get('id')
            for relation in relations
            if str(relation.get('type') or '').lower() == 'performance'
        ]

        credits = {}
        if work_ids:
            work_resp = _musicbrainz_get(
                f'https://musicbrainz.org/ws/2/work/{work_ids[0]}',
                params={'fmt': 'json', 'inc': 'artist-rels'},
                timeout=30,
            )
            work_resp.raise_for_status()
            credits = extract_musicbrainz_work_credits(work_resp.json().get('relations'))
        else:
            title = best.get('title') or ''
            artist = best.get('artist') or ''
            if title and artist:
                work_resp = _musicbrainz_get(
                    'https://musicbrainz.org/ws/2/work',
                    params={
                        'query': f'work:"{title}" AND artist:"{artist}"',
                        'fmt': 'json', 'limit': 1,
                    },
                    timeout=30,
                )
                work_resp.raise_for_status()
                works = work_resp.json().get('works') or []
                if works:
                    credits = extract_musicbrainz_work_credits(works[0].get('relations'))
        return {
            key: value for key, value in credits.items()
            if key in ('composer', 'lyricist') and value
        }
    except Exception:
        return {}


def enhance_metadata_genius(best):
    """取 Genius 的 songwriter 列表补作词人（需 Token）。"""
    token = _load_genius_token()
    song_id = str(best.get('song_id') or '').strip()
    if not token or not song_id or best.get('source') != 'Genius':
        return {}
    try:
        resp = requests.get(
            f'https://api.genius.com/songs/{song_id}',
            headers={'Authorization': f'Bearer {token}'}, timeout=30,
        )
        resp.raise_for_status()
        song = resp.json().get('response', {}).get('song') or {}
        writers = [
            item.get('name', '') for item in song.get('writer_artists') or []
            if item.get('name', '')
        ]
        if writers:
            return {'lyricist': normalize_artist_credit(writers)}
    except Exception:
        pass
    return {}


def enhance_metadata(best):
    """按匹配来源补作曲/作词/音轨号（只填空缺字段，不覆盖已有值）。"""
    source = best.get('source', '')
    song_id = best.get('song_id', '')
    if not song_id:
        return best
    extra = {}
    if source == 'Netease':
        extra = enhance_metadata_netease(song_id)
    elif source == 'QQMusic':
        extra = enhance_metadata_qq(song_id)
    elif source == 'MusicBrainz':
        extra = enhance_metadata_musicbrainz(best)
    elif source == 'Genius':
        extra = enhance_metadata_genius(best)
    for k, v in extra.items():
        if v and not best.get(k):
            best[k] = v
    return best


# ==================== 🗓️ 年份 / 字段补齐 ====================

def cross_source_fill_year(best, candidates):
    """从候选列表补齐 best 缺失的年份/date 字段。

    策略：同专辑或同歌名优先 → 多数共识取中位数（差距 ≤2 年的候选占 60% 才采用）。
    """
    if best.get('year') and best.get('date'):
        return best
    if not candidates:
        return best

    # 收集所有候选的年份
    years = []
    for c in candidates:
        y = c.get('year', '')
        if y and len(str(y)) == 4:
            try:
                years.append(int(y))
            except Exception:
                pass

    if not years:
        return best

    # 策略2：从同专辑候选中取年份
    best_album = (best.get('album') or '').lower()
    best_title = (best.get('title') or '').lower()
    for c in candidates:
        c_album = (c.get('album') or '').lower()
        c_title = (c.get('title') or '').lower()
        if c.get('year'):
            # 同专辑 或 同歌名 → 优先采用
            if (best_album and best_album == c_album) or (best_title and best_title == c_title):
                if not best.get('year'):
                    best['year'] = c['year']
                if not best.get('date') and c.get('date'):
                    best['date'] = c['date']
                return best

    # 策略3：多数共识 — 取中位数年份（排除异常值）
    if len(years) >= 2:
        years_sorted = sorted(years)
        median_year = years_sorted[len(years_sorted) // 2]
        # 检查一致性：如果大多数候选年份差距不超过 2 年，取中位数
        close_count = sum(1 for y in years if abs(y - median_year) <= 2)
        if close_count >= len(years) * 0.6:
            if not best.get('year'):
                best['year'] = str(median_year)
            if not best.get('date'):
                best['date'] = str(median_year)
    elif len(years) == 1:
        if not best.get('year'):
            best['year'] = str(years[0])
        if not best.get('date'):
            best['date'] = str(years[0])

    return best


def ai_infer_year(artist, title, album=""):
    """AI 推断发行年份（所有在线源都没给年份时的兜底）；未配置 Key 返回 ``None``。"""
    if not config.get_credential("siliconflow_api_key"):
        return None
    prompt = ai_render(
        ai_prompt(
            "music_infer_year",
            "请推断以下歌曲的发行年份。\n"
            "歌手: {artist}\n歌名: {title}\n专辑: {album}\n\n"
            "基于你的知识，推断这首歌最可能的首次发行年份。\n"
            "只输出 4 位数字年份，如 2019。如果完全不确定，输出 0000。",
        ),
        artist=artist, title=title, album=(album or '未知'),
    )
    from .normalize import call_siliconflow
    result = call_siliconflow(prompt, temperature=0.0, max_tokens=10)
    if not result:
        return None
    year_match = re.search(r'(\d{4})', result)
    if year_match:
        year = year_match.group(1)
        # 合理范围检查：1900 ~ 当前年份+1
        try:
            y = int(year)
            current_year = int(time.strftime('%Y'))
            if 1900 <= y <= current_year + 1:
                return year
        except Exception:
            pass
    return None


def fill_missing_metadata(best, candidates):
    """综合补齐 best 缺失的字段（年份、时长）——跨源共识 + AI 年份兜底。"""
    if not best:
        return best
    # 年份补齐
    if not best.get('year'):
        best = cross_source_fill_year(best, candidates)
    # 年份 AI 兜底
    if not best.get('year'):
        ai_year = ai_infer_year(best.get('artist', ''), best.get('title', ''), best.get('album', ''))
        if ai_year:
            best['year'] = ai_year
            if not best.get('date'):
                best['date'] = ai_year
    # 时长补齐 — 从候选中取
    if not best.get('duration'):
        for c in candidates:
            if c.get('duration'):
                best['duration'] = c['duration']
                break
    return best
    return best
