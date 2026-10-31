@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0launch-local.cjs"
if errorlevel 1 pause
