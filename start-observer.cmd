@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-browser.ps1" -Page observer %*
