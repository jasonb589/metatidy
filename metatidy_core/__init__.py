"""metatidy_core — 音乐元数据刮削 + 标签读写的纯逻辑库（无 GUI 依赖）。

从 PySide6/QML 桌面项目 ``media_toolkit.py`` 中抽取出来的音乐模块，只保留计算与
网络逻辑：搜索 12 个数据源、匹配打分、封面与歌词获取、音频标签读写、名称归一化。

快速开始::

    from metatidy_core import search_all, plan_tag_update, apply_tag_update, read_audio_tags

    candidates = search_all("Jay Chou 稻香", artist_hint="周杰伦", title_hint="稻香", limit=3)
    best = candidates[0]
    plan = plan_tag_update("song.mp3", best)      # {字段: {'old': ..., 'new': ...}}
    ok, err = apply_tag_update(plan)              # 用户确认后再落盘

模块划分：

* :mod:`metatidy_core.scrapers` — 12 个数据源搜索 + 统一入口 + 封面/歌词
* :mod:`metatidy_core.tagger`   — 标签读（``read_audio_tags``）写（``update_audio_tags``）
* :mod:`metatidy_core.normalize`— 名称归一 / 文件名解析 / 语种判定
* :mod:`metatidy_core.config`   — 可选 API Key 与数据源可用性

不导入任何 GUI 库（无 PySide6 / QML / customtkinter / tkinter / plyer）。
"""

from __future__ import annotations

from . import config, normalize, scrapers, tagger
from .config import (
    KEYLESS_SOURCES,
    SOURCE_CREDENTIALS,
    active_sources,
    configure_music_providers,
    get_credential,
    provider_status,
    set_credential,
    source_available,
    source_skip_reason,
)
from .normalize import (
    ARTIST_NATIONALITY_DB,
    classify_album_context,
    infer_album_type,
    is_fuzzy_match,
    normalize_album_type,
    normalize_artist_credit,
    normalize_artist_display,
    normalize_music_filename_artist_credit,
    parse_filename_smart,
    resolve_music_language,
    sanitize_filename,
    simple_convert,
    strip_edition_suffix,
)
from .scrapers import (
    MBID_FIRST_SOURCES,
    SEARCH_PRIORITY,
    Candidate,
    CircuitBreaker,
    cover_art_archive_url,
    fetch_cover_art_archive,
    fetch_lyrics,
    get_cached_search,
    safe_api_call,
    safe_call,
    search_all,
    search_best_match_global,
    search_deezer_api,
    search_discogs_api,
    search_genius_api,
    search_itunes_api,
    search_kugou_metadata_api,
    search_kuwo_api,
    search_lastfm_api,
    search_musicbrainz_api,
    search_netease_api,
    search_qq_api,
    search_spotify_api,
    search_theaudiodb_api,
    search_ytmusic_api,
    set_cached_search,
    set_circuit_breaker_registry,
    set_search_cache,
)
from .tagger import (
    TagUpdatePlan,
    apply_tag_update,
    normalize_audio_artist_tags,
    plan_tag_update,
    read_audio_tags,
    read_cover,
    update_audio_tags,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # 子模块
    "config", "normalize", "scrapers", "tagger",
    # 搜索
    "Candidate", "search_all", "search_best_match_global", "SEARCH_PRIORITY",
    "MBID_FIRST_SOURCES", "search_netease_api", "search_qq_api", "search_kugou_metadata_api",
    "search_kuwo_api", "search_musicbrainz_api", "search_itunes_api", "search_deezer_api",
    "search_lastfm_api", "search_theaudiodb_api", "search_spotify_api", "search_genius_api",
    "search_ytmusic_api", "search_discogs_api", "fetch_lyrics", "fetch_cover_art_archive",
    "cover_art_archive_url",
    # 稳定性机制
    "CircuitBreaker", "get_cached_search", "set_cached_search", "safe_api_call",
    "safe_call", "set_circuit_breaker_registry", "set_search_cache",
    # 标签
    "update_audio_tags", "plan_tag_update", "apply_tag_update", "read_audio_tags",
    "read_cover", "TagUpdatePlan", "normalize_audio_artist_tags",
    # 归一化
    "normalize_artist_credit", "normalize_music_filename_artist_credit",
    "normalize_artist_display", "sanitize_filename", "parse_filename_smart",
    "is_fuzzy_match", "simple_convert", "strip_edition_suffix",
    "normalize_album_type", "infer_album_type", "classify_album_context",
    "resolve_music_language", "ARTIST_NATIONALITY_DB",
    # 配置
    "source_available", "source_skip_reason", "active_sources", "provider_status",
    "get_credential", "set_credential", "configure_music_providers",
    "SOURCE_CREDENTIALS", "KEYLESS_SOURCES",
]
