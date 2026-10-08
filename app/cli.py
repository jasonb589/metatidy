"""启动入口：`python -m app.cli` 或容器里的 `metatidy`。"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from .config import load_settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="metatidy", description="轻量音乐元数据工作台")
    parser.add_argument("--host", default=None, help="监听地址（默认取 METATIDY_HOST 或 0.0.0.0）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 8080）")
    parser.add_argument("--log-level", default=os.environ.get("METATIDY_LOG_LEVEL", "info"))
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    settings = load_settings()
    host = args.host or settings.host
    port = args.port or settings.port

    import uvicorn

    logging.getLogger("metatidy").info("音乐目录=%s 数据目录=%s", settings.music_dir, settings.data_dir)
    logging.getLogger("metatidy").info("打开 http://%s:%s/", "127.0.0.1" if host == "0.0.0.0" else host, port)
    uvicorn.run("app.main:app", host=host, port=port, log_level=args.log_level, access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
