"""音频标签读写（纯逻辑，无 GUI 依赖）。

迁移自 ``media_toolkit.py`` 的 :func:`update_audio_tags`，字段映射逐项照抄：

====================  =====================================================
格式                   标签键
====================  =====================================================
``.mp3`` (ID3)         TIT2 TPE1 TALB TPE2 TCON TDRC TRCK TCOM TEXT TLAN
                       USLT APIC，TXXX:ALBUMTYPE / Album Type / RELEASETYPE /
                       MusicBrainz Album Type / MusicBrainz Artist Id /
                       MusicBrainz Release Group Id
``.m4a`` / ``.mp4``    ©nam ©ART ©alb aART ©gen ©day trkn ©wrt ©lyr covr，
                       ``----:com.apple.iTunes:{LYRICIST, LANGUAGE,
                       MusicBrainz Artist Id, MusicBrainz Release Group Id,
                       ALBUMTYPE, RELEASETYPE, MUSICBRAINZ_ALBUMTYPE}``
``.flac``              Vorbis comment：title artist album albumartist genre
                       date tracknumber composer lyricist language lyrics
                       RELEASETYPE MUSICBRAINZ_ALBUMTYPE ALBUMTYPE
                       musicbrainz_artistid musicbrainz_releasegroupid
                       + ``metadata_block_picture``
``.ogg/.oga/.opus``    同 FLAC（共用 Vorbis comment 写入路径）
====================  =====================================================

写盘前**先读原值**，把逐字段变更摘要交给上层做「预览 / 确认」：

* :func:`plan_tag_update` → ``{字段: {'old': 旧值, 'new': 新值}}``（不落盘）
* :func:`apply_tag_update` → 真正写盘
* :func:`update_audio_tags(..., dry_run=True)` → 一步拿到预览

只读接口：:func:`read_audio_tags`（读回上述全部字段）、:func:`read_cover`。
"""

from __future__ import annotations

import base64
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB, TPE2, TCON, TLAN, TDRC, TXXX, TRCK, TPOS, TCOP, TCOM, TEXT, USLT
from mutagen.mp3 import MP3

from .normalize import (
    PLAIN_ALBUM_NAMES,
    apply_album_name_alias,
    apply_artist_name_alias,
    normalize_album_type,
    normalize_artist_credit,
    normalize_artist_display,
    strip_edition_suffix,
)

LOGGER = logging.getLogger(__name__)

__all__ = [
    "SUPPORTED_EXTENSIONS",
    "read_audio_tags",
    "read_cover",
    "plan_tag_update",
    "apply_tag_update",
    "update_audio_tags",
    "normalize_audio_artist_tags",
    "TagUpdatePlan",
]

# 支持写入的扩展名（与源码一致）
SUPPORTED_EXTENSIONS = ('.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.oga', '.opus')

# read_audio_tags 会返回的字段（缺失一律为 '' / 0，便于直接 diff）
READ_FIELDS = (
    'title', 'artist', 'album', 'album_artist', 'genre', 'date', 'year',
    'track_num', 'total_tracks', 'disc_num', 'composer', 'lyricist',
    'language', 'artist_mbid', 'release_group_id', 'album_type',
    'copyright', 'lyrics', 'has_cover', 'cover_mime', 'cover_size',
)

# 写标签时的字段 → 各格式标签键（用于文档与预览说明）
FIELD_TARGETS: Dict[str, Dict[str, str]] = {
    'title': {'.mp3': 'TIT2', 'm4a': '©nam', 'vorbis': 'title'},
    'artist': {'.mp3': 'TPE1', 'm4a': '©ART', 'vorbis': 'artist'},
    'album': {'.mp3': 'TALB', 'm4a': '©alb', 'vorbis': 'album'},
    'album_artist': {'.mp3': 'TPE2', 'm4a': 'aART', 'vorbis': 'albumartist'},
    'genre': {'.mp3': 'TCON', 'm4a': '©gen', 'vorbis': 'genre'},
    'date': {'.mp3': 'TDRC', 'm4a': '©day', 'vorbis': 'date'},
    'track_num': {'.mp3': 'TRCK', 'm4a': 'trkn', 'vorbis': 'tracknumber'},
    'composer': {'.mp3': 'TCOM', 'm4a': '©wrt', 'vorbis': 'composer'},
    'lyricist': {'.mp3': 'TEXT', 'm4a': '----:com.apple.iTunes:LYRICIST', 'vorbis': 'lyricist'},
    'language': {'.mp3': 'TLAN', 'm4a': '----:com.apple.iTunes:LANGUAGE', 'vorbis': 'language'},
    'artist_mbid': {'.mp3': 'TXXX:MusicBrainz Artist Id',
                    'm4a': '----:com.apple.iTunes:MusicBrainz Artist Id',
                    'vorbis': 'musicbrainz_artistid'},
    'release_group_id': {'.mp3': 'TXXX:MusicBrainz Release Group Id',
                         'm4a': '----:com.apple.iTunes:MusicBrainz Release Group Id',
                         'vorbis': 'musicbrainz_releasegroupid'},
    'album_type': {'.mp3': 'TXXX:ALBUMTYPE/Album Type/RELEASETYPE/MusicBrainz Album Type',
                   'm4a': '----:com.apple.iTunes:ALBUMTYPE/RELEASETYPE/MUSICBRAINZ_ALBUMTYPE',
                   'vorbis': 'RELEASETYPE/MUSICBRAINZ_ALBUMTYPE/ALBUMTYPE'},
    'lyrics': {'.mp3': 'USLT', 'm4a': '©lyr', 'vorbis': 'lyrics'},
    'cover': {'.mp3': 'APIC', 'm4a': 'covr', 'vorbis': 'metadata_block_picture'},
}


