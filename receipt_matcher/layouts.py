"""受領レイアウトマスタと受領データの読込。"""
import datetime as dt
import json

from . import normalize as nz
from .headers import BMS_RECEIPT_HEADERS, STANDARD_RECEIPT_HEADERS
from .readers import ReadError, cell, read_rows

# (キー, 表示名, 必須)
ROLES = [
    ("tdate", "取引日付", True),
    ("order_no", "相手先注文番号", True),
    ("partner_code", "相手先商品コード", True),
    ("amt", "金額", True),
    ("qty", "数量", False),
    ("wt", "重量", False),
    ("store", "店舗コード", False),
    ("store_name", "店舗名", False),
    ("cust", "販売先コード", False),
    ("name", "商品名", False),
    ("unit_price", "単価", False),
]
ROLE_LABEL = {k: v for k, v, _ in ROLES}
REQUIRED = [k for k, _, req in ROLES if req]

# 見出し名から役割を推測(新規作成時の初期値)
_SUGGEST = {
    "取引日付": "tdate", "計上日": "tdate", "相手先注文番号": "order_no", "取引番号（発注・返品）": "order_no",
    "相手先商品コード": "partner_code", "販売先商品識別ｺｰﾄﾞ": "partner_code", "受領金額": "amt", "原価金額": "amt",
    "受領数量(総バラ)": "qty", "受領数量（バラ）": "qty", "受領重量": "wt", "店舗コード": "store",
    "店舗略称": "store_name", "販売先コード": "cust", "相手先商品名カナ": "name", "商品名": "name",
    "受領単価": "unit_price", "原単価": "unit_price",
}

STANDARD_MAP = {2: "tdate", 3: "store", 4: "store_name", 5: "order_no", 7: "unit_price", 8: "amt",
                11: "cust", 14: "partner_code", 15: "name", 21: "qty", 22: "wt"}
BMS_MAP = {71: "tdate", 29: "store", 31: "store_name", 22: "order_no", 113: "partner_code", 117: "name",
           146: "unit_price", 147: "amt", 163: "qty", 165: "wt"}


def _now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def seed(conn) -> None:
    """初回起動時に標準レイアウトと流通BMS形式の例を登録する。"""
    if conn.execute("SELECT COUNT(*) FROM layouts").fetchone()[0]:
        return
    _insert_layout(conn, "標準レイアウト", 1, "excel", "cp932", ",", "", 1, 2, STANDARD_RECEIPT_HEADERS, STANDARD_MAP)
    _insert_layout(conn, "流通BMS 受領CSV", 0, "csv", "cp932", ",", "", 1, 2, BMS_RECEIPT_HEADERS, BMS_MAP)
    conn.commit()


def _insert_layout(conn, name, std, ftype, enc, delim, sheet, hrow, drow, headers, mapping):
    cur = conn.execute(
        "INSERT INTO layouts(name,is_standard,file_type,encoding,delimiter,sheet_name,header_row,data_start_row,updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", (name, std, ftype, enc, delim, sheet, hrow, drow, _now()))
    lid = cur.lastrowid
    conn.executemany("INSERT INTO layout_columns(layout_id,col_no,header,role) VALUES (?,?,?,?)",
                     [(lid, i, h, mapping.get(i, "")) for i, h in enumerate(headers, start=1)])
    return lid


def all_layouts(conn):
    return conn.execute(
        "SELECT l.*, (SELECT COUNT(*) FROM layout_columns c WHERE c.layout_id=l.id) AS col_count,"
        " (SELECT COUNT(*) FROM customer_layouts a WHERE a.layout_id=l.id) AS assigned"
        " FROM layouts l ORDER BY is_standard DESC, id").fetchall()


def get(conn, lid: int):
    return conn.execute("SELECT * FROM layouts WHERE id=?", (lid,)).fetchone()


def columns(conn, lid: int):
    return conn.execute("SELECT * FROM layout_columns WHERE layout_id=? ORDER BY col_no", (lid,)).fetchall()


def standard(conn):
    return conn.execute("SELECT * FROM layouts WHERE is_standard=1").fetchone()


def for_customer(conn, cust: str):
    """販売先に割り当てられたレイアウト。割当がなければ標準。"""
    row = conn.execute("SELECT l.* FROM customer_layouts a JOIN layouts l ON l.id=a.layout_id WHERE a.cust=?",
                       (nz.code(cust),)).fetchone()
    return (row, True) if row else (standard(conn), False)


