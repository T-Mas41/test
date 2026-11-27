import io
import re

import openpyxl
import pytest
from fastapi.testclient import TestClient

from receipt_matcher import matching as mt
from receipt_matcher import normalize as nz
from receipt_matcher.web import create_app

from . import dummy_data as dd


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "t.db")
    with TestClient(app) as c:
        c.db = tmp_path / "t.db"
        yield c


def upload_ledger(c):
    r = c.post("/ledger", files={"file": ("台帳.xlsx", dd.ledger_xlsx(dd.LEDGER))})
    assert r.status_code == 200 and "販売台帳を取り込みました" in r.text, r.text
    assert "有効 5件" in r.text and "除外 1件" in r.text


def run_match(c, receipt=None, receipt_name="受領.xlsx", parent=None, date_to="2026/11/10"):
    data = {"cust": dd.CUST, "date_from": "2026/11/01", "date_to": date_to}
    if parent:
        data["parent"] = str(parent)
    r = c.post("/new", data=data, files={
        "sales_file": ("売上.xlsx", dd.sales_xlsx(dd.SALES)),
        "receipt_file": (receipt_name, receipt if receipt is not None else dd.receipt_xlsx(dd.RECEIPT))},
        follow_redirects=False)
    assert r.status_code == 303, r.text
    loc = r.headers["location"]
    assert loc.startswith("/review/"), loc
    mid = int(loc.rsplit("/", 1)[1])
    rv = c.get(loc)
    assert rv.status_code == 200
    r = c.post(f"/review/{mid}/confirm", follow_redirects=False)
    final = int(re.search(r"/matches/(\d+)", r.headers["location"]).group(1))
    return final, rv.text


def test_normalize():
    assert nz.code("0007227302") == "7227302" and nz.code(7227302.0) == "7227302" and nz.code("") == ""
    assert nz.code("000") == "0"
    assert nz.number("▲1,338") == -1338 and nz.number("1,234-") == -1234 and nz.number(None) == 0
    assert nz.to_milli(nz.number(0.3555)) == 356
    assert nz.date("20261104") == "2026-11-04" and nz.date("2026/1/5") == "2026-01-05"
    assert nz.date(20261104) == "2026-11-04" and nz.date(46330) == "2026-11-04"
    assert nz.date("2026/11/04", "YYYY/MM/DD") == "2026-11-04"
    with pytest.raises(ValueError):
        nz.date("abc")
    with pytest.raises(ValueError):
        nz.number("12a")


def test_full_flow(client):
    c = client
    upload_ledger(c)
    mid, review = run_match(c)
    assert "照合対象" in review and "変換不可 1件、複数候補 1件" in review

    from receipt_matcher import db
    conn = db.connect(c.db)
    t = mt.totals(conn, mid)
    # 売上: 対象販売先・期間内 7行(他販売先・期間外を除外)
    assert t["s_rows"] == 7 and t["r_rows"] == 6
    assert t["s"][0] == 12720 + 2660 + 40000 + 12400 + 5400 + 3020 - 1338
    assert t["r"][0] == 12720 + 46742 + 12400 + 5400 + 3020 - 1338
    assert t["d"][0] == t["s"][0] - t["r"][0]

    slip = {r["k1"]: r for r in mt.aggregate(conn, mid, "slip")}
    assert slip["7227151"]["judge"] == "diff" and slip["7227151"]["d"] == (2660, 2000, 355)
    assert slip["7227188"]["d"] == (-6742, -2000, -320)
    assert slip["7227302"]["judge"] == "ok"           # 先頭ゼロを除いて一致、日付ずれでも伝票では一致
    assert "売上 11/09 / 受領 11/08" in slip["7227302"]["k2"]
    assert slip["7227290"]["judge"] == "sonly" and slip["7227295"]["judge"] == "ronly"
    assert slip["7227295"]["k2"] == "11/07 ・ 20005561 松本店"
    assert slip["7227400"]["judge"] == "ok"           # マイナス(▲表記)も一致
    assert slip["7218832"]["judge"] == "ok"           # 金額は一致(商品は変換不可)

    day = {r["key"][0]: r for r in mt.aggregate(conn, mid, "day")}
    assert day["2026-11-08"]["judge"] == "ronly" and day["2026-11-09"]["judge"] == "sonly"

    item = {(r["key"][0], r["key"][1]): r for r in mt.aggregate(conn, mid, "item")}
    assert item[("2026-11-01", "[未変換]4958857043977")]["judge"] == "ronly"
    assert item[("2026-11-06", dd.LOIN)]["judge"] == "diff"  # 複数候補→先頭(LOIN)を採用

    store = {r["key"]: r for r in mt.aggregate(conn, mid, "store")}
    assert store[("2026-11-04", "20005552")]["judge"] == "diff"

    w = mt.warnings(conn, mid)
    assert {x["conv_status"] for x in w} == {"none", "multi"}
    conn.close()

    # 画面
    for view in ("day", "store", "slip", "item", "warn"):
        r = c.get(f"/matches/{mid}?view={view}")
        assert r.status_code == 200, view
    r = c.get(f"/matches/{mid}?view=slip&only_diff=1")
    assert "7227151" in r.text and "7218832" not in r.text
    r = c.get(f"/matches/{mid}/detail", params={"view": "slip", "key": "7227151"})
    assert r.status_code == 200 and "台帳で変換" in r.text

    # 確認状況
    r = c.post(f"/matches/{mid}/confirm-row", data={"view": "slip", "key": "7227290", "checked": "1", "comment": "受領漏れ連絡済"})
    assert r.json()["ok"]
    r = c.get(f"/matches/{mid}?view=slip&only_unc=1")
    assert "7227151" in r.text and "受領漏れ連絡済" not in r.text
    r = c.get(f"/matches/{mid}?view=slip")
    assert "受領漏れ連絡済" in r.text
    lst = c.get("/")
    assert "照合一覧" in lst.text and dd.CUST in lst.text

    # Excelレポート
    r = c.get(f"/matches/{mid}/report")
    assert r.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == ["サマリ", "日別", "日別店別", "伝票別", "日別商品別", "変換警告"]
    ws = wb["伝票別"]
    vals = {ws.cell(row=i, column=1).value: i for i in range(2, ws.max_row + 1)}
    row = vals["7227290"]
    assert ws.cell(row=row, column=14).value == "受領漏れ連絡済"
    assert ws.cell(row=row, column=1).fill.fgColor.rgb.endswith("D6E6FA")
    assert wb["変換警告"].max_row == 3

    # 再取込: 確認状況を引き継ぐ
    mid2, _ = run_match(c, parent=mid)
    assert mid2 == mid
    r = c.get(f"/matches/{mid}?view=slip")
    assert "受領漏れ連絡済" in r.text


