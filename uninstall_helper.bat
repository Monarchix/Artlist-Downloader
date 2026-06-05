@echo off
REM Removes the auto-start protocol handler and the Startup entry.
reg delete "HKCU\SOFTWARE\Classes\artlist" /f >nul 2>&1
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Artlist DL Helper.bat" >nul 2>&1
del /f /q "%~dp0artlist_launcher.vbs" >nul 2>&1
echo Artlist DL Helper uninstalled (protocol handler + startup entry removed).
pause
