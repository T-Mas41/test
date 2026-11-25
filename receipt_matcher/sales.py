"""自社売上データ(固定レイアウト・188列)の取込。"""
from . import normalize as nz
from .headers import SALES_HEADERS
from .readers import ReadError, cell, read_rows

# 列位置(1始まり)。見出しに同名列があるため位置で特定する。
SALES_COLS = {
    "cust": 7, "cust_name": 8, "store": 81, "store_name": 82, "tdate": 137,
    "order_no": 35, "own_code": 9, "name": 10, "qty": 33, "wt": 32, "amt": 58, "slip_no": 18,
}


def check_headers(header: list) -> list[str]:
    errs = []
    for key, col in SALES_COLS.items():
        expected = SALES_HEADERS[col - 1]
        actual = nz.text(cell(header, col))
        if actual != expected:
            errs.append(f"{col}列目の見出しが「{actual or '(空欄)'}」です(想定:「{expected}」)")
    return errs


def parse(data: bytes, cust: str, date_from: str, date_to: str) -> dict:
    """売上ファイルを読み、指定販売先・期間の行を返す。"""
    rows = read_rows(data, "excel")
    if not rows:
        raise ReadError("売上データが空です。")
    errs = check_headers(rows[0])
    if errs:
        raise ReadError("売上データのレイアウトが想定と異なります。" + " / ".join(errs[:5]))
    cust_key = nz.code(cust)
    lines, errors = [], []
    stats = {"total": 0, "target": 0, "skipped_blank": 0, "other_cust": 0, "out_of_period": 0, "error": 0}
    cust_name = ""
    for i, row in enumerate(rows[1:], start=2):
        g = lambda k: cell(row, SALES_COLS[k])  # noqa: E731
        if all(nz.is_blank(g(k)) for k in ("tdate", "order_no", "own_code")):
            if any(not nz.is_blank(v) for v in row):
                stats["skipped_blank"] += 1
            continue
        stats["total"] += 1
        if nz.code(g("cust")) != cust_key:
            stats["other_cust"] += 1
            continue
        try:
            tdate = nz.date(g("tdate"))
            qty, wt, amt = nz.number(g("qty")), nz.number(g("wt")), nz.number(g("amt"))
        except ValueError as e:
            stats["error"] += 1
            errors.append({"file": "売上", "row": i, "msg": str(e)})
            continue
        if not (date_from <= tdate <= date_to):
            stats["out_of_period"] += 1
            continue
        cust_name = cust_name or nz.text(g("cust_name"))
        lines.append({
            "row_no": i, "store": nz.code(g("store")), "store_name": nz.text(g("store_name")),
            "tdate": tdate, "order_no": nz.code(g("order_no")), "slip_no": nz.text(g("slip_no")),
            "own_code": nz.code(g("own_code")), "name": nz.text(g("name")),
            "qty": nz.to_milli(qty), "wt": nz.to_milli(wt), "amt": nz.to_amount(amt),
        })
    stats["target"] = len(lines)
    return {"lines": lines, "errors": errors, "stats": stats, "cust_name": cust_name}