def test_bms_csv_layout_assignment(client):
    c = client
    upload_ledger(c)
    page = c.get("/layouts").text
    lid = re.search(r'<option value="(\d+)">流通BMS 受領CSV</option>', page).group(1)
    r = c.post("/assignments", data={"cust": dd.CUST, "cust_name": "", "layout_id": lid})
    assert "レイアウトを設定しました" in r.text
    mid, review = run_match(c, receipt=dd.receipt_bms_csv(dd.RECEIPT[:4]), receipt_name="受領.csv")
    assert "流通BMS 受領CSV" in review
    from receipt_matcher import db
    conn = db.connect(c.db)
    assert mt.totals(conn, mid)["r_rows"] == 4
    conn.close()
    # 割当中のレイアウトは削除できない
    r = c.post(f"/layouts/{lid}/delete")
    assert "削除できません" in r.text


def test_receipt_errors_and_blank_rows(client):
    c = client
    upload_ledger(c)
    bad = [None] * 45
    bad[1], bad[4], bad[13], bad[7] = "2026/13/45", "7000001", "2721327000000", 100
    total_row = [None] * 45
    total_row[7] = 999999  # 合計行(日付・注文番号・商品コードが空欄)
    data = dd.receipt_xlsx(dd.RECEIPT, extra_rows=[bad, total_row])
    mid, review = run_match(c, receipt=data)
    assert "日付として読めません" in review and "エラー行を除いて照合を実行" in review
    assert "1行(空行・合計行など)" in review


def test_sales_layout_check(client):
    c = client
    r = c.post("/new", data={"cust": dd.CUST, "date_from": "2026/11/01", "date_to": "2026/11/10"},
               files={"sales_file": ("x.xlsx", dd.receipt_xlsx(dd.RECEIPT)), "receipt_file": ("r.xlsx", dd.receipt_xlsx(dd.RECEIPT))})
    assert "売上データのレイアウトが想定と異なります" in r.text


def test_layout_create_and_edit(client):
    c = client
    hdr = ["納品日", "発注番号", "JAN", "品名", "数量", "金額"]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "明細"
    ws.append(["K社 受領明細"])
    ws.append([])
    ws.append(hdr)
    ws.append(["2026/11/04", "7227151", "2721327000000", "もも", 10, "12,720"])
    buf = io.BytesIO()
    wb.save(buf)
    r = c.post("/layouts/new", data={"name": "K社", "file_type": "excel", "sheet_name": "明細", "header_row": "3",
                                     "data_start_row": "4"}, files={"file": ("k.xlsx", buf.getvalue())})
    assert "各列の役割を設定" in r.text
    lid = re.search(r"/layouts/(\d+)/edit", str(r.url)).group(1)
    r = c.post(f"/layouts/{lid}/edit", data={"name": "K社", "file_type": "excel", "encoding": "cp932", "delimiter": ",",
                                             "sheet_name": "明細", "header_row": "3", "data_start_row": "4",
                                             "role_1": "tdate", "role_2": "order_no"})
    assert "必須の役割「相手先商品コード」" in r.text
    r = c.post(f"/layouts/{lid}/edit", data={"name": "K社", "file_type": "excel", "encoding": "cp932", "delimiter": ",",
                                             "sheet_name": "明細", "header_row": "3", "data_start_row": "4",
                                             "role_1": "tdate", "role_2": "order_no", "role_3": "partner_code",
                                             "role_4": "name", "role_5": "qty", "role_6": "amt"})
    assert "保存しました" in r.text and "12,720" in r.text and "2026/11/04" in r.text


def test_security_settings(client):
    c = client
    assert c.get("/docs").status_code == 404 and c.get("/openapi.json").status_code == 404
    r = c.get("/")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert c.get("/", headers={"host": "evil.example.com"}).status_code == 400
    # テンプレート・静的ファイルに外部URLを含まない
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent / "receipt_matcher"
    for p in list((root / "templates").glob("*.html")) + list((root / "static").glob("*")):
        assert not re.search(r"https?://", p.read_text(encoding="utf-8")), p