# ==================== 📖 只读：读回标签 ====================

def _open_vorbis_audio(filepath):
    """打开 Ogg Vorbis / Opus 共用的 Vorbis comment 对象。"""
    lower_path = str(filepath).lower()
    if lower_path.endswith('.opus'):
        from mutagen.oggopus import OggOpus
        return OggOpus(filepath)
    from mutagen.oggvorbis import OggVorbis
    return OggVorbis(filepath)


def _cover_descriptor(mime: str, size: int) -> str:
    """把封面描述成可 JSON 序列化的一行字（预览用）。"""
    if not size:
        return ''
    return f"<{mime or 'image'} {size} bytes>"


def read_audio_tags(filepath) -> Dict[str, Any]:
    """读回 :func:`update_audio_tags` 会写入的全部字段（只读，不改文件）。

    :param filepath: 音频文件路径（``.mp3/.flac/.m4a/.mp4/.ogg/.oga/.opus``）
    :return: 字段字典；键见 :data:`READ_FIELDS`，另含 ``format``（识别出的格式）
             与 ``error``（读取失败原因，正常时不存在）
    """
    info: Dict[str, Any] = {key: '' for key in READ_FIELDS}
    info['track_num'] = ''
    info['total_tracks'] = 0
    info['disc_num'] = ''
    info['has_cover'] = False
    info['cover_mime'] = ''
    info['cover_size'] = 0
    path = str(filepath or '')
    lower = path.lower()
    try:
        if lower.endswith('.mp3'):
            info['format'] = '.mp3'
            audio = MP3(path)
            tags = audio.tags
            if tags is not None:
                def _id3_text(frame_id):
                    frames = tags.getall(frame_id)
                    if not frames:
                        return ''
                    text = getattr(frames[0], 'text', None)
                    if isinstance(text, (list, tuple)):
                        return ', '.join(str(item) for item in text)
                    return str(text or '')

                info['title'] = _id3_text('TIT2')
                info['artist'] = _id3_text('TPE1')
                info['album'] = _id3_text('TALB')
                info['album_artist'] = _id3_text('TPE2')
                info['genre'] = _id3_text('TCON')
                info['date'] = _id3_text('TDRC') or _id3_text('TYER')
                info['track_num'] = _id3_text('TRCK')
                info['disc_num'] = _id3_text('TPOS')
                info['composer'] = _id3_text('TCOM')
                info['lyricist'] = _id3_text('TEXT')
                info['language'] = _id3_text('TLAN')
                info['copyright'] = _id3_text('TCOP')
                for desc, field_name in (('ALBUMTYPE', 'album_type'),
                                         ('Album Type', 'album_type'),
                                         ('RELEASETYPE', 'album_type'),
                                         ('MusicBrainz Album Type', 'album_type'),
                                         ('MusicBrainz Artist Id', 'artist_mbid'),
                                         ('MusicBrainz Release Group Id', 'release_group_id')):
                    if info[field_name]:
                        continue
                    frames = tags.getall(f'TXXX:{desc}')
                    if frames:
                        text = getattr(frames[0], 'text', None)
                        info[field_name] = (str(text[0]) if isinstance(text, (list, tuple)) and text
                                            else str(text or ''))
                lyrics_frames = tags.getall('USLT')
                if lyrics_frames:
                    info['lyrics'] = str(getattr(lyrics_frames[0], 'text', '') or '')
                for frame in tags.getall('APIC'):
                    info['has_cover'] = True
                    info['cover_mime'] = str(getattr(frame, 'mime', '') or '')
                    info['cover_size'] = len(getattr(frame, 'data', b'') or b'')
                    break
        elif lower.endswith('.flac'):
            info['format'] = '.flac'
            audio = FLAC(path)
            for key, field_name in (('title', 'title'), ('artist', 'artist'), ('album', 'album'),
                                    ('albumartist', 'album_artist'), ('genre', 'genre'),
                                    ('date', 'date'), ('tracknumber', 'track_num'),
                                    ('composer', 'composer'), ('lyricist', 'lyricist'),
                                    ('language', 'language')):
                values = audio.get(key) or []
                info[field_name] = str(values[0]) if values else ''
            info['artist_mbid'] = str((audio.get('musicbrainz_artistid') or [''])[0])
            info['release_group_id'] = str((audio.get('musicbrainz_releasegroupid') or [''])[0])
            for key in ('RELEASETYPE', 'MUSICBRAINZ_ALBUMTYPE', 'ALBUMTYPE'):
                values = audio.get(key) or []
                if values:
                    info['album_type'] = str(values[0])
                    break
            lyrics_values = audio.get('lyrics') or []
            info['lyrics'] = str(lyrics_values[0]) if lyrics_values else ''
            if audio.pictures:
                info['has_cover'] = True
                info['cover_mime'] = str(audio.pictures[0].mime or '')
                info['cover_size'] = len(audio.pictures[0].data or b'')
            else:
                encoded = (audio.get('metadata_block_picture') or [])
                if encoded:
                    try:
                        picture = Picture(base64.b64decode(str(encoded[0])))
                        info['has_cover'] = True
                        info['cover_mime'] = str(picture.mime or '')
                        info['cover_size'] = len(picture.data or b'')
                    except Exception:
                        info['has_cover'] = True
        elif lower.endswith(('.ogg', '.oga', '.opus')):
            info['format'] = '.opus' if lower.endswith('.opus') else '.ogg'
            audio = _open_vorbis_audio(path)
            for key, field_name in (('title', 'title'), ('artist', 'artist'), ('album', 'album'),
                                    ('albumartist', 'album_artist'), ('genre', 'genre'),
                                    ('date', 'date'), ('tracknumber', 'track_num'),
                                    ('composer', 'composer'), ('lyricist', 'lyricist'),
                                    ('language', 'language')):
                values = audio.get(key) or []
                info[field_name] = str(values[0]) if values else ''
            info['artist_mbid'] = str((audio.get('musicbrainz_artistid') or [''])[0])
            info['release_group_id'] = str((audio.get('musicbrainz_releasegroupid') or [''])[0])
            for key in ('RELEASETYPE', 'MUSICBRAINZ_ALBUMTYPE', 'ALBUMTYPE'):
                values = audio.get(key) or []
                if values:
                    info['album_type'] = str(values[0])
                    break
            lyrics_values = audio.get('lyrics') or []
            info['lyrics'] = str(lyrics_values[0]) if lyrics_values else ''
            encoded = (audio.get('metadata_block_picture') or [])
            if encoded:
                try:
                    picture = Picture(base64.b64decode(str(encoded[0])))
                    info['has_cover'] = True
                    info['cover_mime'] = str(picture.mime or '')
                    info['cover_size'] = len(picture.data or b'')
                except Exception:
                    info['has_cover'] = True
        elif lower.endswith(('.m4a', '.mp4')):
            info['format'] = '.m4a'
            from mutagen.mp4 import MP4 as MP4_local
            from mutagen.mp4 import MP4Cover
            audio = MP4_local(path)
            tags = audio.tags or {}

            def _atom(atom):
                values = tags.get(atom) or []
                return str(values[0]) if values else ''

            info['title'] = _atom('\xa9nam')
            info['artist'] = _atom('\xa9ART')
            info['album'] = _atom('\xa9alb')
            info['album_artist'] = _atom('aART')
            info['genre'] = _atom('\xa9gen')
            info['date'] = _atom('\xa9day')
            info['composer'] = _atom('\xa9wrt')
            info['lyrics'] = _atom('\xa9lyr')
            track_values = tags.get('trkn') or []
            if track_values:
                try:
                    info['track_num'] = str(track_values[0][0] or '')
                    info['total_tracks'] = int(track_values[0][1] or 0)
                except Exception:
                    info['track_num'] = str(track_values[0])
            for name, field_name in (('LYRICIST', 'lyricist'), ('LANGUAGE', 'language'),
                                     ('MusicBrainz Artist Id', 'artist_mbid'),
                                     ('MusicBrainz Release Group Id', 'release_group_id')):
                values = tags.get(f'----:com.apple.iTunes:{name}') or []
                if values:
                    raw = values[0]
                    info[field_name] = bytes(raw).decode('utf-8', 'ignore') if isinstance(raw, bytes) else str(raw)
            for name in ('ALBUMTYPE', 'RELEASETYPE', 'MUSICBRAINZ_ALBUMTYPE'):
                values = tags.get(f'----:com.apple.iTunes:{name}') or []
                if values:
                    raw = values[0]
                    info['album_type'] = bytes(raw).decode('utf-8', 'ignore') if isinstance(raw, bytes) else str(raw)
                    break
            covers = tags.get('covr') or []
            if covers:
                cover = covers[0]
                info['has_cover'] = True
                info['cover_size'] = len(bytes(cover))
                info['cover_mime'] = ('image/png'
                                      if getattr(cover, 'imageformat', None) == MP4Cover.FORMAT_PNG
                                      else 'image/jpeg')
        else:
            info['format'] = ''
            info['error'] = '不支持的文件格式'
            return info
    except Exception as exc:  # 损坏/被占用/格式不符 → 不抛，交给调用方判断
        LOGGER.debug("读取标签失败：%s", filepath, exc_info=True)
        info.setdefault('format', '')
        info['error'] = str(exc)[:500]
        return info
    info['year'] = (str(info['date'])[:4] if info['date'] else '')
    return info


