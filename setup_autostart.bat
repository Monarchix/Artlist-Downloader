@echo off
setlocal enabledelayedexpansion
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

set "VBS=%DIR%\artlist_launcher.vbs"
set "WATCHDOG=%DIR%\artlist_watchdog.vbs"
set "TASK=Artlist DL Helper Watchdog"
set "HELPER=%DIR%\artlist_helper.py"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHIM=%STARTUP%\Artlist DL Helper.vbs"
set "LEGACY=%STARTUP%\Artlist DL Helper.bat"

echo Artlist DL Helper -- Auto-start Setup
echo ========================================
echo.

:: ---- 1. Check the files we are about to wire up ----------------------------
if not exist "%VBS%" goto :missing
if not exist "%WATCHDOG%" goto :missing
if not exist "%HELPER%" goto :missing
echo [1/5] Found launcher, watchdog and helper in %DIR%

:: ---- 2. Register artlist:// protocol handler (current user, no admin) -------
:: This is the recovery path: if the helper is ever not running, the "Open
:: folder" button in the userscript fires artlist://start to bring it back.
reg add "HKCU\SOFTWARE\Classes\artlist"                    /ve /d "Artlist DL Helper" /f >nul || goto :regfail
reg add "HKCU\SOFTWARE\Classes\artlist"                    /v "URL Protocol" /d "" /f >nul || goto :regfail
reg add "HKCU\SOFTWARE\Classes\artlist\DefaultIcon"        /ve /d "wscript.exe,0" /f >nul || goto :regfail
reg add "HKCU\SOFTWARE\Classes\artlist\shell"              /f >nul || goto :regfail
reg add "HKCU\SOFTWARE\Classes\artlist\shell\open"         /f >nul || goto :regfail
reg add "HKCU\SOFTWARE\Classes\artlist\shell\open\command" /ve /d "wscript.exe \"%VBS%\"" /f >nul || goto :regfail
echo [2/5] Registered artlist:// protocol handler

:: ---- 3. Start with Windows -------------------------------------------------
:: A .vbs shim rather than the old .bat: a batch file in Startup flashes a
:: console window at every login. The old one is removed here on upgrade.
:: The write is verified -- the previous version copied silently and a failed
:: copy left the helper never starting, with nothing on screen to say so.
if exist "%LEGACY%" del /f /q "%LEGACY%" >nul 2>&1
> "%SHIM%" echo CreateObject("WScript.Shell").Run "wscript.exe ""%VBS%""", 0, False
if not exist "%SHIM%" goto :startupfail
echo [3/5] Added to Windows Startup: %SHIM%

:: ---- 4. Watchdog: restart the helper if it ever dies ------------------------
:: A per-user scheduled task (no admin) that runs the watchdog every minute.
:: It pings the helper and relaunches it only when it does not answer, so a
:: crash, a manual kill, or a login where the startup entry lost the race for
:: the drive heals itself within a minute.
schtasks /create /tn "%TASK%" /tr "wscript.exe \"%WATCHDOG%\"" /sc minute /mo 1 /f >nul 2>&1
if errorlevel 1 goto :taskfail
echo [4/5] Registered watchdog task "%TASK%" ^(checks every minute^)

:: ---- 5. Start it now and prove it answers -----------------------------------
start "" wscript.exe "%VBS%"
set "PINGOK="
for /l %%i in (1,1,10) do (
    if not defined PINGOK (
        curl -s -m 2 -o nul http://127.0.0.1:7842/ping && set "PINGOK=1"
        if not defined PINGOK ping -n 2 127.0.0.1 >nul
    )
)
if not defined PINGOK goto :pingfail
echo [5/5] Helper is running and answering on 127.0.0.1:7842
echo.
echo ========================================
echo  Setup complete -- all five checks passed.
echo.
echo  What happens next:
echo   - The helper starts silently at every Windows login and stays running
echo   - If it ever stops, the watchdog restarts it within a minute
echo   - "Open folder" opens a real Explorer window at the download folder,
echo     automatically after each download (toggle it in the script Settings)
echo   - In the script: gear icon -^> Debug -^> "Check helper" should say
echo     "Helper running"
echo.
echo  To uninstall:  run uninstall_helper.bat
echo ========================================
echo.
pause
exit /b 0

:missing
echo [FAILED] Expected these files next to this script:
echo            %VBS%
echo            %WATCHDOG%
echo            %HELPER%
echo.
echo Run setup_autostart.bat from the folder it was downloaded into.
echo.
pause
exit /b 1

:regfail
echo [FAILED] Could not write to HKCU\SOFTWARE\Classes\artlist.
echo Without it the script cannot restart the helper on its own.
echo.
pause
exit /b 1

:startupfail
echo [FAILED] Could not write the startup entry:
echo            %SHIM%
echo.
echo The helper will not start at login. Check that the Startup folder exists
echo and is writable, then run this again.
echo.
pause
exit /b 1

:taskfail
echo [FAILED] Could not create the scheduled task "%TASK%".
echo.
echo Without it nothing restarts the helper if it stops. Check that Task
echo Scheduler is enabled for your account, then run this again.
echo.
pause
exit /b 1

:pingfail
echo [FAILED] The helper did not answer on 127.0.0.1:7842 within 10 seconds.
echo.
echo Most likely Python is not installed. Get it from python.org and tick
echo "Add python.exe to PATH" during setup, then run this again.
echo To see the actual error, double-click artlist_launcher.vbs on its own.
echo.
pause
exit /b 1
