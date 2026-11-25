@echo off
chcp 65001 >nul
rem Windows: exe を作成します(要 Python 3.11 以上)。完成品は dist\ReceiptMatcher フォルダ。
cd /d %~dp0
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install -r requirements-dev.txt
python -m pytest -q tests || (echo テストに失敗しました & pause & exit /b 1)
pyinstaller --noconfirm ReceiptMatcher.spec
echo.
echo 完成: dist\ReceiptMatcher\ReceiptMatcher.exe
pause