def read_cover(filepath):
    """读本地音频内嵌封面（源码 ``extract_local_cover`` 的等价实现）。

    :return: ``(图片字节, mime)``；没有封面或读取失败返回 ``(None, None)``
    """
    try:
        lower_path = str(filepath).lower()
        if lower_path.endswith('.mp3'):
            audio = MP3(filepath)
            for tag in audio.values():
                if isinstance(tag, APIC):
                    return tag.data, tag.mime
        elif lower_path.endswith('.flac'):
            audio = FLAC(filepath)
            if audio.pictures:
                return audio.pictures[0].data, audio.pictures[0].mime
        elif lower_path.endswith('.m4a') or lower_path.endswith('.mp4'):
            from mutagen.mp4 import MP4 as MP4_local
            from mutagen.mp4 import MP4Cover
            audio = MP4_local(filepath)
            for cover in audio.tags.get('covr', []) if audio.tags else []:
                if isinstance(cover, MP4Cover) and cover:
                    mime = 'image/png' if cover.imageformat == MP4Cover.FORMAT_PNG else 'image/jpeg'
                    return bytes(cover), mime
        elif lower_path.endswith(('.ogg', '.oga', '.opus')):
            audio = _open_vorbis_audio(filepath)
            encoded_pictures = (audio or {}).get('metadata_block_picture', [])
            if encoded_pictures:
                picture = Picture(base64.b64decode(str(encoded_pictures[0])))
                return picture.data, picture.mime
    except Exception:
        pass
    return None, None


