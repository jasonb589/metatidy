"""测试前置：把音乐库与数据目录都指向临时目录（在任何 app 模块导入之前生效）。"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = Path(tempfile.mkdtemp(prefix="metatidy-test-"))
MUSIC_DIR = _TMP / "music"
DATA_DIR = _TMP / "data"
MUSIC_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

os.environ["METATIDY_MUSIC_DIR"] = str(MUSIC_DIR)
os.environ["METATIDY_DATA_DIR"] = str(DATA_DIR)
os.environ["METATIDY_LIBRARY_ROOT"] = str(MUSIC_DIR)


@pytest.fixture(scope="session", autouse=True)
def _init_environment():
    """初始化数据库与缓存目录（只做一次）。"""
    from app import db
    from app.config import load_settings

    settings = load_settings()
    settings.ensure_dirs()
    db.init(settings.db_path)
    yield


@pytest.fixture()
def music_dir() -> Path:
    """每个用例开始前清空音乐库目录。"""
    for child in MUSIC_DIR.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    return MUSIC_DIR


@pytest.fixture()
def clean_db():
    """清空索引/计划/任务/别名，并把设置恢复默认，保证用例互不污染。"""
    from app import db
    from app.config import USER_SETTING_DEFAULTS

    db.execute("DELETE FROM tracks")
    db.execute("DELETE FROM move_plans")
    db.execute("DELETE FROM jobs")
    db.execute("DELETE FROM alias_artist")
    db.execute("DELETE FROM alias_album")
    db.execute("DELETE FROM settings")
    db.executemany(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        [(k, __import__("json").dumps(v, ensure_ascii=False)) for k, v in USER_SETTING_DEFAULTS.items()],
    )
    yield db
