"""HTML版をビルドし、1ファイルの「受領照合.html」をリポジトリ直下に作る。

使い方: python tools/build_html.py
"""
import datetime as dt
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "html_app" / "src"
OUT = ROOT / "受領照合.html"


def main() -> None:
    tpl = (SRC / "index.template.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in sorted((SRC / "js").glob("[0-9][0-9]_*.js")))
    if re.search(r"https?://(?!www\.w3\.org|schemas\.openxmlformats\.org|schemas\.microsoft\.com)", js + css):
        raise SystemExit("外部URLが含まれています。")
    if "</script" in js.lower():
        raise SystemExit("JS内に </script が含まれています。")
    version = dt.date.today().strftime("%Y.%m.%d")
    html = tpl.replace("/*__CSS__*/", css).replace("/*__JS__*/", js).replace("__VERSION__", version)
    OUT.write_text(html, encoding="utf-8", newline="\n")
    print(f"作成しました: {OUT}({len(html.encode('utf-8')) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