# ==================== 🧾 变更摘要（preview） ====================

class TagUpdatePlan(dict):
    """标签写入计划：**本身就是一个** ``{字段: {'old':..., 'new':...}}`` 摘要。

    附加值（属性访问，不进 JSON）：
    ``filepath`` / ``fmt`` / ``info``（归一后的写入值）/ ``image_data`` /
    ``lyrics_text`` / ``overwrite_existing`` / ``skipped``（因不覆盖而跳过的字段）
    / ``changed``（确实发生变化的字段名列表）/ ``unchanged``（新旧相同但会重写的字段）
    """

    def __init__(self, filepath: str = '', fmt: str = '', info=None, image_data=None,
                 lyrics_text=None, overwrite_existing=True):
        super().__init__()
        self.filepath = filepath
        self.fmt = fmt
        self.info = dict(info or {})
        self.image_data = image_data
        self.lyrics_text = lyrics_text
        self.overwrite_existing = bool(overwrite_existing)
        self.skipped: Dict[str, str] = {}
        self.changed = []

    @property
    def changes(self) -> Dict[str, Dict[str, Any]]:
        """变更摘要本体（= 这个 dict 自身）。"""
        return dict(self)

    def add(self, field: str, old, new) -> None:
        """记录一个字段的新旧值；完全相同则不计入变更摘要。"""
        self[field] = {'old': old, 'new': new}
        if str(old or '') != str(new or ''):
            self.changed.append(field)

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return (f"TagUpdatePlan(file={os.path.basename(self.filepath)}, fmt={self.fmt}, "
                f"changed={sorted(set(self.changed))}, skipped={sorted(self.skipped)})")


def _prepare_info(info, plain_album=None, overwrite_existing=True):
    """写入前的歌手/专辑名归一（与源码 update_audio_tags 开头逐行一致）。"""
    info = dict(info or {})
    # 歌手名先过两道「显然是同一种写法」的归一：分隔符 + 全角括号/碎点
    info['artist'] = normalize_artist_display(
        normalize_artist_credit(info.get('artist', '')))
    info['album_artist'] = normalize_artist_display(
        normalize_artist_credit(info.get('album_artist', ''))) or info['artist']
    # 手工配的「歌手别名」优先（未配置别名表时是恒等变换）
    info['artist'] = apply_artist_name_alias(info['artist'])
    info['album_artist'] = (apply_artist_name_alias(info['album_artist'])
                            or info['album_artist'])
    if (PLAIN_ALBUM_NAMES if plain_album is None else plain_album) and info.get('album'):
        # 豪华版/加值版直接写成普通专辑名
        info['album'] = strip_edition_suffix(info['album'])
    if info.get('album'):
        info['album'] = apply_album_name_alias(info['album'])
    return info