def read_sample(data: bytes, file_type: str, encoding: str, delimiter: str, sheet_name: str,
                header_row: int, data_start_row: int):
    rows = read_rows(data, file_type, encoding=encoding, delimiter=delimiter, sheet_name=sheet_name)
    if len(rows) < header_row:
        raise ReadError(f"見出し行({header_row}行目)がありません。")
    header = [nz.text(v) for v in rows[header_row - 1]]
    while header and header[-1] == "":
        header.pop()
    if not header:
        raise ReadError(f"{header_row}行目に見出しがありません。")
    samples = [[nz.text(cell(r, c)) for c in range(1, len(header) + 1)]
               for r in rows[data_start_row - 1: data_start_row - 1 + 5]]
    return header, samples


def create_from_sample(conn, name: str, file_name: str, data: bytes, file_type: str, encoding: str,
                       delimiter: str, sheet_name: str, header_row: int, data_start_row: int) -> int:
    header, samples = read_sample(data, file_type, encoding, delimiter, sheet_name, header_row, data_start_row)
    used, mapping = set(), {}
    for i, h in enumerate(header, start=1):
        r = _SUGGEST.get(h)
        if r and r not in used:
            mapping[i] = r
            used.add(r)
    with conn:
        lid = _insert_layout(conn, name, 0, file_type, encoding, delimiter, sheet_name, header_row, data_start_row,
                             header, mapping)
        conn.execute("UPDATE layouts SET sample_file=?, sample_rows=? WHERE id=?",
                     (file_name, json.dumps(samples, ensure_ascii=False), lid))
    return lid


def reload_sample(conn, lid: int, file_name: str, data: bytes) -> None:
    """別のサンプルで見出しを読み直す。見出し名が同じ列の役割は引き継ぐ。"""
    lay = get(conn, lid)
    header, samples = read_sample(data, lay["file_type"], lay["encoding"], lay["delimiter"], lay["sheet_name"],
                                  lay["header_row"], lay["data_start_row"])
    old = {(c["col_no"], c["header"]): (c["role"], c["date_format"]) for c in columns(conn, lid)}
    with conn:
        conn.execute("DELETE FROM layout_columns WHERE layout_id=?", (lid,))
        conn.executemany(
            "INSERT INTO layout_columns(layout_id,col_no,header,role,date_format) VALUES (?,?,?,?,?)",
            [(lid, i, h, *old.get((i, h), ("", ""))) for i, h in enumerate(header, start=1)])
        conn.execute("UPDATE layouts SET sample_file=?, sample_rows=?, updated_at=? WHERE id=?",
                     (file_name, json.dumps(samples, ensure_ascii=False), _now(), lid))


def validate_roles(roles: dict[int, str]) -> list[str]:
    errs = []
    used = [r for r in roles.values() if r]
    for k in REQUIRED:
        if k not in used:
            errs.append(f"必須の役割「{ROLE_LABEL[k]}」が設定されていません")
    for k in sorted(set(used)):
        if used.count(k) > 1:
            errs.append(f"役割「{ROLE_LABEL[k]}」が複数の列に設定されています")
    return errs


def save(conn, lid: int, settings: dict, roles: dict[int, str], date_formats: dict[int, str]) -> list[str]:
    errs = validate_roles(roles)
    if settings["header_row"] < 1 or settings["data_start_row"] <= settings["header_row"]:
        errs.append("データ開始行は見出し行より後ろにしてください")
    if not settings["name"].strip():
        errs.append("レイアウト名を入力してください")
    if errs:
        return errs
    with conn:
        conn.execute(
            "UPDATE layouts SET name=?, file_type=?, encoding=?, delimiter=?, sheet_name=?, header_row=?, data_start_row=?,"
            " updated_at=? WHERE id=?",
            (settings["name"].strip(), settings["file_type"], settings["encoding"], settings["delimiter"],
             settings["sheet_name"].strip(), settings["header_row"], settings["data_start_row"], _now(), lid))
        for col, role in roles.items():
            conn.execute("UPDATE layout_columns SET role=?, date_format=? WHERE layout_id=? AND col_no=?",
                         (role, date_formats.get(col, "") if role == "tdate" else "", lid, col))
    return []


def set_standard(conn, lid: int) -> None:
    with conn:
        conn.execute("UPDATE layouts SET is_standard = CASE WHEN id=? THEN 1 ELSE 0 END", (lid,))


def delete(conn, lid: int) -> str | None:
    lay = get(conn, lid)
    if not lay:
        return "レイアウトが見つかりません"
    if lay["is_standard"]:
        return "標準レイアウトは削除できません(先に別のレイアウトを標準にしてください)"
    if conn.execute("SELECT COUNT(*) FROM customer_layouts WHERE layout_id=?", (lid,)).fetchone()[0]:
        return "得意先に割り当てられているため削除できません(先に割当を解除してください)"
    with conn:
        conn.execute("DELETE FROM layouts WHERE id=?", (lid,))
    return None


