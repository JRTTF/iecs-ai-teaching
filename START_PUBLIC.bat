@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  IECS AI Teaching System - start everything + public tunnel
echo ============================================================
echo.

REM 1) website backend (Express, port 3306)
start "IECS website (3306)" /min cmd /c "node server.js"

REM 2) AI engine (FastAPI, port 8000) - path is relative to this folder's parent
set AI_DIR=%~dp0..\ai教材\eduai\api
if not exist "%AI_DIR%\app.py" set AI_DIR=C:\Users\cavan521\ai教材\eduai\api
if exist "%AI_DIR%\app.py" (
  start "EduAI engine (8000)" /min cmd /c "cd /d "%AI_DIR%" && python -m uvicorn app:app --host 127.0.0.1 --port 8000"
) else (
  echo [warn] AI engine not found - website will run without AI.
)

REM 3) public tunnel (Cloudflare quick tunnel -> random *.trycloudflare.com URL)
if not exist "tools\cloudflared.exe" (
  echo [error] tools\cloudflared.exe missing. Download:
  echo   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  pause
  exit /b 1
)
del /q tunnel.log 2>nul
start "Cloudflare tunnel" /min cmd /c "tools\cloudflared.exe tunnel --url http://localhost:3306 --no-autoupdate > tunnel.log 2>&1"

echo Waiting for the public URL ...
set URL=
for /l %%i in (1,1,30) do (
  if not defined URL (
    for /f "tokens=*" %%u in ('findstr /r "https://[a-z0-9-]*\.trycloudflare\.com" tunnel.log 2^>nul') do (
      for %%w in (%%u) do (
        echo %%w | findstr /r "^https://[a-z0-9-]*\.trycloudflare\.com" >nul && set URL=%%w
      )
    )
    if not defined URL timeout /t 1 /nobreak >nul
  )
)

echo.
if defined URL (
  echo ============================================================
  echo  PUBLIC URL  ^(share this with your team^):
  echo.
  echo    %URL%
  echo.
  echo  Local:  http://localhost:3306
  echo ============================================================
  echo %URL%> PUBLIC_URL.txt
  echo %URL%| clip
  echo URL copied to clipboard and saved to PUBLIC_URL.txt
  start "" "%URL%"
) else (
  echo [warn] tunnel URL not found yet - check tunnel.log
)
echo.
echo Keep this window and the three minimized windows open.
echo Close them to stop the site.
pause