def _planned_values(info, image_data, lyrics_text):
    """算出「本次写入会把各字段写成什么」（用于 diff 与日志）。"""
    album_type = normalize_album_type(info.get('album_type')) or str(info.get('album_type') or '')
    language = str(info.get('language') or '').strip("'\"「」『』 “”‘’`")
    planned = {
        'title': str(info.get('title') or ''),
        'artist': str(info.get('artist') or ''),
        'album': str(info.get('album') or ''),
        'album_artist': str(info.get('album_artist') or ''),
        'genre': str(info.get('genre') or ''),
        'date': str(info.get('date') or ''),
        'track_num': str(info.get('track_num') or ''),
        'composer': str(info.get('composer') or ''),
        'lyricist': str(info.get('lyricist') or ''),
        'language': language,
        'artist_mbid': str(info.get('artist_mbid') or '').strip(),
        'release_group_id': str(info.get('release_group_id') or '').strip(),
        'album_type': album_type,
    }
    if lyrics_text:
        planned['lyrics'] = str(lyrics_text)
    if image_data:
        data = image_data if isinstance(image_data, bytes) else bytes(image_data)
        mime = 'image/png' if data[:4] == b'\x89PNG' else 'image/jpeg'
        planned['cover'] = _cover_descriptor(mime, len(data))
    return planned


def plan_tag_update(filepath, info, image_data=None, lyrics_text=None,
                    overwrite_existing=True, plain_album=None) -> TagUpdatePlan:
    """**预演**一次标签写入，返回 ``{字段: {'old': 旧值, 'new': 新值}}`` 变更摘要。

    不写盘。上层的「预览 / 确认」界面直接用这个结果展示；用户确认后再调用
    :func:`apply_tag_update`。

    :param filepath: 音频文件路径
    :param info: 待写入的元数据（键名见 :data:`FIELD_TARGETS`，含 title/artist/album/
        album_artist/genre/date/track_num/composer/lyricist/language/artist_mbid/
        release_group_id/album_type 等）
    :param image_data: 封面图片字节（给了就会写 covr/APIC/metadata_block_picture）
    :param lyrics_text: 歌词文本（给了就会写 ©lyr / USLT / lyrics）
    :param overwrite_existing: ``False`` 时已有的标签不覆盖（跳过并记入 ``skipped``）
    :param plain_album: 是否把豪华版专辑名并回普通专辑（``None`` = 用全局开关）
    :return: :class:`TagUpdatePlan`（dict 子类，本身就是变更摘要）
    """
    path = str(filepath or '')
    lower = path.lower()
    prepared = _prepare_info(info, plain_album=plain_album,
                             overwrite_existing=overwrite_existing)
    plan = TagUpdatePlan(path, _format_of(path), prepared, image_data,
                         lyrics_text, overwrite_existing)
    if not lower.endswith(SUPPORTED_EXTENSIONS):
        plan.skipped['*'] = '不支持的文件格式'
        return plan

    old_tags = read_audio_tags(path)
    planned = _planned_values(prepared, image_data, lyrics_text)
    for field_name, new_value in planned.items():
        if not new_value:
            # 源码语义：空的新值不写；若显式开启覆盖，源码会清掉残留的 lyricist
            continue
        old_value = old_tags.get(field_name, '')
        if field_name == 'cover':
            old_text = _cover_descriptor(old_tags.get('cover_mime'), old_tags.get('cover_size')) if old_tags.get('has_cover') else ''
        elif field_name == 'lyrics':
            old_text = old_tags.get('lyrics') or ''
        else:
            old_text = old_value if old_value not in (None, 0) else ''
        if not overwrite_existing and str(old_text or ''):
            plan.skipped[field_name] = '已有标签且未开启覆盖'
            continue
        plan.add(field_name, old_text, new_value)
    # 明确空值但覆盖开启时的清理动作（源码会删掉过期的 lyricist）
    if overwrite_existing and not prepared.get('lyricist') and old_tags.get('lyricist'):
        plan.add('lyricist', old_tags.get('lyricist'), '')
    return plan


def _format_of(filepath: str) -> str:
    """按扩展名返回格式族：``id3`` / ``m4a`` / ``vorbis`` / ``''``。"""
    lower = str(filepath or '').lower()
    if lower.endswith('.mp3'):
        return 'id3'
    if lower.endswith(('.m4a', '.mp4')):
        return 'm4a'
    if lower.endswith(('.flac', '.ogg', '.oga', '.opus')):
        return 'vorbis'
    return ''


# ==================== 💾 写标签 ====================

