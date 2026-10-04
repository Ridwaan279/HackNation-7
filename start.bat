@echo off
rem Protege for Windows: installs what it needs the first time, then starts the app.
setlocal
title Protege
cd /d "%~dp0"

echo.
echo   Protege
echo   ----------

where node >nul 2>nul
if errorlevel 1 goto need_node
python --version >nul 2>nul
if errorlevel 1 goto need_python

if not exist "sidecar\.installed" (
  echo   Installing the observer. This only happens the first time.
  python -m pip install --disable-pip-version-check -q -r sidecar\requirements.txt
  if errorlevel 1 goto failed
  echo ok> "sidecar\.installed"
)

if not exist "app\node_modules" (
  echo   Installing the app. The first time takes a few minutes.
  pushd app
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    goto failed
  )
  popd
)

if not exist "app\.env" (
  copy "app\.env.example" "app\.env" >nul
  echo   Paste your API keys into the file that opens, save it, then close Notepad.
  start /wait notepad "app\.env"
)

echo   Starting. Keep this window open while you use Protege.
pushd app
call npm run dev
popd
goto :eof

:need_node
echo   Protege needs Node.js 20 or newer. Opening the download page.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:need_python
echo   Protege needs Python 3.11 or newer. Opening the download page.
echo   When you install it, tick "Add python.exe to PATH".
start "" "https://www.python.org/downloads/windows/"
pause
exit /b 1

:failed
echo.
echo   Something went wrong. The messages above say what.
pause
exit /b 1
