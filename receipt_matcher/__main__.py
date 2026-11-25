"""起動: python -m receipt_matcher(exe の場合はダブルクリック)。"""
import socket
import threading
import webbrowser

import uvicorn

from . import config
from .web import create_app


def _free_port(start: int) -> int:
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((config.HOST, p))
                return p
            except OSError:
                continue
    raise SystemExit("使用できるポートが見つかりません。")


def main() -> None:
    port = _free_port(config.port())
    url = f"http://{config.HOST}:{port}/"
    app = create_app()
    print(f"受領照合を起動しました: {url}")
    print(f"データ保存先: {config.data_dir()}")
    print("終了するには、このウィンドウを閉じてください。")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    # 127.0.0.1 のみで待ち受ける。アクセスログは業務データ(URL内の番号等)を含み得るため出力しない。
    uvicorn.run(app, host=config.HOST, port=port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
