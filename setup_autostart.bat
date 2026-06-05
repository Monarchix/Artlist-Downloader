@echo off
setlocal enabledelayedexpansion
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

echo Artlist DL Helper -- Auto-start Setup
echo ========================================
echo.

:: ---- 1. Create the silent VBScript launcher --------------------------------
set "VBS=%DIR%\artlist_launcher.vbs"
(
echo ' Artlist DL Helper - silent launcher ^(no window^)
echo Dim fso, shell, helperPath
echo Set fso   = CreateObject^("Scripting.FileSystemObject"^)
echo Set shell = CreateObject^("WScript.Shell"^)
echo helperPath = fso.GetParentFolderName^(WScript.ScriptFullName^) ^& "\artlist_helper.py"
echo shell.Run "pythonw.exe """ ^& helperPath ^& """", 0, False
) > "%VBS%"

echo [1/3] Created silent launcher:  %VBS%

:: ---- 2. Register artlist:// protocol handler (current user, no admin needed) --
reg add "HKCU\SOFTWARE\Classes\artlist"                    /ve /d "Artlist DL Helper" /f >nul
reg add "HKCU\SOFTWARE\Classes\artlist"                    /v "URL Protocol" /d "" /f >nul
reg add "HKCU\SOFTWARE\Classes\artlist\DefaultIcon"        /ve /d "wscript.exe,0" /f >nul
reg add "HKCU\SOFTWARE\Classes\artlist\shell"              /f >nul
reg add "HKCU\SOFTWARE\Classes\artlist\shell\open"         /f >nul
reg add "HKCU\SOFTWARE\Classes\artlist\shell\open\command" /ve /d "wscript.exe \"%VBS%\"" /f >nul

echo [2/3] Registered artlist:// protocol handler

:: ---- 3. Add to Windows startup (optional) -----------------------------------
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\Artlist DL Helper.bat"
copy /y "%DIR%\Start Artlist Helper.bat" "%SHORTCUT%" >nul

echo [3/3] Added to Windows Startup folder (runs silently at login)
echo.
echo ========================================
echo  Setup complete!
echo.
echo  What happens next:
echo   - The helper now starts AUTOMATICALLY when you open artlist.io
echo   - Chrome will ask ONCE: "Allow artlist.io to open Artlist DL Helper?"
echo     Click [Open] then check "Always allow" -- never asked again after that
echo   - The helper closes itself 5 seconds after your last Artlist tab closes
echo   - It also starts with Windows login (via Startup folder)
echo.
echo  To uninstall:  run uninstall_helper.bat
echo ========================================
echo.
pause