def _write_album_type_tags(audio, album_type, overwrite_existing=True, is_id3=False):
    """把发行类型写进中文标签编辑器常见的那几个自定义字段（照抄源码）。"""
    display_value = normalize_album_type(album_type)
    if not display_value:
        return

    if is_id3:
        for description, value in (
            ('ALBUMTYPE', display_value),
            ('Album Type', display_value),
            # [BEHAVIOR CHANGE] Release type fields now keep the Chinese display label.
            ('RELEASETYPE', display_value),
            ('MusicBrainz Album Type', display_value),
        ):
            frame_key = f'TXXX:{description}'
            if not overwrite_existing and audio.tags.getall(frame_key):
                continue
            audio.tags.delall(frame_key)
            audio.tags.add(TXXX(encoding=3, desc=description, text=[value]))
        return

    for key, value in (
        # [BEHAVIOR CHANGE] Release type fields now keep the Chinese display label.
        ('RELEASETYPE', display_value),
        ('MUSICBRAINZ_ALBUMTYPE', display_value),
        ('ALBUMTYPE', display_value),
    ):
        if key in audio and not overwrite_existing:
            continue
        audio[key] = value


def _write_tags(filepath, info, image_data=None, lyrics_text=None, overwrite_existing=True):
    """按格式写标签，返回 ``(success, error_msg)``（源码 update_audio_tags 主体）。"""
    ext = str(filepath).lower()
    info = dict(info or {})
    audio = None
    try:
        if ext.endswith('.mp3'):
            audio = MP3(filepath)
            if audio.tags is None:
                audio.add_tags()
            for tag_cls, key, val in [
                (TIT2, 'title', info.get('title')), (TPE1, 'artist', info.get('artist')),
                (TALB, 'album', info.get('album')), (TPE2, 'album_artist', info.get('album_artist')),
                (TCON, 'genre', info.get('genre')), (TDRC, 'date', info.get('date')),
                (TRCK, 'track_num', str(info['track_num']) if info.get('track_num') else None),
                (TCOM, 'composer', info.get('composer')),
                (TEXT, 'lyricist', info.get('lyricist')),
            ]:
                if not val:
                    continue
                if not overwrite_existing and audio.tags.getall(tag_cls.__name__):
                    continue
                audio.tags.delall(tag_cls.__name__)
                try:
                    audio.tags.add(tag_cls(encoding=3, text=str(val)))
                except Exception:
                    pass
            _write_album_type_tags(audio, info.get('album_type'), overwrite_existing, is_id3=True)
            if overwrite_existing and not info.get('lyricist'):
                audio.tags.delall('TEXT')
            lang = info.get('language')
            if lang:
                audio.tags.add(TLAN(encoding=3, text=lang.strip("'\"「」『』 “”‘’`")))
            # MusicBrainz 艺人 ID（Picard 同名标签）：跨专辑归并同一艺人的写法
            mbid_value = str(info.get('artist_mbid') or '').strip()
            audio.tags.delall('TXXX:MusicBrainz Artist Id')
            if mbid_value:
                audio.tags.add(TXXX(encoding=3, desc='MusicBrainz Artist Id',
                                    text=[mbid_value]))
            rg_value = str(info.get('release_group_id') or '').strip()
            audio.tags.delall('TXXX:MusicBrainz Release Group Id')
            if rg_value:
                audio.tags.add(TXXX(encoding=3, desc='MusicBrainz Release Group Id',
                                    text=[rg_value]))
            if lyrics_text:
                audio.tags.delall('USLT')
                audio.tags.add(USLT(encoding=3, lang='zho', desc='', text=lyrics_text))
            if image_data:
                if not isinstance(image_data, bytes):
                    image_data = bytes(image_data)
                audio.tags.delall('APIC')
                m = 'image/jpeg' if image_data[:4] != b'\x89PNG' else 'image/png'
                audio.tags.add(APIC(encoding=3, mime=m, type=3, desc='Cover', data=image_data))
        elif ext.endswith('.flac'):
            audio = FLAC(filepath)
            for key, info_key in [('title', 'title'), ('artist', 'artist'), ('album', 'album'),
                                  ('albumartist', 'album_artist'), ('genre', 'genre'), ('date', 'date'),
                                  ('tracknumber', 'track_num'), ('composer', 'composer'), ('lyricist', 'lyricist')]:
                val = info.get(info_key)
                if not val:
                    continue
                if key in audio and not overwrite_existing:
                    continue
                audio[key] = str(val)
            _write_album_type_tags(audio, info.get('album_type'), overwrite_existing, is_id3=False)
            lang = info.get('language')
            if lang:
                audio['language'] = lang.strip("'\"「」『』 “”‘’`")
            # MusicBrainz 艺人 ID：跨专辑归并同一艺人的写法
            audio.pop('musicbrainz_artistid', None)
            if str(info.get('artist_mbid') or '').strip():
                audio['musicbrainz_artistid'] = [str(info['artist_mbid']).strip()]
            audio.pop('musicbrainz_releasegroupid', None)
            if str(info.get('release_group_id') or '').strip():
                audio['musicbrainz_releasegroupid'] = [str(info['release_group_id']).strip()]
            if overwrite_existing and not info.get('lyricist'):
                audio.pop('lyricist', None)
            if lyrics_text:
                try:
                    audio['lyrics'] = lyrics_text
                except Exception:
                    pass
            if image_data:
                if not isinstance(image_data, bytes):
                    image_data = bytes(image_data)
                audio.clear_pictures()
                pic = Picture()
                pic.data = image_data
                pic.mime = 'image/jpeg' if image_data[:4] != b'\x89PNG' else 'image/png'
                pic.type = 3
                audio.add_picture(pic)
        elif ext.endswith('.m4a') or ext.endswith('.mp4'):
            from mutagen.mp4 import MP4 as MP4_local
            from mutagen.mp4 import MP4Cover, MP4FreeForm
            audio = MP4_local(filepath)
            if audio.tags is None:
                audio.add_tags()

            def _freeform(value):
                return MP4FreeForm(str(value).encode('utf-8'))

            basic_atoms = {
                '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album',
                'aART': 'album_artist', '\xa9gen': 'genre', '\xa9day': 'date',
            }
            for atom, info_key in basic_atoms.items():
                val = info.get(info_key)
                if not val:
                    continue
                if atom in audio.tags and not overwrite_existing:
                    continue
                audio.tags[atom] = [str(val)]

            track_num = int(info.get('track_num') or 0)
            total_tracks = int(info.get('total_tracks') or 0)
            if track_num > 0 and (overwrite_existing or 'trkn' not in audio.tags):
                audio.tags['trkn'] = [(track_num, total_tracks)]
            composer = info.get('composer')
            if composer and (overwrite_existing or '\xa9wrt' not in audio.tags):
                audio.tags['\xa9wrt'] = [str(composer)]

            custom_atoms = {
                'LYRICIST': info.get('lyricist'),
                'LANGUAGE': info.get('language'),
                'MusicBrainz Artist Id': info.get('artist_mbid'),
                'MusicBrainz Release Group Id': info.get('release_group_id'),
            }
            for name, val in custom_atoms.items():
                if not val:
                    continue
                if overwrite_existing or f'----:com.apple.iTunes:{name}' not in audio.tags:
                    audio.tags[f'----:com.apple.iTunes:{name}'] = [_freeform(val)]
            album_type = normalize_album_type(info.get('album_type')) or str(info.get('album_type') or '')
            if album_type:
                # [BEHAVIOR CHANGE] Release type atoms now keep the Chinese display label.
                for name in ('ALBUMTYPE', 'RELEASETYPE', 'MUSICBRAINZ_ALBUMTYPE'):
                    value = album_type
                    if not value:
                        continue
                    key = f'----:com.apple.iTunes:{name}'
                    if overwrite_existing or key not in audio.tags:
                        audio.tags[key] = [_freeform(value)]

            if lyrics_text:
                if overwrite_existing or '\xa9lyr' not in audio.tags:
                    audio.tags['\xa9lyr'] = [str(lyrics_text)]

            if image_data:
                if not isinstance(image_data, bytes):
                    image_data = bytes(image_data)
                cover_format = MP4Cover.FORMAT_PNG if image_data[:4] == b'\x89PNG' else MP4Cover.FORMAT_JPEG
                audio.tags['covr'] = [MP4Cover(data=image_data, imageformat=cover_format)]
        elif ext.endswith(('.ogg', '.oga', '.opus')):
            audio = _open_vorbis_audio(filepath)
            for key, info_key in [('title', 'title'), ('artist', 'artist'), ('album', 'album'),
                                  ('albumartist', 'album_artist'), ('genre', 'genre'),
                                  ('date', 'date'), ('tracknumber', 'track_num'),
                                  ('composer', 'composer'), ('lyricist', 'lyricist')]:
                val = info.get(info_key)
                if not val:
                    continue
                if key in audio and not overwrite_existing:
                    continue
                audio[key] = str(val)
            _write_album_type_tags(audio, info.get('album_type'), overwrite_existing, is_id3=False)
            lang = info.get('language')
            if lang:
                audio['language'] = str(lang).strip("'\"「」『』 “”‘’`")
            audio.pop('musicbrainz_artistid', None)
            if str(info.get('artist_mbid') or '').strip():
                audio['musicbrainz_artistid'] = [str(info['artist_mbid']).strip()]
            audio.pop('musicbrainz_releasegroupid', None)
            if str(info.get('release_group_id') or '').strip():
                audio['musicbrainz_releasegroupid'] = [str(info['release_group_id']).strip()]
            if lyrics_text:
                audio['lyrics'] = lyrics_text
            if overwrite_existing and not info.get('lyricist'):
                audio.pop('lyricist', None)
            if image_data:
                if not isinstance(image_data, bytes):
                    image_data = bytes(image_data)
                pic = Picture()
                pic.data = image_data
                pic.mime = 'image/jpeg' if image_data[:4] != b'\x89PNG' else 'image/png'
                pic.type = 3
                audio['metadata_block_picture'] = [base64.b64encode(pic.write()).decode('ascii')]
        else:
            return False, "不支持的文件格式"
        # 保存 — 默认方式，失败后等 0.5s 重试一次
        for attempt in range(2):
            try:
                audio.save()
                return True, None
            except Exception:
                if attempt == 0:
                    time.sleep(0.5)
        return False, "保存失败（文件可能被占用或只读）"
    except Exception as e:
        return False, str(e)[:500]


