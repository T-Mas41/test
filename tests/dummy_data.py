"""テスト用の架空データ生成(サンプルと同じ列構成・値はすべて架空)。"""
import csv
import io

import openpyxl

from receipt_matcher.headers import BMS_RECEIPT_HEADERS, LEDGER_HEADERS, SALES_HEADERS, STANDARD_RECEIPT_HEADERS
from receipt_matcher.layouts import BMS_MAP, STANDARD_MAP
from receipt_matcher.ledger import LEDGER_COLS
from receipt_matcher.sales import SALES_COLS

CUST = "20005525"


def _xlsx(headers, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _row(n, colmap, values):
    row = [None] * n
    for k, v in values.items():
        row[colmap[k] - 1] = v
    return row


SALES_ID_COL = 50   # 商品識別コード(9桁)
LEDGER_ID_COL = 57


def sales_xlsx(lines):
    """lines: dict(cust, store, tdate, order_no, own_code, name, qty, wt, amt)"""
    names = {e[4]: e[5] for e in LEDGER}
    names["3105002000120"] = "チキンハニーマスタードトルティーヤ"
    rows = []
    for x in lines:
        x = {**x, "name": x.get("name") or names.get(x["own_code"], ""), "store_name": x.get("store_name") or STORE_NAMES.get(x["store"], "")}
        v = {"cust": x.get("cust", CUST), "cust_name": "H", "store": x["store"], "store_name": x.get("store_name", ""),
             "tdate": x["tdate"], "order_no": x["order_no"], "own_code": x["own_code"], "name": x.get("name", ""),
             "qty": x["qty"], "wt": x["wt"], "amt": x["amt"], "slip_no": x.get("slip_no", "0057095328")}
        r = _row(len(SALES_HEADERS), SALES_COLS, v)
        r[153] = CUST  # 2つ目の販売先コード列(抽出条件)も埋めておく
        r[SALES_ID_COL - 1] = ID_CODES.get(x["own_code"], "")
        rows.append(r)
    return _xlsx(SALES_HEADERS, rows)


_STD = {v: k for k, v in STANDARD_MAP.items()}
_BMS = {v: k for k, v in BMS_MAP.items()}


def receipt_xlsx(lines, extra_rows=()):
    rows = []
    for x in lines:
        v = {"tdate": x["tdate"], "store": x["store"], "store_name": x.get("store_name") or STORE_NAMES.get(x["store"], ""), "order_no": x["order_no"],
             "amt": x["amt"], "cust": x.get("cust", CUST), "partner_code": x["partner_code"], "name": x.get("name", ""),
             "qty": x["qty"], "wt": x.get("wt"), "unit_price": x.get("unit_price")}
        rows.append(_row(len(STANDARD_RECEIPT_HEADERS), _STD, v))
    rows += list(extra_rows)
    return _xlsx(STANDARD_RECEIPT_HEADERS, rows)


def receipt_bms_csv(lines):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(BMS_RECEIPT_HEADERS)
    for x in lines:
        v = {"tdate": x["tdate"], "store": x["store"], "store_name": STORE_NAMES.get(x["store"], ""), "order_no": x["order_no"],
             "partner_code": x["partner_code"], "name": x.get("name", ""), "unit_price": "", "amt": x["amt"],
             "qty": x["qty"], "wt": x.get("wt", "")}
        w.writerow(["" if c is None else c for c in _row(len(BMS_RECEIPT_HEADERS), _BMS, v)])
    return buf.getvalue().encode("cp932")


def ledger_xlsx(entries):
    """entries: (deleted, cust, store, partner_code, own_code, own_name)"""
    rows = []
    for d, c, s, p, o, n in entries:
        r = _row(len(LEDGER_HEADERS), LEDGER_COLS,
                 {"deleted": d, "cust": c, "cust_name": "H", "store": s, "partner_code": p, "own_code": o, "own_name": n})
        r[LEDGER_ID_COL - 1] = ID_CODES.get(o, "")
        rows.append(r)
    return _xlsx(LEDGER_HEADERS, rows)


# ---- 画面イメージと同じシナリオ ---------------------------------------------
BEEF = "1601001001700279"   # 信州牛うす切り肉(もも)
LOIN = "1601001000500293"   # 長野県産和牛肩ロース
LOIN2 = "1601001000500301"  # 同(特選)
CUT = "1601001000300120"    # 和牛ロース切落し
TORT = "3105002000120"      # チキンハニーマスタードトルティーヤ
# 商品コード(16桁) → 商品識別コード(9桁)。HTML版はこちらを自社商品コードとして使う
ID_CODES = {BEEF: "000362114", LOIN: "000283223", LOIN2: "000283224", CUT: "000412001", TORT: "000510012"}
STORE_NAMES = {"20005552": "長野店", "20005561": "松本店"}

LEDGER = [
    ("1", CUST, "20005552", "2721327000000", BEEF, "信州牛うす切り肉(もも)"),
    ("1", CUST, "99999999999", "2721327000000", BEEF, "信州牛うす切り肉(もも)"),
    ("1", CUST, "99999999999", "10820780", LOIN, "長野県産和牛肩ロース"),
    ("1", CUST, "99999999999", "10820780", LOIN2, "長野県産和牛肩ロース(特選)"),
    ("1", CUST, "99999999999", "2730015000000", CUT, "和牛ロース切落し"),
    ("9", CUST, "99999999999", "4958857043977", "3105002000120", "削除済み商品"),
]

SALES = [
    dict(store="20005552", tdate="20261104", order_no="7227151", own_code=BEEF, qty=10, wt=2.0, amt=12720),
    dict(store="20005552", tdate="20261104", order_no="7227151", own_code=BEEF, qty=2, wt=0.355, amt=2660),
    dict(store="20005552", tdate="20261106", order_no="7227188", own_code=LOIN, qty=20, wt=6.0, amt=40000),
    dict(store="20005561", tdate="20261109", order_no="7227302", own_code=CUT, qty=6, wt=1.8, amt=12400),
    dict(store="20005561", tdate="20261107", order_no="7227290", own_code=CUT, qty=3, wt=0.9, amt=5400),
    dict(store="20005552", tdate="20261101", order_no="7218832", own_code=TORT, qty=10, wt=0, amt=3020),
    dict(store="20005552", tdate="20261031", order_no="7200000", own_code=BEEF, qty=1, wt=0.2, amt=1338),
    dict(store="20005552", tdate="20261105", order_no="7227400", own_code=BEEF, qty=-1, wt=-0.2, amt=-1338),
]

RECEIPT = [
    dict(store="20005552", tdate="20261104", order_no="7227151", partner_code="2721327000000", qty=10, wt=2.0, amt=12720, name="ｼﾝｼｭｳｷﾞｭｳ ｳｽｷﾞﾘ ﾓﾓ"),
    dict(store="20005552", tdate="20261106", order_no="7227188", partner_code="10820780", qty=22, wt=6.32, amt=46742, name="ﾜｷﾞｭｳ ｶﾀﾛｰｽ"),
    dict(store="20005561", tdate="20261108", order_no="0007227302", partner_code="2730015000000", qty=6, wt=1.8, amt=12400, name="ﾜｷﾞｭｳ ﾛｰｽｷﾘｵﾄｼ"),
    dict(store="20005561", tdate="20261107", order_no="7227295", partner_code="2730015000000", qty=3, wt=0.9, amt=5400, name="ﾜｷﾞｭｳ ﾛｰｽｷﾘｵﾄｼ"),
    dict(store="20005552", tdate="20261101", order_no="7218832", partner_code="4958857043977", qty=10, wt=None, amt=3020, name="FD ﾁｷﾝﾊﾆﾏｽﾄﾙﾃｨｰﾔ"),
    dict(store="20005552", tdate="20261105", order_no="7227400", partner_code="2721327000000", qty=-1, wt=-0.2, amt="▲1,338", name="ｼﾝｼｭｳｷﾞｭｳ ｳｽｷﾞﾘ ﾓﾓ"),
]

# 複数の販売先が混ざった売上(エラー確認用)
SALES_MULTI = SALES + [dict(store="20005552", tdate="20261101", order_no="7299999", own_code=BEEF, qty=1, wt=0.2, amt=1338, cust="20009999")]
