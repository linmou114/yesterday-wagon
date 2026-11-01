@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set RESULT=%ERRORLEVEL%

echo.
if not "%RESULT%"=="0" echo [deploy] Some steps failed, scroll up for details.
echo.
pause
exit /b %RESULT%
