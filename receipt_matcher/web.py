"""画面(ローカルWebアプリ)。"""
import io
import json
import math
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import config, db, layouts, ledger
from . import matching as mt
from . import normalize as nz
from . import report
from .readers import DELIMITERS, ENCODINGS, ReadError

PAGE_ROWS = 500  # 照合結果の1ページの行数
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


def create_app(db_file: Path | None = None) -> FastAPI:
    db_file = Path(db_file or config.db_path())
    # 自動生成のAPIドキュメント画面は外部CDNを参照するため無効化する
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    conn0 = db.connect(db_file)
    db.init(conn0)
    layouts.seed(conn0)
    mt.cleanup_drafts(conn0)
    conn0.close()

    res = config.resource_dir()
    app.mount("/static", StaticFiles(directory=res / "static"), name="static")
    tpl = Jinja2Templates(directory=res / "templates")
    tpl.env.globals.update(f_amt=mt.f_amt, f_qty=mt.f_qty, f_wt=mt.f_wt, signed=mt.signed, fmt_date=nz.fmt_date,
                           VIEWS=mt.VIEWS, ROLES=layouts.ROLES, ROLE_LABEL=layouts.ROLE_LABEL,
                           ENCODINGS=ENCODINGS, DELIMITERS=DELIMITERS, DATE_FORMATS=nz.DATE_FORMATS,
                           quote=urllib.parse.quote)

    def conn():
        return db.connect(db_file)

    def render(request, name, nav, **ctx):
        ctx.update(nav=nav, msg=request.query_params.get("msg", ""), err=request.query_params.get("err", ""))
        return tpl.TemplateResponse(request, name, ctx)

    def back(url, **q):
        q = {k: v for k, v in q.items() if v}
        return RedirectResponse(url + ("?" + urllib.parse.urlencode(q) if q else ""), status_code=303)

    def parse_date(s: str) -> str:
        return nz.date(s.strip()) if s.strip() else ""

    # ------------------------------------------------------------ 照合一覧
    @app.get("/", response_class=HTMLResponse)
    def index(request: Request, cust: str = "", date_from: str = "", date_to: str = "", unchecked: str = ""):
        c = conn()
        try:
            try:
                df, dt_ = parse_date(date_from), parse_date(date_to)
            except ValueError:
                df = dt_ = ""
            rows = mt.list_matches(c, cust, df, dt_, bool(unchecked))
            unchecked_total = c.execute(
                "SELECT COALESCE(SUM(unchecked_rows),0), COUNT(CASE WHEN unchecked_rows>0 THEN 1 END)"
                " FROM matches WHERE status='done'").fetchone()
            return render(request, "index.html", "list", rows=rows, cust=cust, date_from=date_from, date_to=date_to,
                          unchecked=unchecked, ledger_meta=ledger.meta(c), layout_count=len(layouts.all_layouts(c)),
                          assign_count=len(layouts.assignments(c)), unchecked_total=unchecked_total,
                          customers=_customers(c))
        finally:
            c.close()

    def _customers(c):
        seen = {}
        for r in ledger.customers(c):
            seen[r["cust"]] = r["cust_name"] or ""
        for r in layouts.assignments(c):
            seen.setdefault(r["cust"], r["cust_name"] or "")
        for r in c.execute("SELECT cust, MAX(cust_name) AS n FROM matches WHERE status='done' GROUP BY cust"):
            seen.setdefault(r["cust"], r["n"] or "")
        return sorted(seen.items())

    # ------------------------------------------------------------ 新規照合・取込
    @app.get("/new", response_class=HTMLResponse)
    def new_form(request: Request, parent: int | None = None):
        c = conn()
        try:
            p = mt.get(c, parent) if parent else None
            return render(request, "new.html", "new", parent=p, customers=_customers(c),
                          ledger_meta=ledger.meta(c), assignments={a["cust"]: a["layout_name"] for a in layouts.assignments(c)},
                          standard=layouts.standard(c))
        finally:
            c.close()

    @app.post("/new")
    async def new_submit(cust: str = Form(""), date_from: str = Form(""), date_to: str = Form(""),
                         parent: str = Form(""), sales_file: UploadFile = File(...),
                         receipt_file: UploadFile = File(...)):
        target = "/new" + (f"?parent={parent}" if parent else "")
        sep = "&" if parent else "?"
        c = conn()
        try:
            try:
                df, dt_ = nz.date(date_from), nz.date(date_to)
            except ValueError:
                return RedirectResponse(target + sep + urllib.parse.urlencode({"err": "期間を YYYY/MM/DD で入力してください。"}), 303)
            sd, rd = await sales_file.read(), await receipt_file.read()
            if not sd or not rd:
                return RedirectResponse(target + sep + urllib.parse.urlencode({"err": "売上データと受領データの両方を選択してください。"}), 303)
            p = mt.get(c, int(parent)) if parent else None
            try:
                mid = mt.stage(c, cust=p["cust"] if p else cust, date_from=df, date_to=dt_,
                               sales_name=sales_file.filename or "", sales_data=sd,
                               receipt_name=receipt_file.filename or "", receipt_data=rd,
                               parent_id=p["id"] if p else None)
            except ReadError as e:
                return RedirectResponse(target + sep + urllib.parse.urlencode({"err": str(e)}), 303)
            return back(f"/review/{mid}")
        finally:
            c.close()

    @app.get("/review/{mid}", response_class=HTMLResponse)
    def review(request: Request, mid: int):
        c = conn()
        try:
            m = mt.get(c, mid)
            if m is None or m["status"] != "draft":
                return back("/", err="取込データが見つかりません。もう一度取り込んでください。")
            stats = json.loads(m["stats"])
            return render(request, "review.html", "new", m=m, stats=stats, errors=json.loads(m["errors"]),
                          parent=mt.get(c, m["parent_id"]) if m["parent_id"] else None)
        finally:
            c.close()

    @app.post("/review/{mid}/confirm")
    def review_confirm(mid: int):
        c = conn()
        try:
            final = mt.confirm(c, mid)
            return back(f"/matches/{final}", msg="照合しました。")
        finally:
            c.close()

    @app.post("/review/{mid}/cancel")
    def review_cancel(mid: int):
        c = conn()
        try:
            m = mt.get(c, mid)
            mt.discard(c, mid)
            if m is not None and m["parent_id"]:
                return back(f"/matches/{m['parent_id']}", msg="再取込を中止しました。")
            return back("/", msg="取込を中止しました。")
        finally:
            c.close()

    # ------------------------------------------------------------ 照合結果
    @app.get("/matches/{mid}", response_class=HTMLResponse)
    def result(request: Request, mid: int, view: str = "day", only_diff: str = "", only_unc: str = "", q: str = "",
               page: int = 1):
        c = conn()
        try:
            m = mt.get(c, mid)
            if m is None or m["status"] != "done":
                return back("/", err="照合が見つかりません。")
            if view not in mt.VIEWS and view != "warn":
                view = "day"
            rows, warns = [], []
            if view == "warn":
                warns = mt.warnings(c, mid)
            else:
                rows = mt.aggregate(c, mid, view)
                if only_diff:
                    rows = [r for r in rows if not r["ok"]]
                if only_unc:
                    rows = [r for r in rows if not r["ok"] and not r["checked"]]
                if q.strip():
                    qq = q.strip()
                    rows = [r for r in rows if qq in r["k1"] or qq in r["k2"] or qq in r["comment"]]
            total_rows = len(rows) if view != "warn" else len(warns)
            pages = max(1, math.ceil(total_rows / PAGE_ROWS))
            page = min(max(1, page), pages)
            rows = rows[(page - 1) * PAGE_ROWS: page * PAGE_ROWS]
            warns = warns[(page - 1) * PAGE_ROWS: page * PAGE_ROWS]
            qs = urllib.parse.urlencode({k: v for k, v in (("view", view), ("only_diff", only_diff),
                                                          ("only_unc", only_unc), ("q", q)) if v})
            return render(request, "result.html", "list", m=m, view=view, rows=rows, warns=warns,
                          page=page, pages=pages, total_rows=total_rows, qs=qs,
                          only_diff=only_diff, only_unc=only_unc, q=q, t=mt.totals(c, mid), counts=mt.counts(c, mid),
                          stats=json.loads(m["stats"] or "{}"))
        finally:
            c.close()

    @app.get("/matches/{mid}/detail", response_class=HTMLResponse)
    def detail(request: Request, mid: int, view: str, key: str):
        c = conn()
        try:
            m = mt.get(c, mid)
            if m is None or view not in mt.VIEWS:
                return back("/", err="照合が見つかりません。")
            try:
                d = mt.detail(c, mid, view, key)
            except ValueError:
                return back(f"/matches/{mid}", err="明細のキーが不正です。")
            if d["row"] is None:
                return back(f"/matches/{mid}?view={view}", err="該当する行がありません。")
            return render(request, "detail.html", "list", m=m, view=view, key=key, d=d)
        finally:
            c.close()

    @app.post("/matches/{mid}/confirm-row")
    def confirm_row(mid: int, view: str = Form(...), key: str = Form(...), checked: str = Form(""),
                    comment: str = Form(""), next: str = Form("")):
        c = conn()
        try:
            if mt.get(c, mid) is None:
                return JSONResponse({"ok": False, "error": "照合が見つかりません"}, status_code=404)
            try:
                ts = mt.set_confirmation(c, mid, view, key, checked in ("1", "on", "true"), comment)
            except ValueError as e:
                return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
            if next.startswith("/matches/"):
                return RedirectResponse(next, status_code=303)
            return JSONResponse({"ok": True, "updated_at": ts})
        finally:
            c.close()

    @app.post("/matches/{mid}/delete")
    def delete_match(mid: int):
        c = conn()
        try:
            mt.delete(c, mid)
            return back("/", msg="照合を削除しました。")
        finally:
            c.close()

    @app.get("/matches/{mid}/report")
    def download_report(mid: int):
        c = conn()
        try:
            m = mt.get(c, mid)
            if m is None:
                return back("/", err="照合が見つかりません。")
            data = report.build(c, mid)
            name = report.file_name(m)
            return StreamingResponse(
                io.BytesIO(data), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}"})
        finally:
            c.close()

    # ------------------------------------------------------------ 販売台帳
    @app.get("/ledger", response_class=HTMLResponse)
    def ledger_page(request: Request, cust: str = "", q: str = "", dup: str = "", page: int = 1):
        c = conn()
        try:
            where, args = "1=1", []
            if cust:
                where += " AND l.cust=?"
                args.append(nz.code(cust))
            if q.strip():
                where += " AND (l.partner_code LIKE ? OR l.own_code LIKE ? OR l.own_name LIKE ?)"
                args += [f"%{q.strip()}%"] * 3
            dup_join = ("JOIN (SELECT cust,store,partner_code FROM ledger GROUP BY cust,store,partner_code"
                        " HAVING COUNT(DISTINCT own_code)>1) d USING (cust,store,partner_code)") if dup else ""
            total = c.execute(f"SELECT COUNT(*) FROM ledger l {dup_join} WHERE {where}", args).fetchone()[0]
            per = 100
            pages = max(1, math.ceil(total / per))
            page = min(max(1, page), pages)
            rows = c.execute(
                f"SELECT l.*, (SELECT COUNT(DISTINCT own_code) FROM ledger x WHERE x.cust=l.cust AND x.store=l.store"
                f" AND x.partner_code=l.partner_code) AS cand FROM ledger l {dup_join} WHERE {where}"
                f" ORDER BY l.cust, l.partner_code, l.store, l.seq LIMIT ? OFFSET ?", args + [per, (page - 1) * per]).fetchall()
            return render(request, "ledger.html", "ledger", meta=ledger.meta(c), dup_count=ledger.duplicate_count(c),
                          rows=rows, total=total, page=page, pages=pages, cust=cust, q=q, dup=dup,
                          customers=ledger.customers(c), STORE_ANY=ledger.STORE_ANY)
        finally:
            c.close()

    @app.post("/ledger")
    async def ledger_upload(file: UploadFile = File(...)):
        c = conn()
        try:
            data = await file.read()
            if not data:
                return back("/ledger", err="ファイルを選択してください。")
            try:
                r = ledger.import_ledger(c, data, file.filename or "")
            except ReadError as e:
                return back("/ledger", err=str(e))
            return back("/ledger", msg=f"販売台帳を取り込みました(有効 {r['loaded']:,}件、削除区分9 を除外 {r['deleted']:,}件"
                                        + (f"、コード空欄で除外 {r['skipped']:,}件" if r["skipped"] else "") + ")。")
        finally:
            c.close()

    # ------------------------------------------------------------ 受領レイアウト・割当
    @app.get("/layouts", response_class=HTMLResponse)
    def layouts_page(request: Request):
        c = conn()
        try:
            return render(request, "layouts.html", "layouts", layouts=layouts.all_layouts(c),
                          assignments=layouts.assignments(c), customers=ledger.customers(c))
        finally:
            c.close()

    @app.post("/layouts/new")
    async def layout_new(name: str = Form(...), file_type: str = Form("excel"), encoding: str = Form("cp932"),
                         delimiter: str = Form(","), sheet_name: str = Form(""), header_row: int = Form(1),
                         data_start_row: int = Form(2), file: UploadFile = File(...)):
        c = conn()
        try:
            data = await file.read()
            if not data or not name.strip():
                return back("/layouts", err="レイアウト名とサンプルファイルを指定してください。")
            if data_start_row <= header_row or header_row < 1:
                return back("/layouts", err="データ開始行は見出し行より後ろにしてください。")
            try:
                lid = layouts.create_from_sample(c, name.strip(), file.filename or "", data, file_type, encoding,
                                                 delimiter, sheet_name.strip(), header_row, data_start_row)
            except ReadError as e:
                return back("/layouts", err=str(e))
            return back(f"/layouts/{lid}/edit", msg="サンプルを読み込みました。各列の役割を設定して保存してください。")
        finally:
            c.close()

    @app.get("/layouts/{lid}/edit", response_class=HTMLResponse)
    def layout_edit(request: Request, lid: int, all_cols: str = ""):
        c = conn()
        try:
            lay = layouts.get(c, lid)
            if lay is None:
                return back("/layouts", err="レイアウトが見つかりません。")
            cols = layouts.columns(c, lid)
            samples = json.loads(lay["sample_rows"] or "[]")
            used = [x["role"] for x in cols if x["role"]]
            return render(request, "layout_edit.html", "layouts", lay=lay, cols=cols, samples=samples,
                          preview=layouts.preview(c, lid), used=used, all_cols=all_cols,
                          problems=layouts.validate_roles({x["col_no"]: x["role"] for x in cols}))
        finally:
            c.close()

    @app.post("/layouts/{lid}/edit")
    async def layout_save(request: Request, lid: int):
        form = await request.form()
        c = conn()
        try:
            if layouts.get(c, lid) is None:
                return back("/layouts", err="レイアウトが見つかりません。")
            try:
                settings = {"name": str(form.get("name", "")), "file_type": str(form.get("file_type", "excel")),
                            "encoding": str(form.get("encoding", "cp932")), "delimiter": str(form.get("delimiter", ",")),
                            "sheet_name": str(form.get("sheet_name", "")),
                            "header_row": int(form.get("header_row", 1)), "data_start_row": int(form.get("data_start_row", 2))}
            except ValueError:
                return back(f"/layouts/{lid}/edit", err="見出し行・データ開始行は数字で入力してください。")
            roles, fmts = {}, {}
            for x in layouts.columns(c, lid):
                roles[x["col_no"]] = str(form.get(f"role_{x['col_no']}", x["role"]))
                fmts[x["col_no"]] = str(form.get(f"fmt_{x['col_no']}", x["date_format"]))
            valid = {k for k, _, _ in layouts.ROLES} | {""}
            roles = {k: (v if v in valid else "") for k, v in roles.items()}
            errs = layouts.save(c, lid, settings, roles, fmts)
            if errs:
                return back(f"/layouts/{lid}/edit", err=" / ".join(errs))
            return back(f"/layouts/{lid}/edit", msg="保存しました。")
        finally:
            c.close()

    @app.post("/layouts/{lid}/sample")
    async def layout_sample(lid: int, file: UploadFile = File(...)):
        c = conn()
        try:
            data = await file.read()
            if not data:
                return back(f"/layouts/{lid}/edit", err="ファイルを選択してください。")
            try:
                layouts.reload_sample(c, lid, file.filename or "", data)
            except ReadError as e:
                return back(f"/layouts/{lid}/edit", err=str(e))
            return back(f"/layouts/{lid}/edit", msg="サンプルを読み直しました(同じ列・見出しの役割は引き継いでいます)。")
        finally:
            c.close()

    @app.post("/layouts/{lid}/standard")
    def layout_standard(lid: int):
        c = conn()
        try:
            layouts.set_standard(c, lid)
            return back("/layouts", msg="標準レイアウトを変更しました。")
        finally:
            c.close()

    @app.post("/layouts/{lid}/delete")
    def layout_delete(lid: int):
        c = conn()
        try:
            e = layouts.delete(c, lid)
            return back("/layouts", err=e) if e else back("/layouts", msg="レイアウトを削除しました。")
        finally:
            c.close()

    @app.post("/assignments")
    def assignment_add(cust: str = Form(...), cust_name: str = Form(""), layout_id: int = Form(...)):
        c = conn()
        try:
            if not nz.code(cust):
                return back("/layouts", err="販売先コードを入力してください。")
            if layouts.get(c, layout_id) is None:
                return back("/layouts", err="レイアウトが見つかりません。")
            if not cust_name.strip():
                row = c.execute("SELECT MAX(cust_name) FROM ledger WHERE cust=?", (nz.code(cust),)).fetchone()
                cust_name = (row[0] if row else "") or ""
            layouts.assign(c, cust, cust_name, layout_id)
            return back("/layouts", msg=f"販売先 {nz.code(cust)} のレイアウトを設定しました。")
        finally:
            c.close()

    @app.post("/assignments/{cust}/delete")
    def assignment_delete(cust: str):
        c = conn()
        try:
            layouts.unassign(c, cust)
            return back("/layouts", msg=f"販売先 {cust} の割当を解除しました(標準レイアウトを使用します)。")
        finally:
            c.close()

    return app
