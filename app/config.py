"""运行时配置：目录、可选 API key、默认整理模板。

优先级：数据库中的用户设置（UI 可改） > 环境变量 > 内置默认值。
API key 一律可选，缺失时对应数据源自动跳过。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# 支持的音频格式（与标签读写核心保持一致）
SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus"}

# 默认整理模板：目录层级 + 文件名
DEFAULT_DIR_TEMPLATE = "{language}/{artist}/{album}"
DEFAULT_FILENAME_TEMPLATE = "{track:02} - {title}"

# 默认冲突策略
DEFAULT_CONFLICT_POLICY = "rename"  # rename | skip | overwrite

# 空字段回退文案
DEFAULT_UNKNOWN_ARTIST = "未知艺术家"
DEFAULT_UNKNOWN_ALBUM = "未知专辑"
DEFAULT_UNKNOWN_OTHER = "未知"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or "").strip() or default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    """进程级配置（不可变部分）。用户可改的设置存在数据库里。"""

    music_dir: Path
    library_root: Path
    data_dir: Path
    host: str = "0.0.0.0"
    port: int = 8080
    scan_workers: int = 4
    # 可选密钥
    spotify_client_id: str = ""
    spotify_client_secret: str = ""
    genius_token: str = ""
    discogs_token: str = ""
    acoustid_key: str = ""
    siliconflow_key: str = ""
    siliconflow_model: str = "Qwen/Qwen2.5-7B-Instruct"
    # 行为开关
    trust_env_proxy: bool = False
    debug: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "metatidy.db"

    @property
    def cover_cache_dir(self) -> Path:
        return self.data_dir / "covers"

    @property
    def thumb_cache_dir(self) -> Path:
        return self.data_dir / "thumbs"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.cover_cache_dir, self.thumb_cache_dir):
            p.mkdir(parents=True, exist_ok=True)

    def api_keys(self) -> dict:
        """返回给刮削层的密钥字典（空值代表未配置）。"""
        return {
            "spotify_client_id": self.spotify_client_id,
            "spotify_client_secret": self.spotify_client_secret,
            "genius_token": self.genius_token,
            "discogs_token": self.discogs_token,
            "acoustid_key": self.acoustid_key,
            "siliconflow_key": self.siliconflow_key,
            "siliconflow_model": self.siliconflow_model,
        }


def load_settings() -> Settings:
    music_dir = Path(_env("METATIDY_MUSIC_DIR", "/music")).expanduser()
    library_root = Path(_env("METATIDY_LIBRARY_ROOT", str(music_dir))).expanduser()
    data_dir = Path(_env("METATIDY_DATA_DIR", "/data")).expanduser()
    return Settings(
        music_dir=music_dir,
        library_root=library_root,
        data_dir=data_dir,
        host=_env("METATIDY_HOST", "0.0.0.0"),
        port=int(_env("METATIDY_PORT", "8080")),
        scan_workers=max(1, int(_env("METATIDY_SCAN_WORKERS", "4"))),
        spotify_client_id=_env("SPOTIFY_CLIENT_ID"),
        spotify_client_secret=_env("SPOTIFY_CLIENT_SECRET"),
        genius_token=_env("GENIUS_TOKEN"),
        discogs_token=_env("DISCOGS_TOKEN"),
        acoustid_key=_env("ACOUSTID_KEY"),
        siliconflow_key=_env("SILICONFLOW_KEY"),
        siliconflow_model=_env("SILICONFLOW_MODEL", "Qwen/Qwen2.5-7B-Instruct"),
        trust_env_proxy=_env_bool("METATIDY_TRUST_ENV_PROXY", False),
        debug=_env_bool("METATIDY_DEBUG", False),
    )


# 用户可在 UI 中修改的设置项（存 SQLite settings 表）
USER_SETTING_DEFAULTS: dict[str, object] = {
    "dir_template": DEFAULT_DIR_TEMPLATE,
    "filename_template": DEFAULT_FILENAME_TEMPLATE,
    "conflict_policy": DEFAULT_CONFLICT_POLICY,
    "unknown_artist": DEFAULT_UNKNOWN_ARTIST,
    "unknown_album": DEFAULT_UNKNOWN_ALBUM,
    "unknown_other": DEFAULT_UNKNOWN_OTHER,
    "normalize_artist_ampersand": True,
    "enabled_sources": [
        "netease",
        "qq",
        "kugou",
        "kuwo",
        "musicbrainz",
        "itunes",
        "deezer",
    ],
    "write_cover": True,
    "write_lyrics": True,
    "overwrite_existing": True,
}

# 模板可用占位符（UI 用于提示；渲染逻辑见 app/templates.py）
TEMPLATE_PLACEHOLDERS: list[dict[str, str]] = [
    {"key": "artist", "desc": "歌手（多歌手已用 & 连接）"},
    {"key": "albumartist", "desc": "专辑艺术家"},
    {"key": "album", "desc": "专辑名"},
    {"key": "title", "desc": "歌曲名"},
    {"key": "track", "desc": "音轨号，可补零：{track:02}"},
    {"key": "disc", "desc": "碟号，可补零：{disc:02}"},
    {"key": "year", "desc": "年份，可截取：{year:4}"},
    {"key": "genre", "desc": "流派"},
    {"key": "language", "desc": "语言（中文/英文/日文…）"},
    {"key": "albumtype", "desc": "专辑类型（专辑/单曲/合辑…）"},
    {"key": "mb_artist_id", "desc": "MusicBrainz 歌手 ID"},
    {"key": "release_group_id", "desc": "MusicBrainz 发行组 ID"},
    {"key": "ext", "desc": "原扩展名（不含点）"},
    {"key": "original", "desc": "原文件名（不含扩展名）"},
]
