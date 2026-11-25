"""Excelレポート出力。"""
import datetime as dt
import io

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from . import matching as mt
from . import normalize as nz

FILL = {"diff": PatternFill("solid", fgColor="FFF2B3"), "sonly": PatternFill("solid", fgColor="D6E6FA"),
        "ronly": PatternFill("solid", fgColor="F9D4D4")}
HEAD_FILL = PatternFill("solid", fgColor="17324D")
HEAD_FONT = Font(color="FFFFFF", bold=True)
THIN = Side(style="thin", color="D0D5DB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
F_AMT, F_QTY, F_WT = "#,##0;[Red]-#,##0", "#,##0.###;[Red]-#,##0.###", "#,##0.000;[Red]-#,##0.000"


def file_name(m) -> str:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    return f"受領照合_{m['cust']}_{m['date_from'].replace('-', '')}-{m['date_to'].replace('-', '')}_{stamp}.xlsx"


def _header(ws, row, titles, widths):
    for i, (t, w) in enumerate(zip(titles, widths), start=1):
        c = ws.cell(row=row, column=i, value=t)
        c.fill, c.font, c.border = HEAD_FILL, HEAD_FONT, BORDER
        c.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(i)].width = w



def build(conn, mid: int) -> bytes:
    m = mt.get(conn, mid)
    wb = Workbook()
    ws = wb.active
    ws.title = "サマリ"
    t = mt.totals(conn, mid)
    cnt = mt.counts(conn, mid)
    info = [
        ("販売先", f"{m['cust']} {m['cust_name'] or ''}".strip()),
        ("期間(取引日付)", f"{nz.fmt_date(m['date_from'])} 〜 {nz.fmt_date(m['date_to'])}"),
        ("売上データ", f"{m['sales_file']}({t['s_rows']:,}行)"),
        ("受領データ", f"{m['receipt_file']}({t['r_rows']:,}行・{m['layout_name']})"),
        ("照合日時", m["matched_at"] or ""),
        ("出力日時", dt.datetime.now().strftime("%Y-%m-%d %H:%M")),
    ]
    ws["A1"] = "受領照合レポート"
    ws["A1"].font = Font(size=14, bold=True)
    for i, (k, v) in enumerate(info, start=3):
        ws.cell(row=i, column=1, value=k).font = Font(bold=True)
        ws.cell(row=i, column=2, value=v)
    r0 = 3 + len(info) + 1
    ws.cell(row=r0, column=1, value="合計の判定").font = Font(bold=True)
    jc = ws.cell(row=r0, column=2, value=mt.JUDGE[t["judge"]][0])
    if t["judge"] in FILL:
        jc.fill = FILL[t["judge"]]
    _header(ws, r0 + 1, ["", "金額(税抜)", "数量", "重量(kg)"], [22, 40, 14, 14])
    for i, (label, vals) in enumerate((("売上(自社)", t["s"]), ("受領(得意先)", t["r"]), ("差異(売上−受領)", t["d"]))):
        rr = r0 + 2 + i
        ws.cell(row=rr, column=1, value=label).border = BORDER
        for j, (v, f) in enumerate(((vals[0], F_AMT), (vals[1] / 1000, F_QTY), (vals[2] / 1000, F_WT)), start=2):
            c = ws.cell(row=rr, column=j, value=v)
            c.number_format, c.border = f, BORDER
    r1 = r0 + 6
    _header(ws, r1, ["切り口", "不一致の件数"], [22, 40])
    for i, (k, label) in enumerate([(k, v["label"]) for k, v in mt.VIEWS.items()] + [("warn", "変換警告")], start=1):
        ws.cell(row=r1 + i, column=1, value=label).border = BORDER
        ws.cell(row=r1 + i, column=2, value=cnt[k]).border = BORDER

    for view, v in mt.VIEWS.items():
        ws = wb.create_sheet(v["label"].replace("伝票番号別", "伝票別"))
        titles = [v["k1"]] + ([v["k2"]] if v["k2"] else []) + [
            "売上 金額", "売上 数量", "売上 重量", "受領 金額", "受領 数量", "受領 重量",
            "差異 金額", "差異 数量", "差異 重量", "判定", "確認済", "コメント", "確認更新日時"]
        widths = [16] + ([34] if v["k2"] else []) + [13, 10, 11, 13, 10, 11, 13, 10, 11, 20, 8, 40, 17]
        _header(ws, 1, titles, widths)
        for ri, row in enumerate(mt.aggregate(conn, mid, view), start=2):
            vals = [(row["k1"], None)] + ([(row["k2"], None)] if v["k2"] else [])
            for trip in (row["s"], row["r"]):
                if trip is None:
                    vals += [(None, None)] * 3
                else:
                    vals += [(trip[0], F_AMT), (trip[1] / 1000, F_QTY), (trip[2] / 1000, F_WT)]
            d = row["d"]
            vals += [(d[0], F_AMT), (d[1] / 1000, F_QTY), (d[2] / 1000, F_WT), (row["judge_label"], None),
                     ("✓" if row["checked"] else "", None), (row["comment"], None), (row["updated_at"], None)]
            fill = FILL.get(row["judge"])
            for ci, (val, fmt) in enumerate(vals, start=1):
                c = ws.cell(row=ri, column=ci, value=val)
                c.border = BORDER
                if fmt:
                    c.number_format = fmt
                if fill:
                    c.fill = fill
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    ws = wb.create_sheet("変換警告")
    titles = ["種別", "取引日付", "相手先注文番号", "店舗", "相手先商品コード", "商品名(受領)", "採用した自社商品コード",
              "備考", "受領 金額", "受領 数量", "受領 重量", "受領ファイル行"]
    _header(ws, 1, titles, [10, 12, 16, 14, 18, 28, 22, 50, 12, 10, 11, 12])
    for ri, w in enumerate(mt.warnings(conn, mid), start=2):
        kind = "変換不可" if w["conv_status"] == "none" else "複数候補"
        own = "" if w["conv_status"] == "none" else w["own_code"]
        vals = [(kind, None), (nz.fmt_date(w["tdate"]), None), (w["order_no"], None), (w["store"], None),
                (w["partner_code"], None), (w["name"], None), (own, None), (w["conv_note"], None),
                (w["amt"], F_AMT), (w["qty"] / 1000, F_QTY), (w["wt"] / 1000, F_WT), (w["row_no"], None)]
        for ci, (val, fmt) in enumerate(vals, start=1):
            c = ws.cell(row=ri, column=ci, value=val)
            c.border = BORDER
            c.fill = FILL["ronly"] if w["conv_status"] == "none" else FILL["diff"]
            if fmt:
                c.number_format = fmt
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
