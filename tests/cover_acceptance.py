"""Real cover-image acceptance checks, shared by the HTTP end-to-end test.

Pillow is only a test dependency. Its AVIF decoder verifies the returned pixels,
so a JPEG renamed to .avif or a correct-looking MIME header cannot pass.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
from typing import Callable

import requests
from mutagen.flac import FLAC, Picture
from PIL import Image


PNG_TRACK = "中文/周杰伦/魔杰座/01 - 稻香.flac"
JPEG_TRACK = "中文/周杰伦/魔杰座/02 - 说好的幸福呢.flac"


def image_bytes(kind: str, size: tuple[int, int], *, alternate: bool = False) -> bytes:
    """Generate decodable artwork with a known aspect ratio and alpha channel."""
    if kind == "PNG":
        image = Image.new("RGBA", size, (184, 58, 102, 0))
        image.paste((32, 140, 81, 255) if alternate else (44, 92, 183, 255),
                    (size[0] // 2, 0, size[0], size[1]))
    else:
        image = Image.new("RGB", size, (184, 134, 48))
        image.paste((45, 86, 62), (size[0] // 2, 0, size[0], size[1]))
    output = io.BytesIO()
    image.save(output, format=kind)
    return output.getvalue()


def replace_cover(path: Path, content: bytes, mime: str, size: tuple[int, int]) -> None:
    audio = FLAC(str(path))
    picture = Picture()
    picture.type = 3  # Front cover.
    picture.mime = mime
    picture.width, picture.height = size
    picture.depth = 32 if mime == "image/png" else 24
    picture.data = content
    audio.clear_pictures()
    audio.add_picture(picture)
    audio.save()


def seed_cover_fixtures(music: Path) -> None:
    """Embed two artworks without adding tracks or changing text metadata."""
    replace_cover(music / PNG_TRACK, image_bytes("PNG", (640, 320)), "image/png", (640, 320))
    replace_cover(music / JPEG_TRACK, image_bytes("JPEG", (32, 20)), "image/jpeg", (32, 20))


def check_covers(
    base: str,
    rows: list[dict],
    data_dir: Path,
    check: Callable[[str, bool, str], None],
    wait_job: Callable[[str], dict],
) -> None:
    png_track = next(row for row in rows if row["title"] == "稻香")
    jpeg_track = next(row for row in rows if row["title"] == "说好的幸福呢")
    png_path = Path(png_track["path"])
    original_audio_hash = hashlib.sha256(png_path.read_bytes()).digest()
    original_png = FLAC(str(png_path)).pictures[0].data
    original_jpeg = FLAC(jpeg_track["path"]).pictures[0].data
    png_url = f"{base}/api/tracks/{png_track['id']}/cover"
    jpeg_url = f"{base}/api/tracks/{jpeg_track['id']}/cover"

    def get(url: str, size: int) -> requests.Response:
        return requests.get(url, params={"size": size}, timeout=60)

    def verify_avif(response: requests.Response, label: str, size: tuple[int, int]) -> Image.Image | None:
        mime = response.headers.get("content-type", "").split(";")[0]
        check(f"{label}：HTTP 与 AVIF 类型", response.status_code == 200 and mime == "image/avif",
              f"HTTP {response.status_code}, Content-Type={mime}")
        if response.status_code != 200:
            return None
        try:
            picture = Image.open(io.BytesIO(response.content))
            picture.load()
            check(f"{label}：真正 AVIF 解码与尺寸", picture.format == "AVIF" and picture.size == size,
                  f"format={picture.format}, size={picture.size}, bytes={len(response.content)}")
            return picture if picture.format == "AVIF" and picture.size == size else None
        except Exception as error:
            check(f"{label}：真正 AVIF 解码与尺寸", False, str(error))
            return None

    # Old releases stored full-sized bytes in <id>.jpg, even when the bytes were PNG.
    # That legacy cache must not be returned as the new AVIF derivative.
    thumbs = data_dir / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    (thumbs / f"{png_track['id']}.jpg").write_bytes(original_png)

    thumb = get(png_url, 48)
    decoded = verify_avif(thumb, "PNG 封面缩略图", (128, 64))
    if decoded is not None:
        rgba = decoded.convert("RGBA")
        check("AVIF 缩略图保留透明度", rgba.getpixel((4, 4))[3] <= 5 and rgba.getpixel((120, 4))[3] >= 250,
              f"alpha={rgba.getpixel((4, 4))[3]}/{rgba.getpixel((120, 4))[3]}")

    cache = thumbs / f"{png_track['id']}-128.avif"
    cache_exists = cache.exists()
    check("AVIF 缩略图缓存真实落盘", cache_exists and cache.read_bytes() == thumb.content,
          str(cache.relative_to(data_dir)))
    before_mtime = cache.stat().st_mtime_ns if cache_exists else None
    again = get(png_url, 128)
    same_bucket = get(png_url, 64)
    check("相同尺寸桶重复请求复用缓存",
          again.status_code == 200 and same_bucket.status_code == 200
          and again.content == thumb.content == same_bucket.content
          and cache.exists() and before_mtime == cache.stat().st_mtime_ns,
          "48/64/128 共享 128px 缓存，文件写入时间不变")

    verify_avif(get(png_url, 129), "256px 尺寸桶", (256, 128))
    verify_avif(get(png_url, 300), "512px 尺寸桶", (512, 256))
    verify_avif(get(jpeg_url, 128), "小图不放大", (32, 20))

    for url, content, mime in ((png_url, original_png, "image/png"), (jpeg_url, original_jpeg, "image/jpeg")):
        first = get(url, 0)
        cached = get(url, 0)
        check(f"原图保留字节与正确类型 {mime}",
              first.status_code == cached.status_code == 200 and first.content == cached.content == content
              and first.headers.get("content-type", "").split(";")[0] == mime
              and cached.headers.get("content-type", "").split(";")[0] == mime,
              f"首次读取与缓存读取一致，{len(content)} 字节")
    check("读取缩略图未修改音频文件", hashlib.sha256(png_path.read_bytes()).digest() == original_audio_hash, "FLAC 字节完全一致")

    for invalid_size in (-1, 513):
        response = get(png_url, invalid_size)
        check(f"拒绝非法缩略图尺寸 {invalid_size}", response.status_code == 422, f"HTTP {response.status_code}")

    # Replacing an embedded image and updating the index must invalidate both
    # the original cache and its derivatives, not return the previous landscape.
    previous_stat = png_path.stat()
    replacement = image_bytes("PNG", (320, 640), alternate=True)
    replace_cover(png_path, replacement, "image/png", (320, 640))
    os.utime(png_path, ns=(previous_stat.st_atime_ns, max(png_path.stat().st_mtime_ns, previous_stat.st_mtime_ns + 2_000_000_000)))
    scan = requests.post(f"{base}/api/scan", json={"full": True, "fast": False}, timeout=30)
    scan.raise_for_status()
    scanned = wait_job(scan.json()["job_id"])
    check("更换封面后扫描更新索引", scanned["state"] == "done", scanned.get("message", ""))
    updated = get(png_url, 128)
    verify_avif(updated, "封面变化后重新生成", (64, 128))
    check("封面变化后缓存被替换", updated.content != thumb.content and cache.exists() and cache.read_bytes() == updated.content,
          "横图替换为竖图，缓存内容随之更新")
    updated_original = get(png_url, 0)
    check("原图缓存随封面变化更新", updated_original.status_code == 200 and updated_original.content == replacement
          and updated_original.headers.get("content-type", "").split(";")[0] == "image/png", "返回新 PNG 原始字节")
