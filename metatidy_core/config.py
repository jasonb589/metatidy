"""配置读取：可选的 API Key、数据源可用性判定、公共请求头。

迁移自 ``media_toolkit.py`` 的 Key 加载逻辑（``_load_api_key`` / ``_load_setting``
/ ``configure_music_providers`` 与 ``HEADERS`` / ``MUSIC_HEADERS`` 常量）。

设计要点：
* **所有 Key 都是可选的**：缺失时不抛异常，由 :func:`source_available` /
  :func:`source_skip_reason` 给出可读原因，调用方跳过该数据源即可。
* 读取顺序与源码一致：环境变量优先 → 持久化配置文件（默认
  ``~/.cyber_toolkit_settings.json``，可用环境变量 ``METATIDY_SETTINGS_FILE`` 覆盖）。
* 12 个内置数据源（网易云 / QQ / 酷狗 / 酷我 / MusicBrainz / Cover Art Archive /
  iTunes / Deezer / Last.fm / TheAudioDB / YouTube Music / LRCLIB）**无需任何 Key**。
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, Mapping, Optional

LOGGER = logging.getLogger(__name__)

__all__ = [
    "SETTINGS_FILE",
    "MUSIC_HEADERS",
    "SEARCH_HEADERS",
    "MB_USER_AGENT",
    "LASTFM_API_KEY",
    "THEAUDIODB_API_KEY",
    "SILICONFLOW_API_URL",
    "AI_MODEL",
    "DEEPSEEK_MODEL",
    "PROVIDER_ENV_KEYS",
    "KEYLESS_SOURCES",
    "SOURCE_CREDENTIALS",
    "load_setting",
    "get_credential",
    "set_credential",
    "configure_music_providers",
    "provider_status",
    "source_available",
    "source_skip_reason",
    "active_sources",
    "load_api_key",
    "persisted_path",
]

# ── 持久化配置文件（与源码同一路径，可用环境变量覆盖）──
SETTINGS_FILE = os.environ.get("METATIDY_SETTINGS_FILE") or os.path.join(
    os.path.expanduser("~"), ".cyber_toolkit_settings.json"
)

# ── 公共请求头（照抄源码 HEADERS / MUSIC_HEADERS）──
_UA_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
SEARCH_HEADERS: Dict[str, str] = {"User-Agent": _UA_CHROME}
MUSIC_HEADERS: Dict[str, str] = {"User-Agent": _UA_CHROME}

# MusicBrainz 要求带可识别 UA（源码写死为 MusicScraper/10.0）
MB_USER_AGENT = "MusicScraper/10.0"

# ── 内置免费 Key（源码里直接写死的公开测试 Key）──
LASTFM_API_KEY = "2bd6d4b4f7d439b7c41f0fd8b7e3b8e1"
THEAUDIODB_API_KEY = "2"

# ── SiliconFlow（可选 AI 增强）──
SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions"
AI_MODEL = "deepseek-ai/DeepSeek-V3.2"
DEEPSEEK_MODEL = "deepseek-ai/DeepSeek-V3.2"

# ── Key 一览：配置项名 → 环境变量名（顺序与源码 configure_music_providers 一致）──
PROVIDER_ENV_KEYS: Dict[str, str] = {
    "siliconflow_api_key": "SILICONFLOW_API_KEY",
    "acoustid_api_key": "ACOUSTID_API_KEY",
    "spotify_client_id": "SPOTIFY_CLIENT_ID",
    "spotify_client_secret": "SPOTIFY_CLIENT_SECRET",
    "genius_access_token": "GENIUS_ACCESS_TOKEN",
    "discogs_token": "DISCOGS_TOKEN",
}

# ── 数据源 → 需要的 Key（空元组 = 无需 Key）──
SOURCE_CREDENTIALS: Dict[str, tuple] = {
    "Netease": (),
    "QQMusic": (),
    "Kugou": (),
    "Kuwo": (),
    "MusicBrainz": (),
    "CoverArtArchive": (),
    "iTunes": (),
    "iTunes_US": (),
    "iTunes_CN": (),
    "iTunes_TW": (),
    "iTunes_HK": (),
    "Deezer": (),
    "Last.fm": (),
    "TheAudioDB": (),
    "YouTubeMusic": (),
    "LRCLIB": (),
    # 需要 Key 的源
    "Spotify": ("spotify_client_id", "spotify_client_secret"),
    "Genius": ("genius_access_token",),
    "Discogs": ("discogs_token",),
    "AcoustID": ("acoustid_api_key",),
    "SiliconFlow": ("siliconflow_api_key",),
}

# 无需 Key 的源（用于文档与自检）
KEYLESS_SOURCES = tuple(
    name for name, keys in SOURCE_CREDENTIALS.items() if not keys
)

_LOCK = threading.RLock()
_CREDENTIALS: Dict[str, str] = {}


def load_setting(key: str, env_key: str = "") -> str:
    """读取一个配置项：环境变量优先，其次持久化配置文件。

    :param key: 配置文件里的键名，例如 ``'spotify_client_id'``
    :param env_key: 对应的环境变量名，例如 ``'SPOTIFY_CLIENT_ID'``；留空则只读文件
    :return: 配置值（字符串），未配置时返回 ``''``
    """
    env_value = os.environ.get(env_key, "").strip() if env_key else ""
    if env_value:
        return env_value
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as fh:
                value = json.load(fh).get(key, "")
            return str(value).strip()
    except Exception:  # 配置文件损坏/无权限 → 视作未配置
        LOGGER.debug("读取配置项 %s 失败，按未配置处理", key, exc_info=True)
    return ""


def load_api_key() -> str:
    """读取 SiliconFlow API Key（源码 ``_load_api_key`` 的等价实现）。"""
    return load_setting("siliconflow_api_key", "SILICONFLOW_API_KEY")


def persisted_path(key: str, fallback: str = "") -> str:
    """从持久化配置读取路径，无记录时返回 ``fallback``（源码 ``_persisted_path``）。"""
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as fh:
                value = json.load(fh).get(key, "")
            if value:
                return value
    except Exception:
        pass
    return fallback


def _bootstrap() -> None:
    """进程启动时把已知的 Key 读进内存（等价于源码模块级赋值）。"""
    with _LOCK:
        for key, env_key in PROVIDER_ENV_KEYS.items():
            _CREDENTIALS[key] = load_setting(key, env_key)


_bootstrap()


def get_credential(key: str, default: str = "") -> str:
    """取一个 Key：内存值（含运行时注入）→ 环境变量 → 配置文件。

    :param key: 配置项名，例如 ``'genius_access_token'``
    :param default: 全部缺失时的返回
    """
    with _LOCK:
        value = _CREDENTIALS.get(key)
    if value:
        return value
    env_key = PROVIDER_ENV_KEYS.get(key, "")
    if env_key:
        env_value = os.environ.get(env_key, "").strip()
        if env_value:
            return env_value
    return load_setting(key) or default


def set_credential(key: str, value: str) -> None:
    """运行时注入一个 Key（不落盘）。"""
    with _LOCK:
        _CREDENTIALS[str(key)] = str(value or "").strip()


def configure_music_providers(values: Optional[Mapping[str, Any]] = None) -> Dict[str, bool]:
    """批量注入数据源凭据，返回「哪些 Key 当前可用」。

    与源码 ``configure_music_providers`` 语义一致，但**默认不写磁盘**
    （库不该改用户的家目录配置），需要落盘请显式 ``persist=True``。

    :param values: 例 ``{'spotify_client_id': '..', 'genius_access_token': '..'}``
    :param persist: 预留参数位；本实现只在内存生效（见 PORT_NOTES）
    """
    values = dict(values or {})
    with _LOCK:
        for key in PROVIDER_ENV_KEYS:
            value = str(values.get(key, "") or "").strip()
            if value:
                _CREDENTIALS[key] = value
            elif not _CREDENTIALS.get(key):
                _CREDENTIALS[key] = load_setting(key, PROVIDER_ENV_KEYS[key])
        return _available_flags_locked()


def _available_flags_locked() -> Dict[str, bool]:
    return {
        "siliconflow": bool(_CREDENTIALS.get("siliconflow_api_key")),
        "acoustid": bool(_CREDENTIALS.get("acoustid_api_key")),
        "spotify": bool(_CREDENTIALS.get("spotify_client_id"))
        and bool(_CREDENTIALS.get("spotify_client_secret")),
        "genius": bool(_CREDENTIALS.get("genius_access_token")),
        "discogs": bool(_CREDENTIALS.get("discogs_token")),
    }


def provider_status() -> Dict[str, bool]:
    """每个「需要 Key 的源」当前是否已配置（与源码 main.py 的判定一致）。"""
    flags = _available_flags_locked()
    return {
        "siliconflow": flags["siliconflow"],
        "acoustid": flags["acoustid"],
        "spotify": flags["spotify"],
        "genius": flags["genius"],
        "discogs": flags["discogs"],
    }


def source_available(source: str) -> bool:
    """该数据源现在能不能用（4 个国内源 + MusicBrainz/iTunes/Deezer 等恒定 True）。

    :param source: 源名，见 :data:`SOURCE_CREDENTIALS` 的键
    """
    required = SOURCE_CREDENTIALS.get(source)
    if required is None:
        return False
    return all(bool(get_credential(key)) for key in required)


def source_skip_reason(source: str) -> str:
    """源被跳过时的可读原因（可用时返回 ``''``）。"""
    required = SOURCE_CREDENTIALS.get(source)
    if required is None:
        return f"未知数据源：{source}"
    missing = [key for key in required if not get_credential(key)]
    if not missing:
        return ""
    env_names = ", ".join(PROVIDER_ENV_KEYS.get(key, key.upper()) for key in missing)
    return f"{source} 需要 API Key（{env_names}），未配置 → 已跳过"


def active_sources() -> list:
    """当前可用源名清单（等价于源码启动日志里的「🌐 数据源」列表）。"""
    return [name for name in SOURCE_CREDENTIALS if source_available(name)]