def assignments(conn):
    return conn.execute(
        "SELECT a.cust, a.cust_name, a.layout_id, l.name AS layout_name FROM customer_layouts a"
        " JOIN layouts l ON l.id=a.layout_id ORDER BY a.cust").fetchall()


def assign(conn, cust: str, cust_name: str, lid: int) -> None:
    with conn:
        conn.execute("INSERT INTO customer_layouts(cust,cust_name,layout_id) VALUES (?,?,?)"
                     " ON CONFLICT(cust) DO UPDATE SET cust_name=excluded.cust_name, layout_id=excluded.layout_id",
                     (nz.code(cust), cust_name.strip(), lid))


def unassign(conn, cust: str) -> None:
    with conn:
        conn.execute("DELETE FROM customer_layouts WHERE cust=?", (cust,))


def preview(conn, lid: int) -> list[dict]:
    """サンプル先頭行を役割に沿って変換した結果。"""
    lay = get(conn, lid)
    cols = columns(conn, lid)
    samples = json.loads(lay["sample_rows"] or "[]")
    out = []
    for s in samples:
        rec = {}
        for c in cols:
            if not c["role"]:
                continue
            raw = s[c["col_no"] - 1] if c["col_no"] - 1 < len(s) else ""
            try:
                if c["role"] == "tdate":
                    rec[c["role"]] = nz.fmt_date(nz.date(raw, c["date_format"]))
                elif c["role"] in ("amt",):
                    rec[c["role"]] = f"{nz.to_amount(nz.number(raw)):,}"
                elif c["role"] in ("qty", "wt"):
                    rec[c["role"]] = f"{nz.to_milli(nz.number(raw)) / 1000:,.3f}"
                elif c["role"] in ("order_no", "partner_code", "store", "cust"):
                    rec[c["role"]] = nz.code(raw)
                else:
                    rec[c["role"]] = raw
            except ValueError as e:
                rec[c["role"]] = f"⚠ {e}"
        out.append(rec)
    return out


def parse_receipt(conn, layout, data: bytes, cust: str, date_from: str, date_to: str, converter) -> dict:
    """受領ファイルをレイアウト定義に従って読み、商品コードを変換する。"""
    cols = {c["role"]: c for c in columns(conn, layout["id"]) if c["role"]}
    missing = [ROLE_LABEL[k] for k in REQUIRED if k not in cols]
    if missing:
        raise ReadError(f"レイアウト「{layout['name']}」に必須の役割がありません: {'、'.join(missing)}")
    rows = read_rows(data, layout["file_type"], encoding=layout["encoding"], delimiter=layout["delimiter"],
                     sheet_name=layout["sheet_name"])
    cust_key = nz.code(cust)
    lines, errors = [], []
    stats = {"total": 0, "target": 0, "skipped_blank": 0, "other_cust": 0, "out_of_period": 0, "error": 0,
             "conv_none": 0, "conv_multi": 0}
    g = lambda row, k: cell(row, cols[k]["col_no"]) if k in cols else None  # noqa: E731
    for i, row in enumerate(rows[layout["data_start_row"] - 1:], start=layout["data_start_row"]):
        if all(nz.is_blank(g(row, k)) for k in ("tdate", "order_no", "partner_code")):
            if any(not nz.is_blank(v) for v in row):
                stats["skipped_blank"] += 1  # 合計行など
            continue
        stats["total"] += 1
        if "cust" in cols and not nz.is_blank(g(row, "cust")) and nz.code(g(row, "cust")) != cust_key:
            stats["other_cust"] += 1
            continue
        try:
            tdate = nz.date(g(row, "tdate"), cols["tdate"]["date_format"])
            qty, wt, amt = nz.number(g(row, "qty")), nz.number(g(row, "wt")), nz.number(g(row, "amt"))
        except ValueError as e:
            stats["error"] += 1
            errors.append({"file": "受領", "row": i, "msg": str(e)})
            continue
        if not (date_from <= tdate <= date_to):
            stats["out_of_period"] += 1
            continue
        store, pcode = nz.code(g(row, "store")), nz.code(g(row, "partner_code"))
        own, own_name, status, note = converter.convert(store, pcode)
        if status == "none":
            stats["conv_none"] += 1
        elif status == "multi":
            stats["conv_multi"] += 1
        lines.append({
            "row_no": i, "store": store, "store_name": nz.text(g(row, "store_name")), "tdate": tdate,
            "order_no": nz.code(g(row, "order_no")), "partner_code": pcode, "own_code": own,
            "name": nz.text(g(row, "name")), "own_name": own_name,
            "qty": nz.to_milli(qty), "wt": nz.to_milli(wt), "unit_price": nz.text(g(row, "unit_price")),
            "amt": nz.to_amount(amt), "conv_status": status, "conv_note": note,
        })
    stats["target"] = len(lines)
    return {"lines": lines, "errors": errors, "stats": stats}
