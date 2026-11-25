@echo off
rem Build ReceiptMatcher.exe (Windows). Output: dist\ReceiptMatcher\ReceiptMatcher.exe
cd /d "%~dp0"
echo [1/4] Checking Python...
python --version
if errorlevel 1 goto :nopython
echo [2/4] Creating virtual environment (.venv)...
if not exist .venv\Scripts\python.exe python -m venv .venv
if errorlevel 1 goto :fail
echo [3/4] Installing libraries (internet required)...
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements-dev.txt
if errorlevel 1 goto :fail
echo [3/4] Running tests...
.venv\Scripts\python -m pytest -q tests
if errorlevel 1 goto :fail
echo [4/4] Building exe...
.venv\Scripts\python -m PyInstaller --noconfirm ReceiptMatcher.spec
if errorlevel 1 goto :fail
if not exist dist\ReceiptMatcher\ReceiptMatcher.exe goto :fail
echo.
echo ==== SUCCESS ====
echo Created: %~dp0dist\ReceiptMatcher\ReceiptMatcher.exe
explorer "%~dp0dist\ReceiptMatcher"
pause
exit /b 0
:nopython
echo.
echo ==== ERROR: python command not found. Check "Add python.exe to PATH". ====
pause
exit /b 1
:fail
echo.
echo ==== ERROR: build failed. Please send a screenshot of this window. ====
pause
exit /b 1
