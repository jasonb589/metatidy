"""目录层级模板引擎（功能 3 的核心）。

模板语法
--------
- 占位符：`{artist}` `{album}` `{title}` `{track}` `{year}` `{language}` …
- 补零/截断：`{track:02}` → `03`；`{year:4}` → `2009`
- 目录层级用 `/` 分隔，例如 `{language}/{artist}/{album}`
- 文件名模板单独配置，例如 `{track:02} - {title}`
- 可选段：任意占位符都能写成 `{字段?}`，取不到值时**整段丢弃**

空值规则（重要）
--------
- **有回退文案的字段**（artist / albumartist / album / title / genre）为空时用回退值
  （默认「未知艺术家 / 未知专辑 / 未知」），保证文件不会散落在库根目录。
- **没有回退的字段**（language / albumtype / year / track / disc / mb_artist_id…）为空时，
  该段**整段丢弃**，不会产出 `未知` 空目录。

安全规则
--------
- 每段都过 `sanitize_filename`（把 `\\ / * ? : " < > |` 换成 `_`），并去掉首尾空白和结尾的点
- Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）自动加前缀 `_`
- 单段长度上限 120 字符，整路径过长的会在计划里给出警告
"""

from __future__ import annotations

import re
from pathlib import Path

TOKEN_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::(\d+))?(\?)?\}")

_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

MAX_SEGMENT_LEN = 120

# 归一化中文全角斜杠等，避免模板里写错分隔符
_SEPARATOR_NORMALIZE = str.maketrans({"/": "/", "\\": "/", "／": "/", "＼": "/"})


def sanitize_filename(name: str) -> str:
    """把一段路径名清理成合法文件名（与旧项目行为一致，另补充 Windows 保留名处理）。"""
    cleaned = re.sub(r'[\\/*?:"<>|]', "_", str(name or ""))
    cleaned = cleaned.replace("\x00", "").strip()
    cleaned = cleaned.rstrip(". ")  # Windows 不允许结尾的点和空格
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        return "Unknown"
    if cleaned.split(".")[0].upper() in _WINDOWS_RESERVED:
        cleaned = "_" + cleaned
    if len(cleaned) > MAX_SEGMENT_LEN:
        cleaned = cleaned[:MAX_SEGMENT_LEN].rstrip(". ")
    return cleaned


def _leading_number(value: str) -> str:
    """从 `3/12`、`03`、`3` 这类音轨/碟号里取出数字部分。"""
    m = re.match(r"\s*(\d+)", str(value or ""))
    return m.group(1) if m else ""


def build_values(track: dict, *, unknown_artist: str, unknown_album: str, unknown_other: str,
                 artist_normalizer=None) -> dict[str, str]:
    """把一条曲目记录转成模板可用的取值字典。"""
    def g(key: str) -> str:
        return str(track.get(key) or "").strip()

    artist = g("artist")
    albumartist = g("albumartist") or artist
    album = g("album")
    title = g("title")

    if artist_normalizer and artist:
        artist = artist_normalizer(artist)
    if artist_normalizer and albumartist:
        albumartist = artist_normalizer(albumartist)

    raw_title = g("title")
    original = Path(g("filename") or g("path")).stem or raw_title

    return {
        # 文本字段：空则回退（用 {x?} 可整段丢弃）
        "artist": artist or unknown_artist,
        "albumartist": albumartist or unknown_artist,
        "album": album or unknown_album,
        "title": title or g("filename") or unknown_other,
        "genre": g("genre") or unknown_other,
        "language": g("language"),
        "albumtype": g("albumtype"),
        "mb_artist_id": g("mb_artist_id"),
        "release_group_id": g("release_group_id"),
        "ext": g("ext").lstrip("."),
        "original": original,
        # 数字字段
        "track": _leading_number(g("track")),
        "disc": _leading_number(g("disc")),
        "year": _leading_number(g("year")),
    }


