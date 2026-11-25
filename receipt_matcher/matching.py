"""照合(取込の確定・集計・差異判定・確認状況)。"""
import datetime as dt
import json

from . import layouts, ledger, sales
from . import normalize as nz
from .readers import ReadError

VIEWS = {
    "day": {"label": "日別", "keys": ["tdate"], "k1": "取引日付", "k2": ""},
    "store": {"label": "日別店別", "keys": ["tdate", "store"], "k1": "取引日付", "k2": "店舗"},
    "slip": {"label": "伝票番号別", "keys": ["order_no"], "k1": "相手先注文番号", "k2": "取引日付・店舗"},
    "item": {"label": "日別商品別", "keys": ["tdate", "own_code"], "k1": "取引日付", "k2": "自社商品コード・商品名"},
}
JUDGE = {"ok": ("一致", "b-ok", ""), "diff": ("差異あり", "b-diff", "r-diff"),
         "sonly": ("自社のみ", "b-s", "r-s"), "ronly": ("受領のみ", "b-r", "r-r")}
MAX_STORED_ERRORS = 500


def _now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------- 取込

def stage(conn, *, cust: str, date_from: str, date_to: str, sales_name: str, sales_data: bytes,
          receipt_name: str, receipt_data: bytes, parent_id: int | None = None) -> int:
    """ファイルを読み込み、下書きの照合として保存する(確定は confirm)。"""
    cust = nz.code(cust)
    if not cust:
        raise ReadError("販売先コードを入力してください。")
    if date_from > date_to:
        raise ReadError("期間の From が To より後になっています。")
    layout, _assigned = layouts.for_customer(conn, cust)
    if layout is None:
        raise ReadError("標準レイアウトが登録されていません。受領レイアウト画面で標準を指定してください。")
    s = sales.parse(sales_data, cust, date_from, date_to)
    conv = ledger.Converter(conn, cust)
    r = layouts.parse_receipt(conn, layout, receipt_data, cust, date_from, date_to, conv)
    cust_name = s["cust_name"]
    if not cust_name:
        row = conn.execute("SELECT MAX(cust_name) FROM ledger WHERE cust=?", (cust,)).fetchone()
        cust_name = (row[0] if row else "") or ""
    errors = s["errors"] + r["errors"]
    stats = {"sales": s["stats"], "receipt": r["stats"], "error_count": len(errors),
             "layout_assigned": _assigned, "ledger_empty": ledger.meta(conn) is None}
    with conn:
        cur = conn.execute(
            "INSERT INTO matches(status,parent_id,cust,cust_name,date_from,date_to,sales_file,receipt_file,layout_name,"
            "stats,errors,created_at) VALUES ('draft',?,?,?,?,?,?,?,?,?,?,?)",
            (parent_id, cust, cust_name, date_from, date_to, sales_name, receipt_name, layout["name"],
             json.dumps(stats, ensure_ascii=False), json.dumps(errors[:MAX_STORED_ERRORS], ensure_ascii=False), _now()))
        mid = cur.lastrowid
        conn.executemany(
            "INSERT INTO sales_lines(match_id,row_no,store,store_name,tdate,order_no,slip_no,own_code,name,qty,wt,amt)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(mid, x["row_no"], x["store"], x["store_name"], x["tdate"], x["order_no"], x["slip_no"], x["own_code"],
              x["name"], x["qty"], x["wt"], x["amt"]) for x in s["lines"]])
        conn.executemany(
            "INSERT INTO receipt_lines(match_id,row_no,store,store_name,tdate,order_no,partner_code,own_code,name,own_name,"
            "qty,wt,unit_price,amt,conv_status,conv_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(mid, x["row_no"], x["store"], x["store_name"], x["tdate"], x["order_no"], x["partner_code"], x["own_code"],
              x["name"], x["own_name"], x["qty"], x["wt"], x["unit_price"], x["amt"], x["conv_status"], x["conv_note"])
             for x in r["lines"]])
    return mid


def confirm(conn, mid: int) -> int:
    """下書きを確定する。再取込の場合は元の照合の明細を置き換え、確認状況は引き継ぐ。"""
    m = get(conn, mid)
    if m is None:
        raise ReadError("照合が見つかりません。")
    if m["status"] != "draft":
        return mid
    final = mid
    with conn:
        parent = get(conn, m["parent_id"]) if m["parent_id"] else None
        if parent is not None:
            final = parent["id"]
            for t in ("sales_lines", "receipt_lines"):
                conn.execute(f"DELETE FROM {t} WHERE match_id=?", (final,))
                conn.execute(f"UPDATE {t} SET match_id=? WHERE match_id=?", (final, mid))
            conn.execute(
                "UPDATE matches SET cust_name=?, date_from=?, date_to=?, sales_file=?, receipt_file=?, layout_name=?,"
                " stats=?, errors=?, matched_at=? WHERE id=?",
                (m["cust_name"], m["date_from"], m["date_to"], m["sales_file"], m["receipt_file"], m["layout_name"],
                 m["stats"], m["errors"], _now(), final))
            conn.execute("DELETE FROM matches WHERE id=?", (mid,))
        else:
            conn.execute("UPDATE matches SET status='done', matched_at=? WHERE id=?", (_now(), mid))
    refresh_summary(conn, final)
    return final


