"""Check authenticated storage reports, exact cache counts and probe cleanup."""
from pathlib import Path

import requests


def check_storage(base, data_dir: Path, music_dir: Path, check) -> None:
    response = requests.get(f"{base}/api/storage", timeout=30)
    response.raise_for_status()
    report = response.json()
    check("存储诊断准确标明 PostgreSQL 与缓存用途",
          report["database"]["engine"] == "PostgreSQL" and report["database"]["connected"]
          and "应用设置" in report["database"]["stores"]
          and report["cache"]["format"] == "AVIF" and report["cache"]["on_demand"]
          and Path(report["music"]["path"]) == music_dir,
          "无虚构 SQLite 配置文件路径")
    check("只读存储诊断不创建缓存目录",
          not (data_dir / "covers").exists() and not (data_dir / "thumbs").exists()
          and report["write_checks"] is None,
          "首次读取保持空数据目录")
    wire = response.text.lower()
    check("存储诊断不回显连接串或登录密钥",
          all(value not in wire for value in ("postgres://", "postgresql://", "redis://", "database_url", "password")))

    probe = requests.post(f"{base}/api/storage/check", timeout=30)
    probe.raise_for_status()
    checked = probe.json()
    check("显式写权限检测覆盖数据根及两类缓存",
          len(checked["write_checks"]) == 3 and all(item["state"] == "ok" for item in checked["write_checks"]))
    check("写权限检测清理所有临时文件", not list(data_dir.rglob(".metatidy-probe-*")))

    # A path occupied by a regular file is a reliable permission/setup failure
    # fixture, including when CI itself runs as root.
    thumbs = data_dir / "thumbs"
    thumbs.rmdir()
    thumbs.write_bytes(b"keep existing data")
    try:
        failed = requests.post(f"{base}/api/storage/check", timeout=30).json()
        result = next(item for item in failed["write_checks"] if Path(item["path"]) == thumbs)
        check("缓存目录不可写时给出失败原因并保留原文件",
              result["state"] == "error" and bool(result["error"])
              and thumbs.read_bytes() == b"keep existing data")
    finally:
        thumbs.unlink()
        thumbs.mkdir()


def check_cache_totals(base, data_dir: Path, check) -> None:
    report = requests.get(f"{base}/api/storage", timeout=30).json()
    for name, directory in (("originals", "covers"), ("thumbnails", "thumbs")):
        images = [path for path in (data_dir / directory).iterdir()
                  if path.is_file() and path.suffix in {".avif", ".original", ".jpg", ".jpeg", ".png", ".webp", ".gif"}]
        stats = report["cache"][name]
        check(f"缓存统计与磁盘一致：{directory}",
              stats["files"] == len(images) and stats["bytes"] == sum(path.stat().st_size for path in images)
              and not stats["truncated"] and not stats["error"],
              f"{stats['files']} images, {stats['bytes']} bytes; JSON不计入图片数")
