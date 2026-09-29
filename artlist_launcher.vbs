' Artlist DL Helper - silent launcher (no console window)
'
' Resolves the interpreter explicitly instead of letting PATH decide. Windows
' ships %LOCALAPPDATA%\Microsoft\WindowsApps\pythonw.exe as a Microsoft Store
' app-execution alias, and it frequently sits ahead of the real install on PATH;
' when Store Python isn't there, launching it opens the Store instead of running
' the script - and because this launcher runs hidden, that failure is invisible.

Option Explicit

Dim fso, shell, env, helperPath, exe

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set env   = shell.Environment("PROCESS")

helperPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\artlist_helper.py"

If Not fso.FileExists(helperPath) Then
    WScript.Echo "Artlist DL Helper" & vbCrLf & vbCrLf & _
                 "artlist_helper.py is missing next to this launcher:" & vbCrLf & helperPath
    WScript.Quit 1
End If

exe = FindPythonw()

If exe = "" Then
    WScript.Echo "Artlist DL Helper" & vbCrLf & vbCrLf & _
                 "No Python interpreter found." & vbCrLf & vbCrLf & _
                 "Install Python from python.org (tick ""Add python.exe to PATH""), " & _
                 "then run setup_autostart.bat again."
    WScript.Quit 1
End If

shell.Run """" & exe & """ """ & helperPath & """", 0, False


' ---- interpreter discovery ---------------------------------------------------
' First hit wins. The helper is pure standard library, so any Python 3 will do.
Function FindPythonw()
    Dim roots, direct, r, hit

    ' 1. A real pythonw.exe. This is the only binary that is guaranteed never to
    '    open a console window, so it is worth hunting for before falling back to
    '    a launcher shim. Covers both the classic Programs\Python\Python3xx
    '    layout and the newer Python Manager one (LOCALAPPDATA\Python\
    '    pythoncore-3.xx-64, plus its \bin shim folder).
    roots = Array( _
        env("LOCALAPPDATA") & "\Programs\Python", _
        env("LOCALAPPDATA") & "\Python", _
        env("ProgramFiles") & "\Python", _
        "C:\")
    For Each r In roots
        hit = ScanForPythonw(r)
        If hit <> "" Then
            FindPythonw = hit
            Exit Function
        End If
    Next

    ' 2. Walk PATH ourselves, so the Store alias can be skipped.
    hit = ResolveOnPath("pythonw.exe")
    If hit <> "" Then
        FindPythonw = hit
        Exit Function
    End If

    ' 3. Last resort: the pyw launcher. It resolves an interpreter for us, but
    '    which one - and whether that one is console-free - is up to the launcher.
    direct = Array( _
        env("LOCALAPPDATA") & "\Programs\Python\Launcher\pyw.exe", _
        env("WINDIR") & "\pyw.exe")
    For Each r In direct
        If IsUsable(r) Then
            FindPythonw = r
            Exit Function
        End If
    Next

    FindPythonw = ""
End Function

' Looks for pythonw.exe directly in root and one level below it.
Function ScanForPythonw(root)
    Dim folder, child, candidate

    ScanForPythonw = ""
    If root = "" Then Exit Function
    If Not fso.FolderExists(root) Then Exit Function

    candidate = fso.BuildPath(root, "pythonw.exe")
    If IsUsable(candidate) Then
        ScanForPythonw = candidate
        Exit Function
    End If

    ' Enumeration can trip over folders we cannot read (System Volume
    ' Information and friends when root is C:\), which must not abort the search.
    On Error Resume Next
    Set folder = fso.GetFolder(root)
    If Err.Number <> 0 Then
        Err.Clear
        Exit Function
    End If
    For Each child In folder.SubFolders
        candidate = fso.BuildPath(child.Path, "pythonw.exe")
        If IsUsable(candidate) Then
            ScanForPythonw = candidate
            Exit For
        End If
    Next
    Err.Clear
    On Error GoTo 0
End Function

Function ResolveOnPath(exeName)
    Dim parts, p, candidate

    ResolveOnPath = ""
    parts = Split(env("PATH"), ";")
    For Each p In parts
        If Trim(p) <> "" Then
            candidate = fso.BuildPath(Trim(p), exeName)
            If IsUsable(candidate) Then
                ResolveOnPath = candidate
                Exit Function
            End If
        End If
    Next
End Function

' A real executable, and never the Store app-execution alias.
Function IsUsable(path)
    IsUsable = False
    If path = "" Then Exit Function
    If InStr(1, path, "\WindowsApps\", vbTextCompare) > 0 Then Exit Function
    IsUsable = fso.FileExists(path)
End Function