def apply_tag_update(plan, filepath=None):
    """按 :func:`plan_tag_update` 的结果落盘。

    :param plan: :class:`TagUpdatePlan`（或等价的 dict + ``filepath`` 参数）
    :param filepath: 当 ``plan`` 是普通 dict 时必须显式给出文件路径
    :return: ``(success, error_msg)``
    """
    if isinstance(plan, TagUpdatePlan):
        path = filepath or plan.filepath
        info = plan.info
        image_data = plan.image_data
        lyrics_text = plan.lyrics_text
        overwrite_existing = plan.overwrite_existing
    else:
        path = filepath
        info = dict(plan or {}).get('info') or {}
        image_data = None
        lyrics_text = None
        overwrite_existing = True
    if not path:
        return False, "缺少文件路径"
    return _write_tags(path, info, image_data=image_data, lyrics_text=lyrics_text,
                       overwrite_existing=overwrite_existing)


def update_audio_tags(filepath, info, image_data=None, lyrics_text=None,
                      overwrite_existing=True, plain_album=None, dry_run=False):
    """将元数据写入音频文件 (MP3/M4A/FLAC/OGG/Opus)，返回 ``(success, error_msg)``。

    照抄源码同名函数的字段映射；唯一增强是 ``dry_run``：

    * ``dry_run=True`` → **不写盘**，返回 :class:`TagUpdatePlan`
      （``{字段: {'old': 旧值, 'new': 新值}}`` 变更摘要），供预览/确认
    * ``dry_run=False``（默认）→ 写盘，返回 ``(success, error_msg)``，与源码一致

    :param filepath: 音频文件路径
    :param info: 元数据字典（title/artist/album/album_artist/genre/date/track_num/
        composer/lyricist/language/artist_mbid/release_group_id/album_type 等）
    :param image_data: 封面图片字节（可选）
    :param lyrics_text: 歌词文本（可选）
    :param overwrite_existing: ``False`` 时保留已有标签
    :param plain_album: 是否把豪华版专辑名并回普通专辑（``None`` = 全局开关）
    :param dry_run: 只预演不落盘
    """
    plan = plan_tag_update(filepath, info, image_data=image_data,
                           lyrics_text=lyrics_text,
                           overwrite_existing=overwrite_existing,
                           plain_album=plain_album)
    if dry_run:
        return plan
    if plan.skipped.get('*'):
        return False, plan.skipped['*']
    return apply_tag_update(plan)