def discard(conn, mid: int) -> None:
    with conn:
        conn.execute("DELETE FROM matches WHERE id=? AND status='draft'", (mid,))


def delete(conn, mid: int) -> None:
    with conn:
        conn.execute("DELETE FROM matches WHERE id=?", (mid,))


def cleanup_drafts(conn) -> None:
    with conn:
        conn.execute("DELETE FROM matches WHERE status='draft'")


def get(conn, mid):
    return conn.execute("SELECT * FROM matches WHERE id=?", (mid,)).fetchone()


def list_matches(conn, cust: str = "", date_from: str = "", date_to: str = "", unchecked_only: bool = False):
    sql, args = "SELECT * FROM matches WHERE status='done'", []
    if cust:
        sql += " AND cust=?"
        args.append(nz.code(cust))
    if date_from:
        sql += " AND date_to>=?"
        args.append(date_from)
    if date_to:
        sql += " AND date_from<=?"
        args.append(date_to)
    if unchecked_only:
        sql += " AND unchecked_rows>0"
    return conn.execute(sql + " ORDER BY COALESCE(matched_at, created_at) DESC, id DESC", args).fetchall()


# ---------------------------------------------------------------- 集計

_SALES_X = ("MAX(store_name) AS sname, MAX(name) AS iname, GROUP_CONCAT(DISTINCT tdate) AS dates,"
            " GROUP_CONCAT(DISTINCT store) AS stores")
_RECEIPT_X = ("MAX(store_name) AS sname, MAX(CASE WHEN own_name<>'' THEN own_name ELSE name END) AS iname,"
              " GROUP_CONCAT(DISTINCT tdate) AS dates, GROUP_CONCAT(DISTINCT store) AS stores")


def _side(conn, table, extra, mid, keys, filt):
    kc = ", ".join(keys)
    where, args = "match_id=?", [mid]
    for c, v in (filt or {}).items():
        where += f" AND {c}=?"
        args.append(v)
    sql = (f"SELECT {kc}, SUM(amt) AS a, SUM(qty) AS q, SUM(wt) AS w, COUNT(*) AS n, {extra}"
           f" FROM {table} WHERE {where} GROUP BY {kc}")
    return {tuple(r[k] for k in keys): r for r in conn.execute(sql, args)}


def _split(v) -> list[str]:
    return (v or "").split(",")


def _md(dates: str | None) -> str:
    return ",".join(d[5:].replace("-", "/") for d in sorted((dates or "").split(",")) if d)


def compare(s, r) -> dict:
    S = (s["a"], s["q"], s["w"]) if s else (0, 0, 0)
    R = (r["a"], r["q"], r["w"]) if r else (0, 0, 0)
    d = tuple(a - b for a, b in zip(S, R))
    if s is None:
        judge = "ronly"
    elif r is None:
        judge = "sonly"
    else:
        judge = "ok" if d == (0, 0, 0) else "diff"
    items = [n for n, v in zip(("金額", "数量", "重量"), d) if v != 0]
    label, badge, row_cls = JUDGE[judge]
    if judge == "diff":
        label = f"差異あり({'・'.join(items)})"
    return {"s": S if s else None, "r": R if r else None, "d": d, "judge": judge, "judge_label": label,
            "judge_short": JUDGE[judge][0],
            "badge": badge, "row_cls": row_cls, "ok": judge == "ok"}


def aggregate_keys(conn, mid, keys, filt=None):
    sd = _side(conn, "sales_lines", _SALES_X, mid, keys, filt)
    rd = _side(conn, "receipt_lines", _RECEIPT_X, mid, keys, filt)
    out = []
    for k in sorted(set(sd) | set(rd), key=lambda t: tuple("" if v is None else v for v in t)):
        s, r = sd.get(k), rd.get(k)
        row = compare(s, r)
        row.update({"key": k, "key_str": "|".join("" if v is None else v for v in k), "srow": s, "rrow": r})
        out.append(row)
    return out


def _store_label(code, s, r):
    name = (s["sname"] if s and s["sname"] else "") or (r["sname"] if r and r["sname"] else "")
    return f"{code} {name}".strip()


