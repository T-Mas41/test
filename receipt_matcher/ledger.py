"""販売台帳(商品コード変換マスタ)。"""
import datetime as dt

from . import normalize as nz
from .headers import LEDGER_HEADERS
from .readers import ReadError, cell, read_rows

LEDGER_COLS = {"deleted": 1, "own_code": 59, "own_name": 60, "partner_code": 72,
               "cust": 111, "cust_name": 112, "store": 113}
STORE_ANY = "99999999999"  # 店舗「指定なし」


def import_ledger(conn, data: bytes, file_name: str) -> dict:
    """全件入れ替えで取り込む。削除区分 9 は取り込まない。"""
    rows = read_rows(data, "excel")
    if not rows:
        raise ReadError("販売台帳が空です。")
    errs = []
    for key, col in LEDGER_COLS.items():
        if nz.text(cell(rows[0], col)) != LEDGER_HEADERS[col - 1]:
            errs.append(f"{col}列目の見出しが「{nz.text(cell(rows[0], col)) or '(空欄)'}」です(想定:「{LEDGER_HEADERS[col - 1]}」)")
    if errs:
        raise ReadError("販売台帳のレイアウトが想定と異なります。" + " / ".join(errs[:5]))
    recs, total, deleted, skipped = [], 0, 0, 0
    for row in rows[1:]:
        if all(nz.is_blank(v) for v in row):
            continue
        total += 1
        g = lambda k: cell(row, LEDGER_COLS[k])  # noqa: E731
        if nz.text(g("deleted")) == "9":
            deleted += 1
            continue
        pc, oc = nz.code(g("partner_code")), nz.code(g("own_code"))
        if not pc or not oc:
            skipped += 1
            continue
        recs.append((nz.code(g("cust")), nz.text(g("cust_name")), nz.code(g("store")) or STORE_ANY,
                     pc, oc, nz.text(g("own_name"))))
    with conn:
        conn.execute("DELETE FROM ledger")
        conn.executemany("INSERT INTO ledger(cust,cust_name,store,partner_code,own_code,own_name) VALUES (?,?,?,?,?,?)", recs)
        conn.execute("DELETE FROM ledger_meta")
        conn.execute(
            "INSERT INTO ledger_meta(id,file_name,imported_at,total_rows,loaded_rows,deleted_rows,skipped_rows) VALUES (1,?,?,?,?,?,?)",
            (file_name, dt.datetime.now().strftime("%Y-%m-%d %H:%M"), total, len(recs), deleted, skipped))
    return {"total": total, "loaded": len(recs), "deleted": deleted, "skipped": skipped}


def meta(conn):
    return conn.execute("SELECT * FROM ledger_meta WHERE id=1").fetchone()


def duplicate_count(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM (SELECT 1 FROM ledger GROUP BY cust,store,partner_code HAVING COUNT(DISTINCT own_code)>1)").fetchone()[0]


def customers(conn) -> list:
    return conn.execute(
        "SELECT cust, MAX(cust_name) AS cust_name FROM ledger GROUP BY cust ORDER BY cust").fetchall()


class Converter:
    """販売先 + 店舗 + 相手先商品コード → 自社商品コード。

    検索順: ①店舗一致 → ②店舗「指定なし」。複数ヒットは台帳の先頭を採用し警告。
    """

    def __init__(self, conn, cust: str):
        self.map: dict[tuple, list] = {}
        for r in conn.execute("SELECT store, partner_code, own_code, own_name FROM ledger WHERE cust=? ORDER BY seq",
                              (nz.code(cust),)):
            self.map.setdefault((r["store"], r["partner_code"]), []).append((r["own_code"], r["own_name"]))

    def convert(self, store: str, partner_code: str):
        """(自社コード, 自社商品名, 状態 ok/multi/none, 備考) を返す。"""
        hits = self.map.get((store, partner_code)) if store else None
        via = "店舗一致"
        if not hits:
            hits, via = self.map.get((STORE_ANY, partner_code)), "店舗指定なし"
        if not hits:
            return "[未変換]" + partner_code, "", "none", "販売台帳に登録がありません"
        own, name = hits[0]
        if len({h[0] for h in hits}) > 1:
            return own, name, "multi", f"候補{len(hits)}件の先頭を採用({via}): " + "、".join(h[0] for h in hits[:5])
        return own, name, "ok", via
