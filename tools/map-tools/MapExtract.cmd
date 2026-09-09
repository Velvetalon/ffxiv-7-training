@echo off
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-mapextract.ps1" %*
exit /b %ERRORLEVEL%
