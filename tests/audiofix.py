"""合成音频样本工具（测试用，不依赖任何编码器）。"""

from __future__ import annotations

import struct
from pathlib import Path


def make_flac(path: Path) -> Path:
    """只有 STREAMINFO、没有音频帧的 FLAC。"""
    streaminfo = struct.pack(">HH", 4096, 4096)
    streaminfo += b"\x00\x00\x00" + b"\x00\x00\x00"
    packed = (44100 << 44) | ((2 - 1) << 41) | ((16 - 1) << 36) | 0
    streaminfo += packed.to_bytes(8, "big")
    streaminfo += b"\x00" * 16
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fLaC" + bytes([0x80]) + b"\x00\x00\x22" + streaminfo)
    return path


def make_mp3(path: Path, frames: int = 8) -> Path:
    """若干帧静音 MPEG-1 Layer III（128kbps / 44.1kHz）。"""
    frame = b"\xff\xfb\x90\x00" + b"\x00" * (417 - 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(frame * frames)
    return path
