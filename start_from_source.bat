@echo off
chcp 65001 >nul
rem ソースから起動します(Python 環境がある場合)。
cd /d %~dp0
if not exist .venv (python -m venv .venv & .venv\Scripts\python -m pip install -r requirements.txt)
.venv\Scripts\python -m receipt_matcher
pause
