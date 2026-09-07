@echo off
REM Windows launcher. Installs deps for THIS machine on first run (or after moving
REM the project from another OS), then starts the app. Double-click or run: run.cmd
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required ^(https://nodejs.org^). Install Node 18+ and re-run.
  exit /b 1
)
node scripts/bootstrap.mjs
