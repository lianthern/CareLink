@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0verify-package.cjs"
pause
