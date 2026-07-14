@echo off
rem DropCull launcher for Windows — double-click me.
cd /d "%~dp0"

rem Running from inside a zip? Windows silently unpacks just this file to Temp
rem and everything else is missing. Catch it and say so in plain words.
echo %~dp0 | findstr /i /c:".zip\" >nul
if not errorlevel 1 (
  echo.
  echo   Hold on — you're running DropCull from INSIDE the zip file.
  echo   Nothing works from in there.
  echo.
  echo   Fix: close this window, right-click the DropCull zip,
  echo   choose "Extract All" / "Extraer todo", then open the NEW folder
  echo   it creates and double-click DropCull.bat in there.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo DropCull needs Node.js ^(free^). Grab it here, install, then double-click me again:
  echo.
  echo     https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run — downloading the free open-source parts ^(one time, ~1 min^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Install hit a snag. Check your internet and try again.
    pause
    exit /b 1
  )
)

rem Self-update: checks GitHub for a newer version. Safe to fail — if there's
rem no internet or GitHub is down, DropCull just starts with what's installed.
node update.js
if errorlevel 10 (
  call npm install --no-audit --no-fund
)

echo.
echo   DropCull is starting... your browser will open in a second.
echo   Leave this window open while you work. Close it to quit.
echo.
node server.js --open
pause
