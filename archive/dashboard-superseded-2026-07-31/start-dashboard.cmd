@echo off
REM Agent Solomon - 007 — double-click to start the dashboard.
REM Runs in cmd.exe, so the PowerShell script-execution policy never applies.
cd /d "%~dp0"

echo ============================================================
echo   Agent Solomon - 007  —  starting dashboard
echo   URL: http://127.0.0.1:4317   (Ctrl+C to stop)
echo ============================================================
echo.

REM Rebuild (harmless if nothing changed), then run the server.
call npx tsc
if errorlevel 1 (
  echo.
  echo Build failed - see the TypeScript errors above.
  echo.
  pause
  exit /b 1
)

node dist\dashboard\server.js

echo.
echo ============================================================
echo   Dashboard stopped. Review any messages above.
echo ============================================================
pause >nul
