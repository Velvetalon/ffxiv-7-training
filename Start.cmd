@echo off
powershell.exe -NoProfile -File "%~dp0Start.ps1" -NoPause %*
if errorlevel 1 (
  echo.
  echo Launch failed. Please keep the error message above.
  pause
)
