"""取込値の正規化(コード・数値・日付)。"""
import datetime as dt
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

_MINUS_MARKS = ("▲", "△", "−", "－")
_EXCEL_EPOCH = dt.date(1899, 12, 30)
DATE_FORMATS = {
    "": "自動判別",
    "YYYYMMDD": "YYYYMMDD",
    "YYYY/MM/DD": "YYYY/MM/DD",
    "YYYY-MM-DD": "YYYY-MM-DD",
}
_STRPTIME = {"YYYYMMDD": "%Y%m%d", "YYYY/MM/DD": "%Y/%m/%d", "YYYY-MM-DD": "%Y-%m-%d"}


def text(v) -> str:
    """セル値を文字列にする(前後の空白を除去)。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y%m%d")
    return str(v).replace("　", " ").strip()


def code(v) -> str:
    """照合キーになるコード類。数字だけのコードは先頭ゼロを除いて比較する。"""
    s = unicodedata.normalize("NFKC", text(v)).strip()
    if s.isdigit():
        return s.lstrip("0") or "0"
    return s


def is_blank(v) -> bool:
    return text(v) == ""


def number(v) -> Decimal:
    """数値に変換。空欄は0。変換できない場合は ValueError。"""
    if v is None:
        return Decimal(0)
    if isinstance(v, bool):
        raise ValueError("数値ではありません")
    if isinstance(v, int):
        return Decimal(v)
    if isinstance(v, float):
        return Decimal(repr(v))
    s = unicodedata.normalize("NFKC", str(v)).strip()
    if s == "":
        return Decimal(0)
    neg = False
    for m in _MINUS_MARKS:
        if s.startswith(m):
            neg, s = True, s[len(m):]
    s = s.replace(",", "").replace("円", "").replace(" ", "")
    if s.endswith("-") and len(s) > 1:  # 末尾マイナス表記
        neg, s = True, s[:-1]
    try:
        d = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"数値として読めません: {str(v)[:20]}")
    return -d if neg else d


def to_amount(d: Decimal) -> int:
    """金額は整数(円)で比較する。"""
    return int(d.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_milli(d: Decimal) -> int:
    """数量・重量は小数第3位まで(第4位を四捨五入)を整数×1000で保持する。"""
    return int((d * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


_DATE_SEP = re.compile(r"^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})")


def date(v, fmt: str = "") -> str:
    """日付を 'YYYY-MM-DD' にする。読めない場合は ValueError。"""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        n = int(v)
        if 19000101 <= n <= 29991231:
            v = str(n)
        elif 1 <= n < 2958466:  # Excel のシリアル値
            return (_EXCEL_EPOCH + dt.timedelta(days=n)).isoformat()
    s = unicodedata.normalize("NFKC", text(v))
    if not s:
        raise ValueError("日付が空欄です")
    try:
        if fmt in _STRPTIME:
            return dt.datetime.strptime(s.split(" ")[0], _STRPTIME[fmt]).date().isoformat()
        if re.fullmatch(r"\d{8}", s):
            return dt.datetime.strptime(s, "%Y%m%d").date().isoformat()
        m = _DATE_SEP.match(s)
        if m:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
    except ValueError:
        pass
    raise ValueError(f"日付として読めません: {s[:20]}")


def fmt_date(iso: str) -> str:
    return iso.replace("-", "/") if iso else ""
