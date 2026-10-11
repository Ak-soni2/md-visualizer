@echo off
rem ============================================================================================================
rem  NanoCut MD workstation - one-click start (Windows). Double-click this file, or run:  START.bat
rem  1. finds Python 3.12 (installs it with winget if missing)
rem  2. creates the virtual environment .venv (again if it was copied from another computer)
rem  3. installs / updates the required packages (only when requirements*.txt changed)
rem  4. starts the app on http://127.0.0.1:8600 and opens it in the browser
rem  Nothing outside this folder is changed except Python itself (if it had to be installed).
rem ============================================================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title NanoCut MD workstation
if not defined PORT set PORT=8600

rem ---- 1. Python 3.12 -------------------------------------------------------------------------------------
set "PYEXE="
py -3.12 -c "import sys" >nul 2>&1 && set "PYEXE=py -3.12"
if not defined PYEXE (
  for %%P in (python python3) do (
    if not defined PYEXE (
      %%P -c "import sys; sys.exit(0 if sys.version_info[:2] in ((3,10),(3,11),(3,12),(3,13)) else 1)" >nul 2>&1 && set "PYEXE=%%P"
    )
  )
)
if not defined PYEXE (
  echo Python 3.10-3.13 not found. Installing Python 3.12 with winget ...
  winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  py -3.12 -c "import sys" >nul 2>&1 && set "PYEXE=py -3.12"
)
if not defined PYEXE (
  echo.
  echo Could not find or install Python. Install Python 3.12 from https://www.python.org/downloads/
  echo ^(tick "Add python.exe to PATH"^), then run START.bat again.
  pause
  exit /b 1
)
echo Using Python: %PYEXE%

rem ---- 2. virtual environment (a .venv copied from another computer does not work: rebuild it) -------------
set "VPY=.venv\Scripts\python.exe"
"%VPY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo Creating the virtual environment .venv ...
  %PYEXE% -m venv --clear .venv || (echo Could not create .venv & pause & exit /b 1)
  if exist ".venv\.nanocut-requirements" del ".venv\.nanocut-requirements"
)

rem ---- 3. packages (reinstalled only when the requirement files change) -----------------------------------
copy /b requirements.txt + webapp\backend\requirements.txt "%TEMP%\nanocut-req.txt" >nul
set "NEED=1"
if exist ".venv\.nanocut-requirements" fc /b "%TEMP%\nanocut-req.txt" ".venv\.nanocut-requirements" >nul 2>&1 && set "NEED=0"
if "%NEED%"=="1" (
  echo Installing the required packages ^(first start: a few minutes, about 1 GB with OVITO^) ...
  "%VPY%" -m pip install --upgrade pip >nul
  "%VPY%" -m pip install -r requirements.txt -r webapp\backend\requirements.txt || (echo Package installation failed & pause & exit /b 1)
  copy /y "%TEMP%\nanocut-req.txt" ".venv\.nanocut-requirements" >nul
)

rem ---- 4. start -------------------------------------------------------------------------------------------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul && (
  echo Port %PORT% is in use: NanoCut may already be running. Opening it.
  start "" "http://127.0.0.1:%PORT%/app/"
  exit /b 0
)
echo.
echo  NanoCut is starting on  http://127.0.0.1:%PORT%/app/   (close this window to stop it)
echo.
if not defined NANOCUT_NO_BROWSER start "" /b cmd /c "timeout /t 4 >nul & start "" http://127.0.0.1:%PORT%/app/"
"%VPY%" -m uvicorn webapp.backend.app.main:app --host 127.0.0.1 --port %PORT%
pause
