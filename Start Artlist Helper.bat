@echo off
REM ============================================================
REM  Starts the Artlist DL Helper silently (no console window).
REM
REM  - Double-click this file to start it for the current session, OR
REM  - Run setup_autostart.bat once so it starts at every login.
REM
REM  Goes through artlist_launcher.vbs so it uses the same interpreter
REM  discovery as the startup entry -- calling pythonw directly picks up
REM  whatever is first on PATH, which on Windows is often the Microsoft
REM  Store alias that opens the Store instead of running the script.
REM ============================================================

start "" wscript.exe "%~dp0artlist_launcher.vbs"
