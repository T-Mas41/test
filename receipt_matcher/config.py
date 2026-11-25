"""パス・待受設定。

待受アドレスは 127.0.0.1 固定(他PCからは接続できない)。変更する設定は用意しない。
"""
import os
import sys
from pathlib import Path

HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def _app_dir() -> Path:
    if getattr(sys, "frozen", False):  # PyInstaller で exe 化した場合
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_dir() -> Path:
    """templates / static の場所。"""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "receipt_matcher"
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    d = Path(os.environ.get("RM_DATA_DIR") or (_app_dir() / "data"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "app.db"


def port() -> int:
    return int(os.environ.get("RM_PORT", DEFAULT_PORT))
