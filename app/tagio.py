"""音频标签读写层（自带实现，覆盖 mp3 / flac / m4a / ogg-opus）。

为什么自带实现：标签读写是功能 1（元数据编辑）和功能 3（整理移动）的地基，
必须能独立测试、行为可预测。字段映射沿用旧项目的映射表，保证迁移过来的歌不会串味。

对外接口
--------
- `read_tags(path) -> dict`           读回全部字段（含 has_cover / has_lyrics / duration）
- `read_cover(path) -> bytes | None`  取内嵌封面原图
- `preview_update(path, desired) -> dict`  只算不写，返回 {field: {old, new}}
- `apply_update(path, desired, cover=None, lyrics=None, overwrite=True) -> dict`  真正写盘
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path

log = logging.getLogger("metatidy.tagio")

ALL_FIELDS = (
    "title",
    "artist",
    "album",
    "albumartist",
    "genre",
    "year",
    "track",
    "disc",
    "language",
    "composer",
    "lyricist",
    "copyright",
    "albumtype",
    "comment",
    "mb_artist_id",
    "release_group_id",
)

SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus"}

# ---- MP3 (ID3) 帧映射 -------------------------------------------------------
MP3_FRAMES = {
    "title": "TIT2",
    "artist": "TPE1",
    "album": "TALB",
    "albumartist": "TPE2",
    "genre": "TCON",
    "year": "TDRC",
    "track": "TRCK",
    "disc": "TPOS",
    "language": "TLAN",
    "composer": "TCOM",
    "lyricist": "TEXT",
    "copyright": "TCOP",
}
MP3_TXXX = {
    "albumtype": "ALBUMTYPE",
    "mb_artist_id": "MusicBrainz Artist Id",
    "release_group_id": "MusicBrainz Release Group Id",
}

# ---- Vorbis (flac / ogg / opus) 键映射 --------------------------------------
VORBIS_KEYS = {
    "title": "title",
    "artist": "artist",
    "album": "album",
    "albumartist": "albumartist",
    "genre": "genre",
    "year": "date",
    "track": "tracknumber",
    "disc": "discnumber",
    "language": "language",
    "composer": "composer",
    "lyricist": "lyricist",
    "copyright": "copyright",
    "albumtype": "albumtype",
    "comment": "comment",
    "mb_artist_id": "musicbrainz_artistid",
    "release_group_id": "musicbrainz_releasegroupid",
}
VORBIS_LYRICS_KEYS = ("lyrics", "LYRICS", "unsyncedlyrics", "UNSYNCEDLYRICS")

# ---- MP4 / M4A 原子映射 -----------------------------------------------------
MP4_ATOMS = {
    "title": "\xa9nam",
    "artist": "\xa9ART",
    "album": "\xa9alb",
    "albumartist": "aART",
    "genre": "\xa9gen",
    "year": "\xa9day",
    "composer": "\xa9wrt",
    "copyright": "cprt",
    "comment": "\xa9cmt",
}
MP4_FREEFORM = {
    "lyricist": "LYRICIST",
    "language": "LANGUAGE",
    "albumtype": "ALBUMTYPE",
    "mb_artist_id": "MusicBrainz Artist Id",
    "release_group_id": "MusicBrainz Release Group Id",
}
MP4_LYRICS_ATOMS = ("\xa9lyr", "©lyr")


class TagError(RuntimeError):
    """标签读写失败。"""


def _ext(path: str | Path) -> str:
    return Path(path).suffix.lower()


def is_supported(path: str | Path) -> bool:
    return _ext(path) in SUPPORTED_EXTENSIONS


def _clean(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " / ".join(str(v) for v in value if str(v).strip())
    return str(value).strip()


def _first(value) -> str:
    if isinstance(value, (list, tuple)):
        return _clean(value[0]) if value else ""
    return _clean(value)


# --------------------------------------------------------------------------- 读


def read_tags(path: str | Path) -> dict:
    """读回一条曲目在磁盘上的真实标签。任何解析失败都返回空字段而不是抛异常。"""
    p = Path(path)
    out: dict = {k: "" for k in ALL_FIELDS}
    out.update({"has_cover": 0, "has_lyrics": 0, "duration": 0.0, "format": _ext(p).lstrip(".")})
    if not p.exists():
        out["error"] = "文件不存在"
        return out
    ext = _ext(p)
    try:
        if ext == ".mp3":
            _read_mp3(p, out)
        elif ext == ".flac":
            _read_flac(p, out)
        elif ext == ".m4a":
            _read_mp4(p, out)
        elif ext in {".ogg", ".oga", ".opus"}:
            _read_vorbis(p, out)
        else:
            out["error"] = f"不支持的格式 {ext}"
    except Exception as exc:  # noqa: BLE001 —— 单个坏文件不能拖垮扫描
        log.warning("读取标签失败 %s: %s", p, exc)
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def _read_mp3(p: Path, out: dict) -> None:
    from mutagen.id3 import ID3, ID3NoHeaderError
    from mutagen.mp3 import MP3

    audio = MP3(str(p))
    out["duration"] = float(audio.info.length or 0)
    try:
        tags = ID3(str(p))
    except ID3NoHeaderError:
        return
    for key, frame in MP3_FRAMES.items():
        if frame in tags:
            out[key] = _first(tags[frame].text)
    for key, desc in MP3_TXXX.items():
        frame = tags.get(f"TXXX:{desc}")
        if frame is not None:
            out[key] = _first(frame.text)
    comm = tags.get("COMM::XXX") or tags.get("COMM:")
    if comm is not None:
        out["comment"] = _clean(getattr(comm, "text", ""))
    if tags.getall("APIC"):
        out["has_cover"] = 1
    if tags.getall("USLT"):
        out["has_lyrics"] = 1


def _read_flac(p: Path, out: dict) -> None:
    from mutagen.flac import FLAC

    audio = FLAC(str(p))
    out["duration"] = float(audio.info.length or 0)
    for key, vkey in VORBIS_KEYS.items():
        if vkey in audio:
            out[key] = _first(audio[vkey])
    for lk in VORBIS_LYRICS_KEYS:
        if lk in audio:
            out["has_lyrics"] = 1
            break
    if audio.pictures:
        out["has_cover"] = 1


def _read_vorbis(p: Path, out: dict) -> None:
    ext = _ext(p)
    if ext == ".opus":
        from mutagen.oggopus import OggOpus as _Audio
    else:
        from mutagen.oggvorbis import OggVorbis as _Audio

    audio = _Audio(str(p))
    out["duration"] = float(audio.info.length or 0)
    for key, vkey in VORBIS_KEYS.items():
        if vkey in audio:
            out[key] = _first(audio[vkey])
    for lk in VORBIS_LYRICS_KEYS:
        if lk in audio:
            out["has_lyrics"] = 1
            break
    if "metadata_block_picture" in audio:
        out["has_cover"] = 1


def _read_mp4(p: Path, out: dict) -> None:
    from mutagen.mp4 import MP4

    audio = MP4(str(p))
    out["duration"] = float(audio.info.length or 0)
    tags = audio.tags or {}
    for key, atom in MP4_ATOMS.items():
        if atom in tags:
            out[key] = _first(tags[atom])
    if "trkn" in tags and tags["trkn"]:
        pair = tags["trkn"][0]
        out["track"] = str(pair[0]) if pair and pair[0] else ""
    if "disk" in tags and tags["disk"]:
        pair = tags["disk"][0]
        out["disc"] = str(pair[0]) if pair and pair[0] else ""
    for key, name in MP4_FREEFORM.items():
        atom = f"----:com.apple.iTunes:{name}"
        if atom in tags:
            raw = tags[atom]
            try:
                out[key] = _first([v.decode("utf-8", "ignore") if isinstance(v, bytes) else v for v in raw])
            except Exception:
                out[key] = _clean(raw)
    for atom in MP4_LYRICS_ATOMS:
        if atom in tags:
            out["has_lyrics"] = 1
            break
    if "covr" in tags and tags["covr"]:
        out["has_cover"] = 1


def read_cover(path: str | Path) -> tuple[bytes, str] | None:
    """取内嵌封面原图，返回 (字节, mime)；没有封面返回 None。"""
    p = Path(path)
    if not p.exists():
        return None
    ext = _ext(p)
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, ID3NoHeaderError

            try:
                tags = ID3(str(p))
            except ID3NoHeaderError:
                return None
            pics = tags.getall("APIC")
            if pics:
                return bytes(pics[0].data), pics[0].mime or "image/jpeg"
        elif ext == ".flac":
            from mutagen.flac import FLAC

            audio = FLAC(str(p))
            if audio.pictures:
                pic = audio.pictures[0]
                return bytes(pic.data), pic.mime or "image/jpeg"
        elif ext in {".ogg", ".oga", ".opus"}:
            import struct

            from mutagen.flac import Picture
            from mutagen.oggvorbis import OggVorbis

            audio = OggVorbis(str(p)) if ext != ".opus" else __import__("mutagen.oggopus", fromlist=["OggOpus"]).OggOpus(str(p))
            blocks = audio.get("metadata_block_picture")
            if blocks:
                data = base64.b64decode(blocks[0])
                pic = Picture(data)
                return bytes(pic.data), pic.mime or "image/jpeg"
            _ = struct  # pragma: no cover
        elif ext == ".m4a":
            from mutagen.mp4 import MP4

            audio = MP4(str(p))
            covr = (audio.tags or {}).get("covr")
            if covr:
                image = covr[0]
                mime = "image/png" if getattr(image, "imageformat", 0) == 14 else "image/jpeg"
                return bytes(image), mime
    except Exception as exc:  # noqa: BLE001
        log.warning("读取封面失败 %s: %s", p, exc)
    return None


def read_lyrics(path: str | Path) -> str:
    """读回内嵌歌词（没有则空串）。"""
    p = Path(path)
    if not p.exists():
        return ""
    ext = _ext(p)
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, ID3NoHeaderError

            try:
                tags = ID3(str(p))
            except ID3NoHeaderError:
                return ""
            frames = tags.getall("USLT")
            return _clean(frames[0].text) if frames else ""
        if ext == ".flac":
            from mutagen.flac import FLAC

            audio = FLAC(str(p))
            for k in VORBIS_LYRICS_KEYS:
                if k in audio:
                    return _first(audio[k])
        if ext in {".ogg", ".oga", ".opus"}:
            if ext == ".opus":
                from mutagen.oggopus import OggOpus as _A
            else:
                from mutagen.oggvorbis import OggVorbis as _A

            audio = _A(str(p))
            for k in VORBIS_LYRICS_KEYS:
                if k in audio:
                    return _first(audio[k])
        if ext == ".m4a":
            from mutagen.mp4 import MP4

            tags = MP4(str(p)).tags or {}
            for atom in MP4_LYRICS_ATOMS:
                if atom in tags:
                    return _first(tags[atom])
    except Exception as exc:  # noqa: BLE001
        log.warning("读取歌词失败 %s: %s", p, exc)
    return ""


# --------------------------------------------------------------------------- 写


def preview_update(path: str | Path, desired: dict) -> dict:
    """只算不写：返回 {field: {'old':..., 'new':...}}，仅包含真正会变化的字段。"""
    current = read_tags(path)
    diff: dict[str, dict[str, str]] = {}
    for key in ALL_FIELDS:
        if key not in desired:
            continue
        new_val = _clean(desired.get(key))
        old_val = _clean(current.get(key))
        if new_val == "" and old_val == "":
            continue
        if new_val == old_val:
            continue
        diff[key] = {"old": old_val, "new": new_val}
    return {"path": str(path), "changes": diff, "count": len(diff), "current": current}


def apply_update(
    path: str | Path,
    desired: dict,
    *,
    cover: bytes | None = None,
    cover_mime: str = "image/jpeg",
    lyrics: str | None = None,
    overwrite: bool = True,
    dry_run: bool = False,
) -> dict:
    """把 desired 里的字段写进文件。overwrite=False 时跳过已有非空值的字段。"""
    p = Path(path)
    if dry_run:
        return preview_update(p, desired)
    ext = _ext(p)
    if ext not in SUPPORTED_EXTENSIONS:
        raise TagError(f"不支持的格式：{ext}")
    plan = preview_update(p, desired)
    to_write = {k: _clean(desired.get(k)) for k in desired if k in ALL_FIELDS}
    if not overwrite:
        current = plan["current"]
        to_write = {k: v for k, v in to_write.items() if not _clean(current.get(k))}

    try:
        if ext == ".mp3":
            _write_mp3(p, to_write, cover, cover_mime, lyrics, overwrite)
        elif ext == ".flac":
            _write_flac(p, to_write, cover, cover_mime, lyrics, overwrite)
        elif ext in {".ogg", ".oga", ".opus"}:
            _write_vorbis(p, to_write, cover, cover_mime, lyrics, overwrite)
        elif ext == ".m4a":
            _write_mp4(p, to_write, cover, cover_mime, lyrics, overwrite)
    except Exception as exc:
        raise TagError(f"写入标签失败 {p.name}: {exc}") from exc

    return {"path": str(p), "changes": plan["changes"], "count": plan["count"], "written": sorted(to_write)}


def _write_mp3(p: Path, values: dict, cover: bytes | None, mime: str, lyrics: str | None, overwrite: bool) -> None:
    from mutagen.id3 import APIC, COMM, ID3, TALB, TCOM, TCON, TCOP, TDRC, TEXT, TIT2, TLAN, TPE1, TPE2, TPOS, TRCK, TXXX, USLT
    from mutagen.id3 import ID3NoHeaderError

    try:
        tags = ID3(str(p))
    except ID3NoHeaderError:
        tags = ID3()

    frame_cls = {
        "title": TIT2,
        "artist": TPE1,
        "album": TALB,
        "albumartist": TPE2,
        "genre": TCON,
        "year": TDRC,
        "track": TRCK,
        "disc": TPOS,
        "language": TLAN,
        "composer": TCOM,
        "lyricist": TEXT,
        "copyright": TCOP,
    }
    for key, value in values.items():
        if value == "":
            continue
        if key in frame_cls:
            tags.setall(frame_cls[key].__name__, [frame_cls[key](encoding=3, text=[value])])
        elif key in MP3_TXXX:
            desc = MP3_TXXX[key]
            existing = tags.get(f"TXXX:{desc}")
            if existing is not None and not overwrite and _first(existing.text):
                continue
            tags.setall("TXXX", [TXXX(encoding=3, desc=desc, text=[value])])
        elif key == "comment":
            tags.setall("COMM", [COMM(encoding=3, lang="XXX", desc="", text=[value])])

    if lyrics:
        tags.setall("USLT", [USLT(encoding=3, lang="XXX", desc="", text=lyrics)])
    if cover:
        has_pic = bool(tags.getall("APIC"))
        if not has_pic or overwrite:
            tags.setall("APIC", [APIC(encoding=3, mime=mime, type=3, desc="Cover", data=cover)])
    tags.save(str(p), v2_version=3)


def _write_flac(p: Path, values: dict, cover: bytes | None, mime: str, lyrics: str | None, overwrite: bool) -> None:
    from mutagen.flac import FLAC, Picture

    audio = FLAC(str(p))
    for key, value in values.items():
        vkey = VORBIS_KEYS.get(key)
        if not vkey or value == "":
            continue
        if not overwrite and audio.get(vkey):
            continue
        audio[vkey] = [value]
    if lyrics:
        audio["lyrics"] = [lyrics]
    if cover and (not audio.pictures or overwrite):
        pic = Picture()
        pic.type = 3
        pic.mime = mime
        pic.desc = "Cover"
        pic.data = cover
        audio.clear_pictures()
        audio.add_picture(pic)
    audio.save()


def _write_vorbis(p: Path, values: dict, cover: bytes | None, mime: str, lyrics: str | None, overwrite: bool) -> None:
    if _ext(p) == ".opus":
        from mutagen.oggopus import OggOpus as _A
    else:
        from mutagen.oggvorbis import OggVorbis as _A

    audio = _A(str(p))
    for key, value in values.items():
        vkey = VORBIS_KEYS.get(key)
        if not vkey or value == "":
            continue
        if not overwrite and audio.get(vkey):
            continue
        audio[vkey] = [value]
    if lyrics:
        audio["lyrics"] = [lyrics]
    if cover and (not audio.get("metadata_block_picture") or overwrite):
        from mutagen.flac import Picture

        pic = Picture()
        pic.type = 3
        pic.mime = mime
        pic.desc = "Cover"
        pic.data = cover
        audio["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
    audio.save()


def _write_mp4(p: Path, values: dict, cover: bytes | None, mime: str, lyrics: str | None, overwrite: bool) -> None:
    from mutagen.mp4 import MP4, MP4Cover

    audio = MP4(str(p))
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    for key, value in values.items():
        if value == "":
            continue
        if key in MP4_ATOMS:
            tags[MP4_ATOMS[key]] = [value]
        elif key == "track":
            num = int("".join(ch for ch in value if ch.isdigit()) or 0)
            total = tags.get("trkn", [(0, 0)])[0][1]
            tags["trkn"] = [(num, total)]
        elif key == "disc":
            num = int("".join(ch for ch in value if ch.isdigit()) or 0)
            total = tags.get("disk", [(0, 0)])[0][1]
            tags["disk"] = [(num, total)]
        elif key in MP4_FREEFORM:
            atom = f"----:com.apple.iTunes:{MP4_FREEFORM[key]}"
            if not overwrite and atom in tags:
                continue
            tags[atom] = [value.encode("utf-8")]
    if lyrics:
        tags["\xa9lyr"] = [lyrics]
    if cover and (not tags.get("covr") or overwrite):
        fmt = MP4Cover.FORMAT_PNG if mime.endswith("png") else MP4Cover.FORMAT_JPEG
        tags["covr"] = [MP4Cover(cover, imageformat=fmt)]
    audio.save()
