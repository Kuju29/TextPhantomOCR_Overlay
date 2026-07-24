@echo off
setlocal
cd /d "%~dp0"
node scripts\test-compat.mjs
if errorlevel 1 exit /b %errorlevel%
node scripts\build.mjs
if errorlevel 1 exit /b %errorlevel%
node scripts\validate.mjs
