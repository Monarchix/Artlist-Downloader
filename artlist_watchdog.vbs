' Artlist DL Helper - watchdog (no window)
'
' Run every minute by the "Artlist DL Helper Watchdog" scheduled task that
' setup_autostart.bat registers. Pings the helper; if it does not answer, starts
' it through artlist_launcher.vbs. A healthy helper costs one local HTTP request
' and nothing else, so the launcher (and its interpreter search) only runs when
' the helper has actually gone away.

Option Explicit

Const HELPER_PING = "http://127.0.0.1:7842/ping"
Const PING_TIMEOUT_MS = 1500

Dim fso, shell, launcher

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

launcher = fso.GetParentFolderName(WScript.ScriptFullName) & "\artlist_launcher.vbs"

If Not HelperAnswers() Then
    If fso.FileExists(launcher) Then
        shell.Run "wscript.exe """ & launcher & """", 0, False
    End If
End If

' True only for the helper's own reply, so some other program that happens to
' hold port 7842 is not mistaken for a healthy helper.
Function HelperAnswers()
    Dim http

    HelperAnswers = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then Exit Function
    http.setTimeouts PING_TIMEOUT_MS, PING_TIMEOUT_MS, PING_TIMEOUT_MS, PING_TIMEOUT_MS
    http.open "GET", HELPER_PING, False
    http.send
    If Err.Number = 0 Then
        HelperAnswers = (http.status = 200 And http.responseText = "artlist-dl-helper")
    End If
    Err.Clear
    On Error GoTo 0
End Function