def render_segment(template: str, values: dict[str, str]) -> tuple[str, bool]:
    """渲染单个路径段。返回 (文本, 是否应丢弃该段)。

    丢弃条件：模板里出现过的可选占位符 `{x?}` 全部为空，且去除它们之后段内没有其它实义字符。
    """
    optional_seen = False
    optional_nonempty = False
    literal_rest = template

    def _sub(m: re.Match) -> str:
        nonlocal optional_seen, optional_nonempty, literal_rest
        name, width, optional = m.group(1), m.group(2), m.group(3)
        raw = values.get(name, "")
        text = raw
        if width and text:
            width_i = int(width)
            text = text.zfill(width_i) if text.isdigit() else text[:width_i]
        if optional:
            optional_seen = True
            if text:
                optional_nonempty = True
            literal_rest = literal_rest.replace(m.group(0), "")
        return text

    rendered = TOKEN_RE.sub(_sub, template)
    if optional_seen and not optional_nonempty:
        leftover = TOKEN_RE.sub("", literal_rest)
        leftover = re.sub(r"[\s\-_.]+", "", leftover)
        if not leftover:
            return "", True
    return rendered, False


def split_segments(template: str) -> list[str]:
    """把模板切成路径段，兼容 `/`、`\\` 和全角斜杠。"""
    return [s for s in str(template or "").translate(_SEPARATOR_NORMALIZE).split("/")]


def render_relative_dir(template: str, values: dict[str, str]) -> str:
    """渲染目录层级（相对路径，不含文件名）。

    渲染结果为空的段一律丢弃；不会产出 `Unknown` / `未知` 空目录。
    """
    parts: list[str] = []
    for seg in split_segments(template):
        if not seg.strip():
            continue
        text, drop = render_segment(seg, values)
        if drop or not text.strip():
            continue
        cleaned = sanitize_filename(text)
        if cleaned == "Unknown" and not text.strip(" .-_"):
            continue
        parts.append(cleaned)
    return "/".join(parts)


def render_filename(template: str, values: dict[str, str], ext: str | None = None) -> str:
    """渲染文件名（含扩展名）。"""
    text, _ = render_segment(template or "{title}", values)
    stem = sanitize_filename(text)
    if stem == "Unknown" and not (text or "").strip():
        stem = sanitize_filename(values.get("title") or values.get("original") or "Unknown")
    suffix = (ext or values.get("ext") or "").lstrip(".")
    return f"{stem}.{suffix}" if suffix else stem


def target_path(track: dict, library_root: Path | str, dir_template: str, filename_template: str,
                *, unknown_artist: str = "未知艺术家", unknown_album: str = "未知专辑",
                unknown_other: str = "未知", artist_normalizer=None) -> Path:
    """算出这条曲目按模板应有的完整目标路径。"""
    values = build_values(
        track,
        unknown_artist=unknown_artist,
        unknown_album=unknown_album,
        unknown_other=unknown_other,
        artist_normalizer=artist_normalizer,
    )
    rel_dir = render_relative_dir(dir_template, values)
    filename = render_filename(filename_template, values, track.get("ext"))
    root = Path(library_root)
    return (root / rel_dir / filename) if rel_dir else (root / filename)


def validate_template(template: str, known_keys: set[str]) -> list[str]:
    """检查模板里的未知占位符，返回警告列表（不抛异常）。"""
    warnings: list[str] = []
    if not str(template or "").strip():
        warnings.append("模板为空")
    for m in TOKEN_RE.finditer(str(template or "")):
        name = m.group(1)
        if name not in known_keys:
            warnings.append(f"未知占位符 {{{name}}} —— 将被替换为空")
    if template and ".." in str(template).split("/"):
        warnings.append("模板包含 .. 段，已被安全过滤")
    return warnings


def path_length_warning(path: Path) -> str | None:
    """Windows 下超过 260 字符的路径需要长路径支持，提前给警告。"""
    if len(str(path)) > 255:
        return "路径过长（>255 字符），Windows 下可能失败"
    return None
