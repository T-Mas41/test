# PyInstaller 設定(Windows で build_exe.bat から使用)
from PyInstaller.utils.hooks import collect_submodules

hidden = collect_submodules("uvicorn") + ["python_calamine"]

a = Analysis(
    ["run_app.py"],
    pathex=["."],
    datas=[("receipt_matcher/templates", "receipt_matcher/templates"),
           ("receipt_matcher/static", "receipt_matcher/static")],
    hiddenimports=hidden,
    excludes=["tkinter", "tests"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ReceiptMatcher", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="ReceiptMatcher")
