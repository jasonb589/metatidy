"""名称归一化 / 文件名解析 / 字符串与语种工具（纯逻辑，无 GUI 依赖）。

迁移自 ``media_toolkit.py`` 的「音频元数据 - 核心工具函数」区块，逐函数对照搬迁：

* 多歌手署名归一：:func:`normalize_artist_credit`（分隔符集合与空格拆分规则完全照抄）
* 文件名解析：:func:`parse_filename_smart` / :func:`neuro_parse_filename`
* 模糊匹配：:func:`is_fuzzy_match`（``thefuzz`` 缺失时自动降级）
* 语种判定链：MusicBrainz 歌手国家 → :data:`ARTIST_NATIONALITY_DB` → AI → 歌名/流派规则
* 发行类型 / 专辑版本尾巴 / 候选上下文分类等评分前置工具

本模块只用 ``requests`` / ``zhconv``（可选 ``thefuzz``、``langid``）；不导入任何 GUI 库。
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests

from . import config

LOGGER = logging.getLogger(__name__)

try:  # 简繁转换：源码把 zhconv 当强依赖，这里降级为可选
    import zhconv as _zhconv

    HAS_ZHCONV = True
except ImportError:  # pragma: no cover - 环境缺库时
    _zhconv = None
    HAS_ZHCONV = False

try:  # 可选：源码里 thefuzz 缺失时会走降级分支
    from thefuzz import fuzz as _fuzz

    HAS_FUZZ = True
except ImportError:  # pragma: no cover
    _fuzz = None
    HAS_FUZZ = False

try:  # 可选：源码用它做语言识别，缺失时退回脚本判定
    import langid as _langid
except ImportError:  # pragma: no cover
    _langid = None


__all__ = [
    "HAS_ZHCONV",
    "HAS_FUZZ",
    "ARTIST_NATIONALITY_DB",
    "COUNTRY_CODE_TO_LANG",
    "ARTIST_LANG_CACHE",
    "GENRE_TAXONOMY",
    "RAW_GENRE_TRANSLATE",
    "PLAIN_ALBUM_NAMES",
    "LANGUAGES",
    "simple_convert",
    "is_chinese_text",
    "detect_language",
    "detect_language_smart",
    "detect_language_from_lyrics",
    "country_code_to_language",
    "artist_nationality_language",
    "resolve_music_language",
    "ai_predict_language",
    "ai_prompt",
    "ai_render",
    "call_siliconflow",
    "normalize_artist_credit",
    "normalize_music_filename_artist_credit",
    "normalize_artist_display",
    "sanitize_filename",
    "clean_album_name",
    "normalize_album_type",
    "album_type_standard_value",
    "infer_album_type",
    "translate_raw_genre",
    "parse_filename_smart",
    "neuro_parse_filename",
    "is_fuzzy_match",
    "is_track_title_match",
    "classify_album_context",
    "filter_album_context",
    "strip_edition_suffix",
    "configure_album_naming",
    "get_audio_duration_hint",
    "get_search_info",
    "get_search_info_variants",
    "artist_folder_key",
    "apply_artist_name_alias",
    "apply_album_name_alias",
    "merge_artist_name_aliases",
    "merge_album_name_aliases",
]

# 源码语种标签的取值范围（AI 返回值会逐一校验）
LANGUAGES = ("中文", "英文", "日文", "韩文", "泰文", "俄文", "法文", "德文", "西文", "意文", "越文", "纯音乐")


# ==================== 🎵 流派 / 语言相关常量（照抄源码） ====================

GENRE_TAXONOMY = {
    "流行美学": ["流行·前卫 (Art Pop)", "流行·深情 (Ballad)", "流行·复古 (Retro Pop)", "华语·经典 (Mandopop)", "粤语·风华 (Cantopop)", "韩流·悸动 (K-Pop)", "日系·元气 (J-Pop)"],
    "都市律动": ["都市·霓虹 (City Pop)", "R&B·丝滑 (Smooth R&B)", "灵魂·慵懒 (Neo-Soul)", "嘻哈·街头 (Street Hip-Hop)", "嘻哈·旋律 (Melodic Rap)", "陷阱·迷幻 (Trap)"],
    "独立精神": ["独立·微醺 (Indie Pop)", "独立·日系 (J-Indie)", "民谣·故事 (Folk Tale)", "原声·纯粹 (Acoustic)", "另类·独白 (Alternative)"],
    "虚幻梦境": ["梦幻·自赏 (Shoegaze)", "梦幻·空灵 (Dream Pop)", "迷幻·药味 (Psychedelic)", "低保真·卧室 (Lo-Fi)", "氛围·沉浸 (Ambient)"],
    "摇滚灵魂": ["摇滚·热血 (Classic Rock)", "英伦·忧郁 (Britpop)", "后摇·史诗 (Post-Rock)", "朋克·叛逆 (Punk)", "金属·狂潮 (Metal)", "工业·噪音 (Industrial)"],
    "电子脉冲": ["电子·浩室 (Deep House)", "赛博·合成器 (Synthwave)", "蒸汽·波 (Vaporwave)", "故障·艺术 (Glitchcore)", "舞曲·狂欢 (Club/EDM)"],
    "特定美学": ["古风·江湖 (Gufeng)", "二次元·羁绊 (ACG)", "爵士·醇酒 (Jazz)", "光影·原声 (Cinematic/OST)", "古典·永恒 (Classical)"],
}

RAW_GENRE_TRANSLATE = {
    '韩国流行乐': '韩流·悸动', 'K-Pop': '韩流·悸动', 'Kpop': '韩流·悸动', 'Korean Pop': '韩流·悸动',
    '日本流行乐': '日系·元气', 'J-Pop': '日系·元气', 'Jpop': '日系·元气', 'Japanese Pop': '日系·元气',
    '华语流行': '华语·经典', 'C-Pop': '华语·流行', 'Cantopop': '粤语·风华', 'Mandopop': '华语·经典',
    '嘻哈/说唱': '嘻哈·街头', 'Hip-Hop/Rap': '嘻哈·街头', 'Rap': '嘻哈·街头', 'Hip Hop': '嘻哈·街头',
    'R&B/Soul': 'R&B·丝滑', 'R&B/索尔': 'R&B·丝滑', '节奏布鲁斯': 'R&B·丝滑',
    'Soundtrack': '影视·原声', 'Original Soundtrack': '影视·原声', 'TV Soundtrack': '剧集·原声', 'Movie Soundtrack': '光影·原声',
    'Score': '配乐·史诗', 'OST': '影视·原声', '原声带': '影视·原声',
    'Anime': '二次元·羁绊', 'Animation': '二次元·羁绊', 'Game': '游戏·史诗', 'Video Game': '游戏·史诗',
    'Rock': '摇滚·热血', 'Alternative': '另类·独白', 'Alternative Rock': '另类·摇滚', 'Indie': '独立·微醺', 'Indie Rock': '独立·躁动', 'Indie Pop': '独立·微醺',
    'Punk': '朋克·叛逆', 'Post-Punk': '后朋·阴郁', 'Heavy Metal': '金属·狂潮', 'Metal': '金属·狂潮',
    'Electronic': '电子·脉冲', 'Electronica': '电子·实验', 'Dance': '舞曲·狂欢', 'Club': '舞曲·夜店', 'House': '浩室·深邃',
    'Deep House': '浩室·深邃', 'Techno': '工业·科技', 'Trance': '出神·迷离', 'Dubstep': '低音·轰炸', 'EDM': '电音·狂潮', 'Disco': '迪斯科·复古',
    'Synthwave': '赛博·霓虹', 'Vaporwave': '蒸汽·波',
    'Folk': '民谣·故事', 'Country': '乡村·公路', 'Acoustic': '原声·纯粹', 'Jazz': '爵士·醇酒', 'Blues': '蓝调·忧愁', 'Vocal': '人声·天籁',
    'Singer/Songwriter': '唱作·独白', 'Ballad': '流行·深情', 'Dream Pop': '梦幻·空灵', 'Shoegaze': '梦幻·自赏',
    'Classical': '古典·永恒', 'Instrumental': '纯音·意境', 'New Age': '新世纪·灵性', 'World': '世界·风情',
    'Children\'s Music': '儿歌·纯真', 'Holiday': '节日·庆典', 'Gufeng': '古风·江湖', 'Zhongguo Feng': '中国风·雅韵',
    'Country Music': '乡村·公路', '乡村': '乡村·公路', '乡村乐': '乡村·公路',
    'Christmas': '节日·庆典', 'Xmas': '节日·庆典', 'Festive': '节日·庆典',
    '节庆': '节日·庆典', '原声配乐': '影视·原声', '电影原声': '光影·原声',
}

# 语言缓存：{artist: (language, timestamp)}  timestamp=0 为规则判定(永久)，>0 为 AI 判定(30min TTL)
ARTIST_LANG_CACHE: Dict[str, Any] = {}

# ── 歌手国籍知识库 — 规则判定（永久有效），键名统一小写匹配 ──
# 格式: '歌手名': ('语言标签', '国籍说明')
# 多语言歌手标记 'multi'，由 AI 按歌名进一步判断
ARTIST_NATIONALITY_DB: Dict[str, Tuple[str, str]] = {
    # ── 华语歌手 ──
    '周杰伦': ('中文', '中国台湾'), '林俊杰': ('中文', '新加坡'), '王力宏': ('中文', '美国华裔'),
    '陶喆': ('中文', '中国台湾'), '方大同': ('multi', '美国华裔'), '李玖哲': ('multi', '韩国华裔'),
    '陈奕迅': ('中文', '中国香港'), '张学友': ('中文', '中国香港'), '刘德华': ('中文', '中国香港'),
    '谢安琪': ('中文', '中国香港'), '容祖儿': ('中文', '中国香港'), 'twins': ('中文', '中国香港'),
    '邓紫棋': ('中文', '中国香港'), '张靓颖': ('中文', '中国大陆'), '李宇春': ('中文', '中国大陆'),
    '薛之谦': ('中文', '中国大陆'), '毛不易': ('中文', '中国大陆'), '华晨宇': ('中文', '中国大陆'),
    '张国荣': ('中文', '中国香港'), '谭咏麟': ('中文', '中国香港'), '黄家驹': ('中文', '中国香港'),
    '王菲': ('中文', '中国大陆'), '那英': ('中文', '中国大陆'), '刘欢': ('中文', '中国大陆'),
    '孙燕姿': ('中文', '新加坡'), '蔡依林': ('中文', '中国台湾'), '梁静茹': ('中文', '马来西亚'),
    '萧亚轩': ('中文', '中国台湾'), '张惠妹': ('multi', '中国台湾原住民'), '田馥甄': ('中文', '中国台湾'),
    '林宥嘉': ('中文', '中国台湾'), '吴青峰': ('中文', '中国台湾'), '苏打绿': ('中文', '中国台湾'),
    '罗大佑': ('中文', '中国台湾'), '李宗盛': ('中文', '中国台湾'), '五月天': ('中文', '中国台湾'),
    '任贤齐': ('中文', '中国台湾'), '张信哲': ('中文', '中国台湾'), '刘若英': ('中文', '中国台湾'),
    '光良': ('中文', '马来西亚'), '品冠': ('中文', '马来西亚'), '曹格': ('multi', '马来西亚华裔'),
    '汪峰': ('中文', '中国大陆'), '许巍': ('中文', '中国大陆'), '朴树': ('中文', '中国大陆'),
    '赵雷': ('中文', '中国大陆'), '陈粒': ('中文', '中国大陆'), '李志': ('中文', '中国大陆'),
    '万能青年旅店': ('中文', '中国大陆'), '新裤子': ('中文', '中国大陆'), '刺猬': ('中文', '中国大陆'),
    '草东没有派对': ('中文', '中国台湾'), 'Deca Joins': ('中文', '中国台湾'),
    '陈婧霏': ('中文', '中国大陆'),
    # ── 日本歌手 ──
    'yoasobi': ('日文', '日本'), 'ikura': ('日文', '日本'), 'milet': ('日文', '日本'),
    'aimer': ('日文', '日本'), 'lisa': ('multi', '日本'), 'ueno mikiyuki': ('日文', '日本'),
    'one ok rock': ('multi', '日本'), 'radwimps': ('日文', '日本'), 'yorushika': ('日文', '日本'),
    'yo Hitoto': ('日文', '日本'), '一青窈': ('日文', '日本'), '宇多田光': ('multi', '日本'),
    '滨崎步': ('日文', '日本'), '仓木麻衣': ('日文', '日本'), '中岛美嘉': ('日文', '日本'),
    '椎名林檎': ('日文', '日本'), '竹内玛莉亚': ('日文', '日本'), '山下达郎': ('日文', '日本'),
    '大瀧詠一': ('日文', '日本'), '久石让': ('纯音乐', '日本'), '坂本龙一': ('纯音乐', '日本'),
    'hyde': ('日文', '日本'), 'larc~en~ciel': ('日文', '日本'), 'x japan': ('日文', '日本'),
    'babymetal': ('日文', '日本'), 'perfume': ('日文', '日本'), 'kenshi yonezu': ('日文', '日本'),
    '米津玄师': ('日文', '日本'), 'back number': ('日文', '日本'), 'mrs.green apple': ('日文', '日本'),
    'official髭男dism': ('日文', '日本'), 'king gnu': ('日文', '日本'), '椎名亚树': ('日文', '日本'),
    'zutomayo': ('日文', '日本'), 'n-buna': ('日文', '日本'), 'yoru ni kakeru': ('日文', '日本'),
    # ── 韩国歌手 ──
    'bts': ('multi', '韩国'), 'blackpink': ('multi', '韩国'), 'twice': ('multi', '韩国'),
    'exo': ('multi', '韩国'), 'stray kids': ('multi', '韩国'), 'seventeen': ('multi', '韩国'),
    'red velvet': ('multi', '韩国'), 'bigbang': ('multi', '韩国'), 'iu': ('韩文', '韩国'),
    '태연': ('韩文', '韩国'), '아이유': ('韩文', '韩国'), '지코': ('韩文', '韩国'),
    '크러쉬': ('韩文', '韩国'), '헤이즈': ('韩文', '韩国'), '선미': ('韩文', '韩国'),
    '선미': ('韩文', '韩国'), '변현빈': ('韩文', '韩国'),
    # ── 泰国歌手 ──
    'lisa': ('multi', '泰国'), 'blackpink lisa': ('multi', '泰国'),
    # ── 欧美歌手 ──
    'adele': ('英文', '英国'), 'ed sheeran': ('英文', '英国'), 'taylor swift': ('英文', '美国'),
    'drake': ('英文', '加拿大'), 'the weeknd': ('英文', '加拿大'), 'justin bieber': ('英文', '加拿大'),
    'billie eilish': ('英文', '美国'), 'olivia rodrigo': ('英文', '美国'), 'dua lipa': ('英文', '英国'),
    'harry styles': ('英文', '英国'), 'post malone': ('英文', '美国'), 'bruno mars': ('英文', '美国'),
    'beyonce': ('英文', '美国'), 'rihanna': ('英文', '巴巴多斯'), 'eminem': ('英文', '美国'),
    'kendrick lamar': ('英文', '美国'), 'frank ocean': ('英文', '美国'), 'sia': ('英文', '澳大利亚'),
    'imagine dragons': ('英文', '美国'), 'coldplay': ('英文', '英国'), 'maroon 5': ('英文', '美国'),
    'one direction': ('英文', '英国'), 'linkin park': ('英文', '美国'), 'radiohead': ('英文', '英国'),
    'arctic monkeys': ('英文', '英国'), 'the 1975': ('英文', '英国'), 'lana del rey': ('英文', '美国'),
    'lorde': ('英文', '新西兰'), 'phoebe bridgers': ('英文', '美国'), 'taylor': ('英文', '美国'),
    # ── 经典欧美 ──
    'the beatles': ('英文', '英国'), 'queen': ('英文', '英国'), 'pink floyd': ('英文', '英国'),
    'led zeppelin': ('英文', '英国'), 'michael jackson': ('英文', '美国'), 'madonna': ('英文', '美国'),
    'elvis presley': ('英文', '美国'), 'bob dylan': ('英文', '美国'), 'david bowie': ('英文', '英国'),
    'prince': ('英文', '美国'), 'stevie wonder': ('英文', '美国'), 'whitney houston': ('英文', '美国'),
    'mariah carey': ('英文', '美国'), 'celine dion': ('multi', '加拿大'),
    # ── 纯音乐/古典 ──
    'ludovico einaudi': ('纯音乐', '意大利'), 'yiruma': ('纯音乐', '韩国'),
    'max richter': ('纯音乐', '英国'), 'nils frahm': ('纯音乐', '德国'),
    'ryuichi sakamoto': ('纯音乐', '日本'), 'joe hisaishi': ('纯音乐', '日本'),
    'hans zimmer': ('纯音乐', '德国'), 'john williams': ('纯音乐', '美国'),
    # ── 多语言歌手特殊标记 ──
    'soba': ('multi', '未知'), 'linkin park': ('英文', '美国'),
}

# ── ISO 国家码 → 语言映射（MusicBrainz artist.country 字段）──
COUNTRY_CODE_TO_LANG = {
    'CN': '中文', 'TW': '中文', 'HK': '中文', 'MO': '中文',
    'SG': '中文', 'MY': '中文',  # 新加坡/马来西亚华语歌手众多
    'JP': '日文', 'KR': '韩文', 'KP': '韩文',
    'TH': '泰文', 'VN': '越文',
    'RU': '俄文', 'BY': '俄文', 'KZ': '俄文',  # 俄语区
    'US': '英文', 'GB': '英文', 'CA': '英文', 'AU': '英文', 'NZ': '英文',
    'IE': '英文', 'ZA': '英文',  # 爱尔兰、南非也常唱英文
    'FR': '法文', 'BE': '法文', 'CH': '法文',
    'DE': '德文', 'AT': '德文',
    'ES': '西文', 'MX': '西文', 'AR': '西文', 'CO': '西文',
    'BR': '葡文', 'PT': '葡文',
    'IT': '意文',
}


def simple_convert(text):
    """简繁转换 → 简体（源码同名函数）。zhconv 缺失时原样返回。"""
    if not text:
        return text
    if HAS_ZHCONV:
        try:
            return _zhconv.convert(text, 'zh-cn')
        except Exception:
            return text
    return text


def is_chinese_text(text) -> bool:
    """文本里是否含汉字（源码同名函数，用于「中式候选」加权判定）。"""
    if not text:
        return False
    return bool(re.search(r'[\u4e00-\u9fff]', text))


def _lookup_nationality_db(artist):
    """在国籍知识库中查找歌手，返回 ``(语言, 国籍)`` 或 ``None``。"""
    if not artist:
        return None
    key = simple_convert(artist).strip().lower().replace(" ", "")
    # 直接匹配
    if key in ARTIST_NATIONALITY_DB:
        return ARTIST_NATIONALITY_DB[key]
    # 模糊匹配：数据库中的键是否是歌手名的子串
    for db_key, val in ARTIST_NATIONALITY_DB.items():
        if db_key in key or key in db_key:
            return val
    return None


def country_code_to_language(country_code):
    """将 ISO 国家码转换为语言标签，无法确定时返回 ``None``。"""
    if not country_code:
        return None
    code = country_code.strip().upper()
    if code in COUNTRY_CODE_TO_LANG:
        return COUNTRY_CODE_TO_LANG[code]
    # 两字母码无法确定 → 返回 None，交给 AI 判断
    return None


def artist_nationality_language(artist):
    """按内置国籍库给歌手语种；``multi`` 与未收录都返回 ``None``。"""
    result = _lookup_nationality_db(artist)
    if not result:
        return None
    language, _nationality = result
    return None if language == 'multi' else language


def detect_language(text):
    """用 langid 识别语言并映射到中文标签；不可用时返回 ``None``。

    :param text: 待识别文本（源码里用于歌名兜底）
    """
    if not text:
        return None
    if _langid is None:
        return None
    try:
        lang_code, _ = _langid.classify(text)
        lang_map = {'zh': '中文', 'en': '英文', 'ja': '日文', 'ko': '韩文', 'fr': '法文', 'es': '西文', 'de': '德文'}
        return lang_map.get(lang_code, '英文')
    except Exception:
        return '英文'  # 国际曲库默认英文比中文更合理


def detect_language_smart(artist, title, genre):
    """规则语种判定：脚本 → 流派关键词 → 歌名脚本 → langid。

    返回 :data:`LANGUAGES` 中的标签；纯音乐由流派关键词命中。
    """
    # ── 查缓存（兼容新旧格式）──
    if artist:
        cached = ARTIST_LANG_CACHE.get(artist)
        if cached is not None:
            if isinstance(cached, tuple):
                lang_val, ts = cached
                if ts == 0 or time.time() - ts < 1800:
                    return lang_val
            else:
                # 旧格式兼容：纯字符串
                return cached

    # ── 优先查国籍知识库 ──
    db_result = _lookup_nationality_db(artist)
    if db_result:
        lang_label, nationality = db_result
        if lang_label != 'multi':
            # 确定性语言 → 直接写入缓存（永久有效）
            if artist:
                ARTIST_LANG_CACHE[artist] = (lang_label, 0)
            return lang_label
        # multi → 继续走脚本/流派检测，歌名可能暗示语言

    def has_script(text, pattern):
        return bool(re.search(pattern, text)) if text else False

    HANGUL = r'[\uac00-\ud7af]'; KANA = r'[\u3040-\u30ff\u31f0-\u31ff]'; HANZI = r'[\u4e00-\u9fff]'; THAI = r'[\u0e00-\u0e7f]'; CYRILLIC = r'[\u0400-\u04ff]'
    if has_script(artist, THAI) or has_script(title, THAI):
        result = '泰文'
    elif has_script(artist, HANGUL):
        result = '韩文'
    elif has_script(artist, KANA):
        result = '日文'
    elif has_script(artist, CYRILLIC):
        result = '俄文'
    elif genre:
        g_lower = str(genre).lower()
        if any(x in g_lower for x in ['thai', 'th-pop', 't-pop']):
            result = '泰文'
        elif any(x in g_lower for x in ['k-pop', 'korea', '韩流', '韩系']):
            result = '韩文'
        elif any(x in g_lower for x in ['j-pop', 'japan', '日系', '二次元', 'anime']):
            result = '日文'
        elif any(x in g_lower for x in ['c-pop', 'mando', 'chinese', '华语', '粤语']):
            result = '中文'
        # ── 纯音乐 / 器乐检测 ──
        elif any(x in g_lower for x in ['instrumental', 'classical', 'orchestral',
                                        'piano', 'ambient', 'new age', 'score',
                                        '原声配乐', '配乐', '纯音乐', '器乐', '古典',
                                        'ost', 'soundtrack', 'bgm']):
            result = '纯音乐'
        else:
            result = None
    else:
        result = None

    if result is None:
        if has_script(title, HANGUL):
            result = '韩文'
        elif has_script(title, KANA):
            result = '日文'
        elif has_script(title, HANZI) or has_script(artist, HANZI):
            result = '中文'
        else:
            result = detect_language(title)
            if result is None:
                result = '英文'  # 无 langid 时的降级：国际曲库默认英文（见 PORT_NOTES）

    # ── 写入缓存（规则判定，永久有效）──
    if artist:
        ARTIST_LANG_CACHE[artist] = (result, 0)
    return result


def detect_language_from_lyrics(lrc_text):
    """看歌词正文用的哪国文字（**不参与语种判定**，仅用于排查/日志）。"""
    if not lrc_text:
        return None
    body = re.sub(r'\[[^\]]*\]', ' ', str(lrc_text))
    body = re.sub(r'<[^>]*>', ' ', body)
    body = re.sub(r'\s+', ' ', body).strip()
    if len(body) < 4:
        return None

    thai = len(re.findall(r'[\u0e00-\u0e7f]', body))
    hangul = len(re.findall(r'[\uac00-\ud7af]', body))
    kana = len(re.findall(r'[\u3040-\u30ff\u31f0-\u31ff]', body))
    cyrillic = len(re.findall(r'[\u0400-\u04ff]', body))
    hanzi = len(re.findall(r'[\u4e00-\u9fff]', body))
    latin = len(re.findall(r'[A-Za-zÀ-ÖØ-öø-ÿ]', body))
    counts = {
        '泰文': thai,
        '韩文': hangul,
        '日文': kana,
        '俄文': cyrillic,
        '中文': hanzi,
        '英文': latin,
    }
    best_label, best_count = max(counts.items(), key=lambda item: item[1])
    if best_count < 4:
        return None
    if best_label == '中文' and kana:
        return '日文'
    if best_label == '英文':
        if _langid is None:
            return '英文'
        try:
            lang_code, _ = _langid.classify(body)
            return {
                'en': '英文', 'fr': '法文', 'de': '德文', 'es': '西文',
                'it': '意文', 'pt': '葡文', 'vi': '越文',
            }.get(lang_code, '英文')
        except Exception:
            return '英文'
    return best_label


# ==================== 🤖 可选 AI（SiliconFlow）====================

_PROMPT_OVERRIDES: Dict[str, str] = {}


def register_prompt(prompt_id: str, text: str) -> None:
    """注册提示词覆盖值（对应源码的 AI 设置中心 ``ai_settings.prompt_text``）。"""
    if text:
        _PROMPT_OVERRIDES[str(prompt_id)] = str(text)


def ai_prompt(prompt_id, fallback=""):
    """读取提示词覆盖值，缺失时回落到内置默认（源码 ``_ai_prompt``）。"""
    return _PROMPT_OVERRIDES.get(str(prompt_id), fallback)


def ai_render(template, **kwargs):
    """占位符替换，缺键保持原样（源码 ``_ai_render``）。"""
    text = str(template or "")
    for key, value in kwargs.items():
        text = text.replace("{" + str(key) + "}", str(value))
    return text


def call_siliconflow(prompt: str, temperature: float = 0.0, max_tokens: int = 200,
                     timeout: int = 300) -> Optional[str]:
    """调用 SiliconFlow Chat Completions；未配置 Key 或失败返回 ``None``。

    :param prompt: 用户消息内容
    :param temperature: 采样温度（源码按用途取 0.0 / 0.1）
    :param max_tokens: 最大输出长度
    :param timeout: 超时秒数（源码统一 300）
    """
    api_key = config.get_credential("siliconflow_api_key")
    if not api_key:
        return None
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": config.AI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        resp = requests.post(config.SILICONFLOW_API_URL, json=payload, headers=headers, timeout=timeout)
        return resp.json()['choices'][0]['message']['content'].strip()
    except Exception:
        return None


_LANG_CLEAN_RE = re.compile(r"[\'\"「」『』“”‘’`\s.。,，、]")


def ai_predict_language(artist, title, genre=None, artist_country="", lyrics_text=None):
    """国籍不明时兜底判断语种；**不再把歌词喂给 AI**（歌词语言不是判定依据）。

    :param artist: 歌手名
    :param title: 歌名
    :param genre: 流派（作为参考提示）
    :param artist_country: MusicBrainz 的歌手国家码
    :param lyrics_text: 仅为兼容旧调用方保留，已不参与判定
    :return: :data:`LANGUAGES` 中的标签，未配置 Key / 失败时 ``None``
    """
    if not config.get_credential("siliconflow_api_key"):
        return None

    # 国籍才是判定依据：MusicBrainz 的歌手国家优先，其次内置国籍库。
    nationality_hint = ""
    db_result = _lookup_nationality_db(artist)
    if artist_country:
        nationality_hint = f"\n【歌手国籍（MusicBrainz）】{artist_country}"
    elif db_result:
        _, nationality = db_result
        nationality_hint = f"\n【歌手国籍（内置库）】{nationality}"
    genre_hint = f"\n【流派参考】{genre}" if genre else ""

    prompt = ai_render(
        ai_prompt(
            "music_language_predict",
            "请判断这位歌手/这个作品的语言归属。\n"
            "歌手: {artist}\n歌名: {title}{genre_hint}{nationality_hint}\n\n"
            "判定规则：\n"
            "- 以歌手国籍为准：国籍决定语种，不要因为歌名或歌词里出现别的语言就改判。\n"
            "- 中文歌手唱英文歌名、日文歌手写罗马音歌名 → 语种仍是该歌手自己的语种。\n"
            "- 国籍不明时才结合歌手名与流派推断，并把置信度标低。\n"
            "- 纯器乐/OST → 纯音乐\n\n"
            "只输出 JSON：{\"language\": \"中文/英文/日文/韩文/泰文/俄文/法文/德文/西文/意文/越文/纯音乐\", \"confidence\": \"high/medium/low\"}",
        ),
        artist=artist, title=title, genre_hint=genre_hint,
        nationality_hint=nationality_hint, lyrics_hint="",
    )
    content = call_siliconflow(prompt, temperature=0.1, max_tokens=80)
    if not content:
        return None
    json_match = re.search(r'\{.*?\}', content, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            lang_result = _LANG_CLEAN_RE.sub('', str(data.get('language', '')).strip())
            if lang_result in LANGUAGES:
                return lang_result
        except Exception:
            pass
    # fallback: 纯文本响应
    lang_result = _LANG_CLEAN_RE.sub('', content)
    if lang_result in LANGUAGES:
        return lang_result
    return None


def resolve_music_language(artist, title, genre="", artist_country="", lyrics_text=None):
    """按**歌手国籍**判定语种；国籍不明时才退回 AI 与歌名规则。

    顺序：MusicBrainz 歌手国家 → 内置歌手国籍库 → AI（只做归属判断，不再看歌词）
    → 歌名/流派规则。lyrics_text 保留仅为兼容旧调用方，不参与判定。

    :return: ``(语言标签, 判定依据说明)``
    """
    db_result = _lookup_nationality_db(artist)
    natively_multi = bool(db_result) and db_result[0] == 'multi'
    if not natively_multi:
        country_lang = country_code_to_language(artist_country)
        if country_lang:
            return country_lang, "歌手国籍（MusicBrainz）"
        nationality_lang = artist_nationality_language(artist)
        if nationality_lang:
            return nationality_lang, "歌手国籍库"
    if config.get_credential("siliconflow_api_key"):
        ai_lang = ai_predict_language(artist, title, genre, artist_country=artist_country)
        if ai_lang:
            return ai_lang, "AI"
    return detect_language_smart(artist, title, genre), "标题/流派规则"


# ==================== 🧹 署名与文件名归一 ====================

_ARTIST_SEPARATORS_RE = re.compile(
    r'\s*(?:/|、|，|,|;|；|&|\bfeat(?:\.)?|\bft(?:\.)?|\bfeaturing\b|\bwith\b)\s*',
    re.IGNORECASE,
)
# 歌手名之间的空格同样是分隔符，但只在「同一书写体系相邻」时成立：
# 「汪苏泷 五月天 阿信」→ 三位歌手；「Olivia Rodrigo」不受影响（拉丁↔拉丁）。
_CJK_CLASS = (
    r'\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
    r'\uff66-\uff9f\uac00-\ud7af\u1100-\u11ff'
)
_ARTIST_SCRIPT_BOUNDARY_RE = re.compile(
    rf'(?<=[{_CJK_CLASS}])\s+(?=[{_CJK_CLASS}A-Za-z0-9])|'
    rf'(?<=[A-Za-z0-9])\s+(?=[{_CJK_CLASS}])'
)

_KNOWN_SINGLE_ARTIST_KEYS = None


def _known_single_artist_keys():
    """国籍库里已知的单一歌手名（去空格 + 简繁归一后的小写形式）。"""
    global _KNOWN_SINGLE_ARTIST_KEYS
    if _KNOWN_SINGLE_ARTIST_KEYS is None:
        _KNOWN_SINGLE_ARTIST_KEYS = {
            re.sub(r'\s+', '', simple_convert(str(key)).casefold())
            for key in ARTIST_NATIONALITY_DB
        }
    return _KNOWN_SINGLE_ARTIST_KEYS


def _is_known_single_artist(value):
    """整体就是一位已知歌手时返回 True，例如「米津 玄師」。

    防止空格拆分把名字里本来就有空格的单一歌手拆成两个人。
    """
    key = re.sub(r'\s+', '', simple_convert(str(value or '')).casefold())
    return bool(key) and key in _known_single_artist_keys()


def normalize_artist_credit(value):
    """把多歌手署名统一成 ``A & B`` 形式（标签与文件名共用同一规则）。

    * 分隔符集合照抄源码：``/ 、 ， , ; ； & feat. ft. featuring with``
    * 额外的「空格拆分」只在同书写体系相邻时成立（CJK↔CJK、CJK↔拉丁）
    * feature 部分保留，主歌手永远排在第一位；按去空格小写键去重

    :param value: 字符串或 ``[artist1, artist2]`` 列表
    :return: ``'A & B'``；空输入返回 ``''``
    """
    if value is None:
        return ''
    if isinstance(value, (list, tuple)):
        raw_parts = [str(item or '') for item in value]
    else:
        raw_parts = [str(value or '')]

    parts: List[str] = []
    for raw in raw_parts:
        raw = raw.strip()
        if not raw:
            continue
        # 已知单一歌手（如「米津 玄師」）的名字内空格不是歌手分隔符。
        if _is_known_single_artist(raw):
            parts.append(re.sub(r'\s+', ' ', raw))
            continue
        for chunk in _ARTIST_SCRIPT_BOUNDARY_RE.split(raw):
            for part in _ARTIST_SEPARATORS_RE.split(chunk):
                part = part.strip(' \t\r\n-–—_')
                if part:
                    parts.append(part)

    unique_parts: List[str] = []
    seen = set()
    for part in parts:
        key = part.casefold().replace(' ', '')
        if key not in seen:
            unique_parts.append(part)
            seen.add(key)
    return ' & '.join(unique_parts)


def normalize_music_filename_artist_credit(stem):
    """只归一音乐文件名里的歌手部分，绝不动标题。

    仅当恰好一个 ``" - "`` 时才重建（``{title} - {artist}``）；出现更多
    ``" - "`` 说明标题自带分隔符，原样返回以免截断信息。
    """
    text = str(stem or '')
    if text.count(' - ') != 1:
        return stem
    title, artist = parse_filename_smart(f"{text}.tmp")
    if not artist:
        return stem
    normalized_artist = normalize_artist_credit(artist)
    if not normalized_artist:
        return stem
    return f"{title} - {normalized_artist}"


def sanitize_filename(name):
    """清理文件名非法字符；结果为空时返回 ``"Unknown"``。"""
    return re.sub(r'[\\/*?:"<>|]', '_', str(name)).strip() if name else "Unknown"


# ── 歌手显示名规范化 / 可疑名识别 ──
_FULLWIDTH_PAIRS = str.maketrans({'（': '(', '）': ')', '［': '[', '］': ']',
                                  '｛': '{', '｝': '}', '：': ':', '，': ',', '．': '.'})
_SUSPICIOUS_ARTIST_PATTERNS = (
    (re.compile(r'[\"{]\s*\"[^\"]+\"\s*:'), 'JSON 片段泄漏'),
    (re.compile(r'^[\s\d\W_]+$'), '无有效字符（纯符号/数字）'),
    (re.compile(r'^(art|artist|unknown|various artists?|未知|无|佚名)$', re.IGNORECASE), '占位符'),
)


def normalize_artist_display(name):
    """歌手显示名规范化：全→半角括号、括号内去掉碎点、首尾清理。

    只做「显然是同一种写法」的归一，不做任何推测性改写。
    """
    text = str(name or '').translate(_FULLWIDTH_PAIRS)
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'\(\s*([^()]*?)\s*[.。、,，]*\s*\)', r'(\1)', text)
    return text.strip(' .。·-—_')


def suspicious_artist_reason(name):
    """这个歌手名是不是「莫名其妙」——是的话给原因，否则返回 ``''``。"""
    text = str(name or '')
    if not text.strip():
        return '空'
    if len(text) > 80:
        return '过长（疑似整段响应体）'
    for pattern, reason in _SUSPICIOUS_ARTIST_PATTERNS:
        if pattern.search(text):
            return reason
    return ''


def artist_folder_key(name):
    """歌手名的粗归一（小写、去括号、去标点空格）：只用来找线索，不作合并依据。"""
    text = normalize_artist_display(name).lower()
    text = re.sub(r'[（(].*?[)）]', '', text)
    return re.sub(r'[\s._\-·、,，;；&+/]+', '', text)


def _title_key(text):
    """曲名/专辑名比较用的粗归一：小写 + 去空白、标点、括号。"""
    return re.sub(r'[\s._\-·、,，;；:：!！?？"\'“”‘’()（）\[\]【】]+',
                  '', str(text or '').lower())


# ── 手工别名表（源码里落盘到 .artist_aliases.json；这里默认只读内存，可选加载）──
_artist_name_aliases: Dict[str, str] = {}
_album_name_aliases: Dict[str, str] = {}


def merge_artist_name_aliases(pairs: Dict[str, str]) -> int:
    """「歌手原名 → 规范名」入表（内存），返回表内条数。"""
    clean = {}
    for from_name, to_name in (pairs or {}).items():
        head, tail = str(from_name).strip(), str(to_name).strip()
        if head and tail and head != tail:
            clean[head] = tail
    _artist_name_aliases.update(clean)
    return len(_artist_name_aliases)


def merge_album_name_aliases(pairs: Dict[str, str]) -> int:
    """「专辑原名 → 规范名」入表（内存），返回表内条数。"""
    clean = {}
    for from_name, to_name in (pairs or {}).items():
        head, tail = str(from_name).strip(), str(to_name).strip()
        if head and tail and head != tail:
            clean[head] = tail
    _album_name_aliases.update(clean)
    return len(_album_name_aliases)


def artist_name_alias(name):
    """查一个歌手名的规范写法；没配过返回 ``''``。"""
    text = str(name or '').strip()
    if not text:
        return ''
    if text in _artist_name_aliases:
        return _artist_name_aliases[text]
    lowered = text.casefold()
    for from_name, to_name in _artist_name_aliases.items():
        if from_name.casefold() == lowered:
            return to_name
    key = artist_folder_key(text)
    if key:
        for from_name, to_name in _artist_name_aliases.items():
            if artist_folder_key(from_name) == key:
                return to_name
    return ''


def album_name_alias(name):
    """查一张专辑的规范写法；没配过返回 ``''``。"""
    text = str(name or '').strip()
    if not text:
        return ''
    if text in _album_name_aliases:
        return _album_name_aliases[text]
    key = _title_key(text)
    if key:
        for from_name, to_name in _album_name_aliases.items():
            if _title_key(from_name) == key:
                return to_name
    return ''


def apply_artist_name_alias(credit):
    """把署名里的主艺人换成配好的规范名，feature 部分保留。"""
    text = str(credit or '').strip()
    if not text:
        return text
    parts = [part.strip() for part in text.split(' & ')]
    if not parts:
        return text
    mapped = artist_name_alias(parts[0])
    if mapped:
        parts[0] = mapped
    return ' & '.join(part for part in parts if part)


def apply_album_name_alias(name):
    """把专辑名换成配好的规范名（没配过原样返回）。"""
    return album_name_alias(name) or str(name or '').strip()


# ==================== 🏷️ 发行类型 / 专辑名 ====================

def clean_album_name(album):
    """去除专辑末尾的 -Single / -EP 标记。"""
    if not album:
        return album
    cleaned = re.sub(r'\s*[-–—]\s*(Single|EP|Deluxe\s*Edition|Remastered)\s*$', '', str(album), flags=re.IGNORECASE)
    cleaned = re.sub(r'\s*[\[\(]\s*(Single|EP)\s*[\]\)]\s*$', '', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def normalize_album_type(value):
    """把各源返回的发行类型归一成中文标签：单曲 / 迷你专辑 / 专辑 / 合辑。"""
    text = str(value or '').strip().lower()
    if not text:
        return None
    if any(item in text for item in ('single', '单曲')):
        return '单曲'
    # [BEHAVIOR CHANGE] EP is accepted as input, but displayed and tagged only in Chinese.
    if (any(item in text for item in ('迷你专辑', '迷你專輯', 'extended play', 'extended-play'))
            or re.search(r'(?<![a-z])ep(?![a-z])', text)):
        return '迷你专辑'
    if any(item in text for item in ('compilation', '合辑', '精选')):
        return '合辑'
    if any(item in text for item in ('album', '专辑')):
        return '专辑'
    return None


def album_type_standard_value(value):
    """返回内部/API 用的英文发行类型；写标签时用中文标签。"""
    return {
        '单曲': 'single',
        '迷你专辑': 'ep',
        '专辑': 'album',
        '合辑': 'compilation',
    }.get(normalize_album_type(value) or '', '')


def infer_album_type(raw_album='', title='', source_type='', total_tracks=0):
    """按源类型 / 专辑名后缀 / 曲目数 / 歌名等于专辑名 推断发行类型。"""
    normalized = normalize_album_type(source_type)
    if normalized:
        return normalized

    album_text = str(raw_album or '').strip()
    if re.search(r'(?:^|[\s\-–—_])single(?:[\s\-–—_]|$)', album_text, re.IGNORECASE):
        return '单曲'
    if re.search(r'(?:^|[\s\-–—_])ep(?:[\s\-–—_]|$)', album_text, re.IGNORECASE):
        return '迷你专辑'
    if any(marker in album_text for marker in ('合辑', '精选集', '精选')):
        return '合辑'
    if any(marker in album_text for marker in ('单曲',)):
        return '单曲'

    try:
        track_count = int(total_tracks or 0)
    except (TypeError, ValueError):
        track_count = 0
    if track_count == 1:
        return '单曲'
    if track_count and str(album_type_standard_value(source_type)) == 'ep':
        return '迷你专辑'
    if 2 <= track_count <= 6 and (normalize_album_type(source_type) != '专辑'):
        return '迷你专辑'

    clean_title = str(title or '').strip().casefold()
    clean_album = clean_album_name(album_text).strip().casefold()
    if clean_title and clean_album and clean_title == clean_album:
        return '单曲'
    return '专辑'


def translate_raw_genre(text):
    """把源返回的原始流派翻译成 :data:`RAW_GENRE_TRANSLATE` 中的中文标签。"""
    if not text:
        return "未知"
    if text in RAW_GENRE_TRANSLATE:
        return simple_convert(RAW_GENRE_TRANSLATE[text])
    parts = str(text).replace('&', '/').split('/')
    translated_parts = []
    for p in parts:
        p = p.strip()
        if p in RAW_GENRE_TRANSLATE:
            translated_parts.append(RAW_GENRE_TRANSLATE[p])
        else:
            translated_parts.append(p)
    return simple_convert(" / ".join(translated_parts))


# ── 专辑的「版本尾巴」：豪华版/加值版一律并回普通专辑 ──
PLAIN_ALBUM_NAMES = True

_EDITION_MARKERS = (
    'deluxe', 'expanded', 'special edition', 'bonus', 'limited edition',
    'anniversary', 'remaster', 'complete edition', 'standard edition',
    'explicit', 'clean version', 'spilled', 'japanese edition',
    '豪华版', '豪華版', '特别版', '特別版', '限定版', '初回限定', '加值版',
    '周年', '完全版', '独家版', '獨家版',
)

# 真正是「另一张作品」的版本，一律不剥（(Taylor's Version) 这种更不能动）
_VERSION_KEEP_WORDS = ('live', 'acoustic', 'instrumental', 'remix', 'demo',
                       'karaoke', 'cover', '现场', '演唱会', '伴奏', '翻唱')


def configure_album_naming(plain=True):
    """刮削前设置：豪华版是否归到普通专辑（默认开）。"""
    global PLAIN_ALBUM_NAMES
    PLAIN_ALBUM_NAMES = bool(plain)


def _is_edition_tail(inner):
    text = str(inner or '').lower()
    if not text:
        return False
    if any(word in text for word in _VERSION_KEEP_WORDS):
        return False
    return any(marker in text for marker in _EDITION_MARKERS)


def _strip_one_edition_tail(text):
    """剥一层版本尾巴（括号段或裸露关键词）；没有可剥的原样返回。"""
    bracket = re.search(r'\s*[（(\[](?P<inner>[^（()）\[\]]*)[)）\]]\s*$', text)
    if bracket and _is_edition_tail(bracket.group('inner')):
        return text[:bracket.start()].strip(' -–—·「」')
    bare = re.search(
        r'[\s\-–—·]+(deluxe|expanded|remaster(ed)?|special edition|'
        r'bonus( track)?( version)?|limited edition|complete edition|'
        r'豪华版|豪華版|特别版|特別版|限定版|加值版|完全版)\s*$',
        text, re.IGNORECASE)
    if bare:
        return text[:bare.start()].strip(' -–—·「」')
    return text


def strip_edition_suffix(name):
    """把「1989 (Deluxe Edition)」这类版本尾巴剥掉，只留普通专辑名。

    只认版本关键词；「(Taylor's Version)」「(Live)」「(Acoustic)」一律不动。
    剥不干净时返回原值，绝不返回空串。
    """
    text = str(name or '').strip()
    if not text:
        return ''
    plain = text
    while True:
        stripped = _strip_one_edition_tail(plain)
        if stripped == plain:
            break
        plain = stripped
    return plain or text


# ==================== 📄 文件名解析 ====================

def parse_filename_smart(filename):
    """按 ``歌名 - 歌手`` 之类分隔符解析文件名。

    :param filename: 文件名（可含扩展名）
    :return: ``(标题, 歌手)``；解析不出返回 ``(None, None)``
    """
    base = os.path.splitext(filename)[0]
    # 支持更多分隔符：半角 - 、全角 － 、下划线 _
    for sep in (" - ", " － ", " – ", " — "):
        if sep in base:
            parts = base.split(sep)
            if len(parts) >= 2:
                return parts[0].strip(), parts[1].strip()
    if "_" in base:
        parts = base.split("_")
        if len(parts) >= 2:
            return parts[0].strip(), parts[1].strip()
    return None, None


def neuro_parse_filename(filename):
    """AI 智能解析文件名 → ``(artist, title)``；未配置 Key 时返回 ``(None, None)``。"""
    if not config.get_credential("siliconflow_api_key"):
        return None, None
    base_name = os.path.splitext(filename)[0]
    clean_name = re.sub(r'\[.*?\]|【.*?】|\(official.*?\)|\(lyric.*?\)|\(live.*?\)|\(MV\)', '', base_name, flags=re.IGNORECASE)
    clean_name = re.sub(r'[-_]?(wy|128k|320k|HQ|SQ|mq|flac|mp3|kbps)$', '', clean_name, flags=re.IGNORECASE).strip()
    prompt = (
        f"分析字符串 \"{clean_name}\" (原文件: {filename})，提取 Artist (歌手) 和 Title (歌名)。\n\n"
        "【Few-Shot 示例】\n"
        "输入: \"周杰伦 - 七里香\" -> {\"artist\": \"周杰伦\", \"title\": \"七里香\"}\n"
        "输入: \"YOASOBI_夜に駆ける_高音质\" -> {\"artist\": \"YOASOBI\", \"title\": \"夜に駆ける\"}\n"
        "只输出 JSON: {\"artist\": \"...\", \"title\": \"...\"}"
    )
    content = call_siliconflow(prompt, temperature=0.1, max_tokens=150)
    if not content:
        return None, None
    json_match = re.search(r'\{.*?\}', content, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            ai_artist = data.get('artist', '').strip()
            ai_title = data.get('title', '').strip()
            if ai_artist and ai_title:
                return ai_artist, ai_title
        except Exception:
            pass
    return None, None


def is_fuzzy_match(filename_artist, result_artist):
    """文件名歌手与结果歌手是否模糊匹配（多艺术家逐一比对）。

    ``thefuzz`` 可用时使用 ``token_sort_ratio`` 阈值 75，缺失时走首字符+长度兜底。

    :param filename_artist: 文件名解析出的歌手（可能为空 = 无信息，视为信任）
    :param result_artist: 数据源返回的歌手署名
    """
    # 一边为空另一边有值 → 无法验证，不匹配
    if not filename_artist and not result_artist:
        return True
    if not filename_artist:
        return True  # 无歌手信息，信任标题闸门
    if not result_artist:
        return False  # 有歌手预期但结果无歌手
    # 多艺术家支持：拆分后逐一检查
    # 支持更多合作分隔符：feat. / ft. / vs. / x / with / featuring / & / 、
    _split_pattern = re.compile(r'\s*(?:feat\.?|ft\.?|featuring|vs\.?|versus|[x×]\s|with|&|、|,|/)\s*', re.IGNORECASE)
    fa_parts = [p.strip() for p in _split_pattern.split(filename_artist) if p.strip()]
    ra_parts = [p.strip() for p in _split_pattern.split(result_artist) if p.strip()]
    # 至少有一个文件名的艺术家匹配结果中的任意艺术家
    for fa in fa_parts:
        for ra in ra_parts:
            f_a = simple_convert(fa.lower().replace(" ", ""))
            r_a = simple_convert(ra.lower().replace(" ", ""))
            if not f_a or not r_a:
                continue
            if f_a in r_a or r_a in f_a:
                return True
            if HAS_FUZZ and _fuzz and _fuzz.token_sort_ratio(f_a, r_a) >= 75:
                return True
    # 兜底：无 fuzz 时单个艺术家
    if filename_artist and result_artist:
        f_a = simple_convert(filename_artist.lower().replace(" ", ""))
        r_a = simple_convert(result_artist.lower().replace(" ", ""))
        if f_a and r_a and f_a[0] == r_a[0]:
            if abs(len(f_a) - len(r_a)) <= max(len(f_a), len(r_a)) // 2:
                return True
    return False


def _strip_title_versions(title):
    """去掉 (Official Audio) / [Live] 这类发行限定词。"""
    cleaned = str(title or '')
    previous = None
    while previous != cleaned:
        previous = cleaned
        cleaned = re.sub(r'\s*[\(\[\{<][^)\]\}>]*[\)\]\}>]', ' ', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()


def _title_tokens(title):
    normalized = unicodedata.normalize('NFKC', simple_convert(_strip_title_versions(title))).lower()
    return [token for token in re.findall(r'[^\W_]+', normalized, flags=re.UNICODE)]


def is_track_title_match(expected_title, candidate_title):
    """按整词比对歌名，忽略无害的发行限定词；中文标题要求近乎完全一致。"""
    expected_raw = _strip_title_versions(expected_title)
    candidate_raw = _strip_title_versions(candidate_title)
    if not expected_raw or not candidate_raw:
        return False
    expected_norm = unicodedata.normalize('NFKC', simple_convert(expected_raw)).lower()
    candidate_norm = unicodedata.normalize('NFKC', simple_convert(candidate_raw)).lower()
    if expected_norm == candidate_norm:
        return True

    expected_tokens = _title_tokens(expected_title)
    candidate_tokens = _title_tokens(candidate_title)
    if not expected_tokens or not candidate_tokens:
        return False
    width = len(expected_tokens)
    if any(candidate_tokens[index:index + width] == expected_tokens
           for index in range(len(candidate_tokens) - width + 1)):
        return True

    # CJK titles have no whitespace tokens; accept only a near-exact version string.
    if re.search(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', expected_norm):
        return expected_norm.replace(' ', '') == candidate_norm.replace(' ', '')
    return False


# 单曲/EP 的字样（各源写法不一：中文源给「单曲」，MusicBrainz 给 Single/EP）
_SINGLE_ALBUM_TYPES = {'单曲', 'single', 'ep', 'mini album', '数字单曲'}
_COMPILATION_KEYWORDS = ('greatest hit', 'best of', 'compilation', 'selected', '精选', '合集')
_SOUNDTRACK_KEYWORDS = ('soundtrack', 'ost', 'original score', '原声', '配乐')


def classify_album_context(candidate):
    """判断候选发行属于哪一类：studio / single / compilation / live / soundtrack。

    多信号判定：MusicBrainz 发行组类型 → 曲目数（1~3 首按单曲）→ 专辑名关键词
    → 中文源的 album_type 字面量。
    """
    album = str(candidate.get('album') or '').lower()
    genre_type = str(candidate.get('album_type') or '').strip().lower()
    primary = str(candidate.get('release_group_primary_type') or '').strip().lower()
    secondary = {str(item).strip().lower()
                 for item in (candidate.get('release_group_secondary_types') or [])}
    try:
        total_tracks = int(candidate.get('total_tracks') or 0)
    except (TypeError, ValueError):
        total_tracks = 0

    if any(kw in album for kw in _COMPILATION_KEYWORDS) or 'compilation' in secondary:
        return 'compilation'
    if any(kw in album for kw in _SOUNDTRACK_KEYWORDS) or 'soundtrack' in secondary:
        return 'soundtrack'
    if 'live' in album or 'live' in secondary:
        return 'live'
    if primary in ('single', 'ep') or genre_type in _SINGLE_ALBUM_TYPES:
        return 'single'
    # 整张只有 1~3 首 → 按单曲发行对待（EP 一般 4 首以上）
    if 0 < total_tracks <= 3 and not secondary:
        return 'single'
    return 'studio'


def filter_album_context(candidates, prefer_original_album=True):
    """录音室专辑优先：有 studio 候选就只在 studio 里挑；否则剔除精选集。

    ``prefer_original_album=False`` 时原样返回（纯按匹配分排序）。
    """
    if not prefer_original_album or not candidates:
        return candidates
    studio = [c for c in candidates if c.get('context') == 'studio']
    if studio:
        return studio
    non_compilation = [c for c in candidates if c.get('context') != 'compilation']
    return non_compilation or candidates


# ==================== 🔊 时长 / 搜索信息 ====================

def get_audio_duration_hint(filepath):
    """读本地音频时长（整秒），失败返回 ``None``；用于搜索打分。"""
    duration_hint = None
    try:
        lower_path = str(filepath).lower()
        if lower_path.endswith('.mp3'):
            from mutagen.mp3 import MP3 as MP3_local
            duration_hint = int(MP3_local(filepath).info.length)
        elif lower_path.endswith('.flac'):
            from mutagen.flac import FLAC as FLAC_local
            duration_hint = int(FLAC_local(filepath).info.length)
        elif lower_path.endswith('.m4a') or lower_path.endswith('.mp4'):
            from mutagen.mp4 import MP4 as MP4_local
            duration_hint = int(MP4_local(filepath).info.length)
        elif lower_path.endswith('.opus'):
            from mutagen.oggopus import OggOpus as OggOpus_local
            duration_hint = int(OggOpus_local(filepath).info.length)
        elif lower_path.endswith('.ogg') or lower_path.endswith('.oga'):
            from mutagen.oggvorbis import OggVorbis as OggVorbis_local
            duration_hint = int(OggVorbis_local(filepath).info.length)
    except Exception:
        duration_hint = None
    return duration_hint


def _first_tag(tags, key):
    value = (tags or {}).get(key) or []
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ''
    return str(value).strip()


def get_search_info(filepath):
    """给出一个文件的搜索三元组：``(keyword, artist, title, from_filename)``。

    顺序与源码一致：规则解析 → AI 兜底 → 读已有标签 → 退化为文件名。
    """
    filename = os.path.basename(filepath)
    # 1️⃣ 规则解析优先（确定性高，不会被 AI 搞反歌手/歌名）
    title, artist = parse_filename_smart(filename)
    if title and artist:
        return f"{artist} {title}", artist, title, True
    # 2️⃣ AI 兜底（文件名无分隔符时）
    if config.get_credential("siliconflow_api_key") and len(filename) > 5:
        ai_artist, ai_title = neuro_parse_filename(filename)
        if ai_artist and ai_title:
            return f"{ai_artist} {ai_title}", ai_artist, ai_title, True
    # 3️⃣ 从已有标签读取
    tag_artist = tag_title = ''
    try:
        from mutagen import File as MutagenFile
        tags = MutagenFile(filepath, easy=True) or {}
        tag_artist = _first_tag(tags, 'artist')
        tag_title = _first_tag(tags, 'title')
    except Exception:
        pass
    if tag_artist and tag_title:
        return f"{tag_artist} {tag_title}", tag_artist, tag_title, False
    return os.path.splitext(filename)[0], "", os.path.splitext(filename)[0], True


def get_search_info_variants(filepath):
    """返回文件名的候选解析方向，避免 ``Artist - Title`` 被反向理解。"""
    filename = os.path.basename(filepath)
    base = os.path.splitext(filename)[0]
    parts = None
    for sep in (" - ", " － ", " – ", " — "):
        if sep in base:
            split_parts = [part.strip() for part in base.split(sep)]
            if len(split_parts) >= 2 and all(split_parts[:2]):
                parts = split_parts[:2]
                break
    if not parts:
        return [get_search_info(filepath)]

    left, right = parts
    variants = []
    # 现有规则把分隔符左侧视为歌名；再保留反向结果供匹配闸门择优。
    for artist, title in ((right, left), (left, right)):
        variant = (f"{artist} {title}", artist, title, True)
        if variant not in variants:
            variants.append(variant)
    return variants
