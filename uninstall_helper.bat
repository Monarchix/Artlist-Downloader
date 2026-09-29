@echo off
REM Removes the artlist:// protocol handler, the startup entry, and stops the
REM running helper. Leaves artlist_launcher.vbs alone -- it ships with the repo.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

REM Remove the watchdog first, or it would relaunch the helper we stop below.
schtasks /delete /tn "Artlist DL Helper Watchdog" /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Classes\artlist" /f >nul 2>&1
del /f /q "%STARTUP%\Artlist DL Helper.vbs" >nul 2>&1
del /f /q "%STARTUP%\Artlist DL Helper.bat" >nul 2>&1

REM Stop the running instance so the port is free and nothing lingers until
REM the next reboot.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*127.0.0.1:7842.*LISTENING"') do taskkill /f /pid %%p >nul 2>&1

echo Artlist DL Helper uninstalled.
echo   - artlist:// protocol handler removed
echo   - watchdog task removed
echo   - startup entry removed
echo   - running helper stopped
pause