# ==================== 🔧 歌手标签归一（整理流程复用） ====================

def _normalize_vorbis_artist_tags(audio):
    """就地改写 artist / albumartist 两条 Vorbis comment；有改动返回 True。"""
    changed = False
    for key in ('artist', 'albumartist'):
        values = audio.get(key) or []
        if not values:
            continue
        text = str(values[0])
        fixed = normalize_artist_credit(text)
        if fixed and fixed != text:
            audio[key] = [fixed]
            changed = True
    return changed


def normalize_audio_artist_tags(filepath):
    """把单个音频文件的歌手标签改成 ``A & B`` 写法（多歌手归一）。

    覆盖刮削会写到的全部格式（mp3 / flac / m4a / ogg / opus），同时修正曲目歌手
    与专辑歌手两个字段；真的改动了才返回 ``True``（源码同名函数）。
    """
    path = str(filepath or '')
    lower = path.lower()
    changed = False
    try:
        if lower.endswith('.mp3'):
            audio = ID3(path)
            for frame_id in ('TPE1', 'TPE2'):
                for frame in audio.getall(frame_id):
                    text = frame.text[0] if frame.text else ''
                    fixed = normalize_artist_credit(text)
                    if fixed and fixed != text:
                        frame.text = [fixed]
                        changed = True
            if changed:
                audio.save()
        elif lower.endswith('.flac'):
            audio = FLAC(path)
            changed = _normalize_vorbis_artist_tags(audio)
            if changed:
                audio.save()
        elif lower.endswith(('.m4a', '.mp4')):
            from mutagen.mp4 import MP4
            audio = MP4(path)
            if audio.tags is not None:
                for atom in ('\xa9ART', 'aART'):
                    values = audio.tags.get(atom) or []
                    if not values:
                        continue
                    text = str(values[0])
                    fixed = normalize_artist_credit(text)
                    if fixed and fixed != text:
                        audio.tags[atom] = [fixed]
                        changed = True
                if changed:
                    audio.save()
        elif lower.endswith(('.ogg', '.oga', '.opus')):
            audio = _open_vorbis_audio(path)
            changed = _normalize_vorbis_artist_tags(audio)
            if changed:
                audio.save()
    except Exception:
        return False
    return changed
