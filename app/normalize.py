"""多歌手归一化：统一用 ` & ` 连接。

规则来自旧项目的第一条需求（原话）：
    「歌手之间用 & 连接啊，然后不仅作用到文件名，还要作用到标签里」

因此同一个函数同时服务于：标签字段（artist / albumartist）、模板渲染（目录与文件名）。
拆分规则：
- 显式分隔符：`/ 、 ， , ; ； & ＆ feat. ft. featuring with`（大小写不敏感）
- 空格拆分**仅在同书写体系相邻时**生效：CJK↔CJK、CJK↔拉丁 才拆，
  这样 "Jay Chou" 不会被拆成两个人，而 "周杰伦 五月天" 会。
- feature 参与者保留，主歌手排在第一。
"""

from __future__ import annotations

import re

_SEPARATORS = re.compile(
    r"\s*(?:"
    r"/|、|，|,|;|；|&|＆"
    r"|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b"
    r")\s*",
    re.IGNORECASE,
)

_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]")


def has_cjk(text: str) -> bool:
    return bool(_CJK.search(text or ""))


def _split_on_spaces(part: str) -> list[str]:
    """空格拆分：只要相邻两侧有一侧含 CJK 就拆。"""
    tokens = [t for t in part.split() if t]
    if len(tokens) <= 1:
        return tokens
    groups: list[str] = [tokens[0]]
    for prev, cur in zip(tokens, tokens[1:]):
        if has_cjk(prev) or has_cjk(cur):
            groups.append(cur)
        else:
            groups[-1] = f"{groups[-1]} {cur}"
    return groups


def normalize_artist_credit(name: str) -> str:
    """把任意写法归一成 `A & B & C`。空输入返回空串。"""
    text = (name or "").strip()
    if not text:
        return ""
    parts: list[str] = []
    for chunk in _SEPARATORS.split(text):
        chunk = (chunk or "").strip()
        if not chunk:
            continue
        parts.extend(_split_on_spaces(chunk))

    seen: set[str] = set()
    ordered: list[str] = []
    for part in parts:
        part = part.strip(" .-&、，,")
        if not part:
            continue
        key = part.casefold()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(part)
    return " & ".join(ordered)


def normalize_filename_artist_credit(filename_stem: str) -> str:
    """按旧项目规则重组 `标题 - 歌手` 文件名：仅当恰好一个 " - " 时才重建。"""
    text = (filename_stem or "").strip()
    if text.count(" - ") != 1:
        return text
    title, artist = text.split(" - ", 1)
    normalized = normalize_artist_credit(artist)
    if not normalized:
        return text
    return f"{title.strip()} - {normalized}"


def try_core_normalizer():
    """如果迁移层提供了归一化函数，优先用它（保持与旧项目完全一致）。"""
    try:
        from metatidy_core import normalize as core  # type: ignore

        func = getattr(core, "normalize_artist_credit", None)
        if callable(func):
            return func
    except Exception:  # noqa: BLE001
        pass
    return normalize_artist_credit


def artist_normalizer():
    """给模板/写入层用的归一化函数（沿迁移层优先）。"""
    return try_core_normalizer()
