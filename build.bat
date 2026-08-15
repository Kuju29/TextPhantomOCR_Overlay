@echo off
setlocal
cd /d "%~dp0"
call npm run build
if errorlevel 1 exit /b %errorlevel%
