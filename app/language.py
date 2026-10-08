"""从路径推断语言（离线、零成本、无网络）。

背景：用户的音乐库通常**已经按语言分好目录**，例如
    G:\\...\\【Music】\\俄文\\ADÉLA\\PRIMA\\KGB - ADÉLA.flac
但音频标签里的 `language` 字段经常是空的。如果不兜底，按 `{language}` 模板整理时
就会把整棵语言目录压平——这是不可接受的破坏。

规则：取「库根目录下的第一层目录名」，只有它命中已知语言名（或形如 `XX文`）才采用。
拿不准就返回空串，让模板的可选段 `{language?}` 把它整段丢掉。
"""

from __future__ import annotations

import re
from pathlib import Path

# 明确认可的语言目录名（与旧项目语言判定链的取值集合一致，另补充常见语种）
KNOWN_LANGUAGES: set[str] = {
    "中文", "国语", "华语", "粤语", "英文", "英语", "日文", "日语", "韩文", "韩语",
    "泰文", "俄文", "俄语", "法文", "法语", "德文", "德语", "西文", "西班牙文", "西班牙语",
    "意文", "意大利文", "意大利语", "越南文", "越语", "尼泊尔文", "土耳其文", "葡萄牙文",
    "葡文", "阿拉伯文", "印地文", "印度文", "印尼文", "马来文", "菲律宾文", "波兰文",
    "荷兰文", "瑞典文", "挪威文", "丹麦文", "芬兰文", "冰岛文", "希腊文", "希伯来文",
    "波斯文", "乌克兰文", "捷克文", "斯洛伐克文", "匈牙利文", "罗马尼亚文", "保加利亚文",
    "塞尔维亚文", "克罗地亚文", "斯洛文尼亚文", "立陶宛文", "拉脱维亚文", "爱沙尼亚文",
    "爱尔兰文", "威尔士文", "加泰罗尼亚文", "拉丁文", "世界语", "蒙古文", "藏文",
    "维吾尔文", "哈萨克文", "孟加拉文", "泰米尔文", "乌尔都文", "僧伽罗文", "缅甸文",
    "高棉文", "老挝文", "阿姆哈拉文", "斯瓦希里文", "祖鲁文", "南非荷兰文", "纯音乐",
    "instrumental", "chinese", "english", "japanese", "korean",
}

# 兜底：形如「俄文」「土耳其文」的目录名（1-5 个汉字 + 文）
_GENERIC = re.compile(r"^[\u4e00-\u9fff]{1,5}文$")

# 同义目录名归一：只处理「同一概念两种常见写法」，其余原样返回（保证不擅自改用户目录名）
_ALIASES = {
    "国语": "中文",
    "华语": "中文",
    "英语": "英文",
    "日语": "日文",
    "韩语": "韩文",
}


def infer_language(path: str | Path, root: str | Path) -> str:
    """按「库根下第一层目录名」推断语言；拿不准返回空串。"""
    try:
        file_path = Path(path)
        root_path = Path(root)
        rel = file_path.relative_to(root_path)
    except (ValueError, OSError):
        return ""
    parts = rel.parts[:-1]  # 去掉文件名
    if not parts:
        return ""
    first = parts[0].strip()
    if first in _ALIASES:
        return _ALIASES[first]
    if first in KNOWN_LANGUAGES:
        return first
    if _GENERIC.match(first):
        return first
    return ""
    return ""
