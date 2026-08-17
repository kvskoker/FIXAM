@echo off
REM FIXAM Docker start helper (Windows).
REM Thin wrapper around start.ps1, which checks ports and then starts the stack.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