def aggregate(conn, mid: int, view: str) -> list[dict]:
    v = VIEWS[view]
    rows = aggregate_keys(conn, mid, v["keys"])
    confs = {c["key"]: c for c in conn.execute("SELECT * FROM confirmations WHERE match_id=? AND view=?", (mid, view))}
    for row in rows:
        k, s, r = row["key"], row["srow"], row["rrow"]
        if view == "day":
            row["k1"], row["k2"] = nz.fmt_date(k[0]), ""
        elif view == "store":
            row["k1"], row["k2"] = nz.fmt_date(k[0]), _store_label(k[1], s, r)
        elif view == "item":
            name = (s["iname"] if s else "") or (r["iname"] if r else "")
            row["k1"], row["k2"] = nz.fmt_date(k[0]), f"{k[1]} {name}".strip()
        else:  # slip
            sd, rdd = _md(s["dates"]) if s else "", _md(r["dates"]) if r else ""
            dates = f"売上 {sd} / 受領 {rdd}" if s and r and sd != rdd else (sd or rdd)
            stores = sorted((set(_split(s["stores"] if s else "")) | set(_split(r["stores"] if r else ""))) - {""})
            sname = (s["sname"] if s and s["sname"] else "") or (r["sname"] if r and r["sname"] else "")
            if len(stores) == 1:
                st = f"{stores[0]} {sname}".strip()
            else:
                st = "、".join(stores)
            row["k1"], row["k2"] = k[0], " ・ ".join(x for x in (dates, st) if x)
        c = confs.get(row["key_str"])
        row["checked"] = bool(c and c["checked"])
        row["comment"] = c["comment"] if c else ""
        row["updated_at"] = c["updated_at"] if c else ""
    return rows


def totals(conn, mid: int) -> dict:
    def one(t):
        r = conn.execute(f"SELECT SUM(amt) AS a, SUM(qty) AS q, SUM(wt) AS w, COUNT(*) AS n FROM {t} WHERE match_id=?",
                         (mid,)).fetchone()
        return r if r["n"] else None
    s, r = one("sales_lines"), one("receipt_lines")
    res = compare(s, r)
    res["s"] = res["s"] or (0, 0, 0)
    res["r"] = res["r"] or (0, 0, 0)
    res["s_rows"] = s["n"] if s else 0
    res["r_rows"] = r["n"] if r else 0
    return res


def warnings(conn, mid: int):
    return conn.execute(
        "SELECT * FROM receipt_lines WHERE match_id=? AND conv_status IN ('none','multi') ORDER BY tdate, order_no, row_no",
        (mid,)).fetchall()


def counts(conn, mid: int) -> dict:
    out = {v: sum(1 for r in aggregate_keys(conn, mid, VIEWS[v]["keys"]) if not r["ok"]) for v in VIEWS}
    out["warn"] = len(warnings(conn, mid))
    return out


def refresh_summary(conn, mid: int) -> None:
    t = totals(conn, mid)
    slips = aggregate(conn, mid, "slip")
    diff = [r for r in slips if not r["ok"]]
    with conn:
        conn.execute("UPDATE matches SET total_judge=?, total_diff_amt=?, slip_diff_rows=?, unchecked_rows=? WHERE id=?",
                     (t["judge"], t["d"][0], len(diff), sum(1 for r in diff if not r["checked"]), mid))


# ---------------------------------------------------------------- 明細・確認

def key_filter(view: str, key_str: str) -> dict:
    keys = VIEWS[view]["keys"]
    vals = key_str.split("|")
    if len(vals) != len(keys):
        raise ValueError("キーが不正です")
    return dict(zip(keys, vals))


def detail(conn, mid: int, view: str, key_str: str) -> dict:
    filt = key_filter(view, key_str)
    rows = [r for r in aggregate(conn, mid, view) if r["key_str"] == key_str]
    where = " AND ".join(f"{c}=?" for c in filt)
    args = [mid, *filt.values()]
    sales_lines = conn.execute(f"SELECT * FROM sales_lines WHERE match_id=? AND {where} ORDER BY tdate, order_no, row_no",
                               args).fetchall()
    receipt_lines = conn.execute(
        f"SELECT * FROM receipt_lines WHERE match_id=? AND {where} ORDER BY tdate, order_no, row_no", args).fetchall()
    items = aggregate_keys(conn, mid, ["own_code"], filt)
    for it in items:
        s, r = it["srow"], it["rrow"]
        it["name"] = (s["iname"] if s else "") or (r["iname"] if r else "")
    return {"row": rows[0] if rows else None, "sales": sales_lines, "receipt": receipt_lines, "products": items}


def set_confirmation(conn, mid: int, view: str, key_str: str, checked: bool, comment: str) -> str:
    if view not in VIEWS:
        raise ValueError("切り口が不正です")
    key_filter(view, key_str)
    ts = _now()
    with conn:
        conn.execute(
            "INSERT INTO confirmations(match_id,view,key,checked,comment,updated_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(match_id,view,key) DO UPDATE SET checked=excluded.checked, comment=excluded.comment,"
            " updated_at=excluded.updated_at", (mid, view, key_str, 1 if checked else 0, comment[:1000], ts))
    if view == "slip":
        refresh_summary(conn, mid)
    return ts


# ---------------------------------------------------------------- 表示用書式

def f_amt(n) -> str:
    return "" if n is None else f"{n:,}"


def f_qty(m) -> str:
    if m is None:
        return ""
    if m % 1000 == 0:
        return f"{m // 1000:,}"
    return f"{m / 1000:,.3f}".rstrip("0").rstrip(".")


def f_wt(m) -> str:
    return "" if m is None else f"{m / 1000:,.3f}"


def signed(fn, n) -> str:
    return ("+" if n > 0 else "") + fn(n)
