@echo off
setlocal
cd /d "%~dp0"

REM Fixed public domain (ngrok free static domain). Change here if you get a new one.
set PUBLIC_DOMAIN=antiques-survivor-discharge.ngrok-free.dev
set PUBLIC_URL=https://%PUBLIC_DOMAIN%

echo ============================================================
echo  IECS AI Teaching System - start everything + public URL
echo ============================================================
echo.

REM 0) ngrok must be present and authorized once:
REM      tools\ngrok.exe config add-authtoken YOUR_TOKEN
if not exist "tools\ngrok.exe" (
  echo [error] tools\ngrok.exe missing. Download:
  echo   https://ngrok.com/download
  pause
  exit /b 1
)

REM 1) website backend (Express, port 3306)
start "IECS website (3306)" /min cmd /c "node server.js"

REM 2) AI engine (FastAPI, port 8000)
set AI_DIR=%~dp0..\ai教材\eduai\api
if not exist "%AI_DIR%\app.py" set AI_DIR=C:\Users\cavan521\ai教材\eduai\api
if exist "%AI_DIR%\app.py" (
  start "EduAI engine (8000)" /min cmd /c "cd /d "%AI_DIR%" && python -m uvicorn app:app --host 127.0.0.1 --port 8000"
) else (
  echo [warn] AI engine not found - website will run without AI.
)

REM 3) public tunnel on the fixed domain
start "ngrok tunnel" /min cmd /c "tools\ngrok.exe http 3306 --url %PUBLIC_URL% --log tunnel.log"

echo Waiting for the site to come up ...
set OK=
for /l %%i in (1,1,30) do (
  if not defined OK (
    curl -s -o nul -m 3 http://localhost:3306/api/health && set OK=1
    if not defined OK timeout /t 1 /nobreak >nul
  )
)

echo.
echo ============================================================
echo  PUBLIC URL  ^(fixed - share once with your team^):
echo.
echo    %PUBLIC_URL%
echo.
echo  Local:  http://localhost:3306
echo ============================================================
echo %PUBLIC_URL%> PUBLIC_URL.txt
echo %PUBLIC_URL%| clip
echo URL copied to clipboard.
echo.
echo If the public URL does not open, ngrok is probably not authorized yet:
echo   tools\ngrok.exe config add-authtoken YOUR_TOKEN
echo   ^(token: https://dashboard.ngrok.com/get-started/your-authtoken^)
echo.
start "" "%PUBLIC_URL%"
echo Keep this window and the three minimized windows open. Close them to stop.
pause
