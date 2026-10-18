# NanoCut for Windows (installer and launcher)

`NanoCut-Setup-<version>.exe` installs the whole web workstation (deck generator, Studio, OVITO page, Research analysis,
Graph Studio) on any Windows 10/11 x64 PC: Python 3.12, OVITO 3.16, NumPy, pandas, matplotlib, FastAPI … are inside.
No internet, no Python and no administrator rights are needed on the target PC.

## Build (on the development PC)

```bat
.venv\Scripts\python desktop\build_windows.py
```

Output in `dist\` (ignored by git; the installer is ~0.4 GB, above GitHub's 100 MB file limit — share it by USB/drive,
or attach it to a GitHub Release, which allows 2 GB per file):

| File | Use |
|---|---|
| `NanoCut-Setup-<version>.exe` | double-click → choose folder → Install → Start. Start-menu + desktop shortcut, entry in *Apps & features* |
| `NanoCut-portable-<version>.zip` | unzip anywhere and double-click `NanoCut\NanoCut.exe` (no installation) |

How it is built (`build_windows.py`): the CPython of the project `.venv` (with Tcl/Tk for the file dialogs) + the
packages the workstation needs (dependency closure of `webapp/backend/requirements.txt`, copied from `.venv`; Streamlit
and pip left out) + the Visual C++ runtime DLLs + the application folders. The launcher (`launcher/NanoCut.cs`) and the
installer (`installer/Setup.cs`) are compiled with the .NET Framework `csc.exe` that is part of Windows; the installer
carries the application as a ZIP appended to the executable.

## Installed layout

```
%LOCALAPPDATA%\Programs\NanoCut\
  NanoCut.exe       launcher: starts the backend hidden, opens the app window (Edge/Chrome app mode), stops it on close
  Uninstall.exe     removes the folder, shortcuts and the Apps & features entry
  python\           the bundled Python with all packages
  app\              nanocut/, webapp/, potentials/, reference/, examples/, tools/, docs
%LOCALAPPDATA%\NanoCut\logs\   launcher.log, server.log, check.log
```

## Command line

```bat
NanoCut-Setup-<version>.exe /S /D=C:\Tools\NanoCut          silent install (also /noshortcuts /noregistry)
NanoCut.exe --check                                          start the backend, check API + OVITO, stop (exit code 0 = OK)
NanoCut.exe --browser                                        open in the default browser instead of an app window
Uninstall.exe /S                                             silent uninstall
```

## Notes

- The installer is not code-signed: Windows SmartScreen shows "Windows protected your PC" on first start → *More info* →
  *Run anyway*. Signing needs a code-signing certificate (backlog item in `PLAN_PHASE3.md` §7).
- The app runs only on 127.0.0.1 (nothing is reachable from the network). Dump files are read where they are.
