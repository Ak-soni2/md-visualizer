# NanoCut Studio for Windows (installer, launcher, automatic builds)

**The file to share: `NanoCut-Studio-Setup.exe`.** It installs the whole workstation (deck generator, Studio, OVITO page,
Research analysis, Graph Studio) on any Windows 10/11 x64 PC: Python 3.12, OVITO 3.16, NumPy, pandas, matplotlib,
FastAPI … are inside. No internet, no Python and no administrator rights are needed on the target PC.

Newest installer, always (share this link):
https://github.com/Ak-soni2/md-visualizer/releases/latest/download/NanoCut-Studio-Setup.exe

## Automatic builds and updates (CI/CD)

`.github/workflows/windows-installer.yml` runs on every push to `main` (a merged pull request is a push to `main`;
pushes that change only `*.md` files are skipped) and by hand (*Actions → Windows installer → Run workflow*):

1. installs the packages on a Windows runner, runs `python -m tests.test_research`;
2. builds the installer with `desktop/build_windows.py`;
3. tests it: silent install, `NanoCut.exe --check` (backend, OVITO worker, app), silent uninstall;
4. publishes release `v<version>` (version = app version + UTC build time, e.g. `0.3.0.202610181712`) with
   `NanoCut-Studio-Setup.exe` and `NanoCut-Studio-portable.zip`, marked *latest*.

Installed copies ask GitHub for the latest release a few seconds after start. When it is newer, a dialog offers it:
*Yes* downloads the installer, closes NanoCut Studio, installs into the same folder silently and starts it again;
*No* skips that version; *Cancel* asks next time. `NanoCut.exe --no-update` (or `NANOCUT_NO_UPDATE=1`) turns the check off.
Copies installed from release v0.3.0 (before the updater existed) need the new installer once by hand.

## Build locally

```bat
.venv\Scripts\python desktop\build_windows.py
```

| Output | Use |
|---|---|
| `NanoCut-Studio-Setup.exe` (project folder and `dist\`) | double-click → choose folder → Install → Start. Start-menu + desktop shortcut "NanoCut Studio", entry in *Apps & features* |
| `dist\NanoCut-Studio-Setup-<version>.exe` | the same, with the version in the name |
| `dist\NanoCut-Studio-portable.zip` | unzip anywhere and double-click `NanoCut\NanoCut.exe` (no installation) |

The installer is ~0.26 GB, above GitHub's 100 MB file limit, so it is not committed (ignored by git); releases allow 2 GB.

How it is built: the CPython the `.venv` was made from (with Tcl/Tk for the file dialogs) + the packages the workstation
needs (dependency closure of `webapp/backend/requirements.txt`, copied from `.venv`; Streamlit and pip left out) + the
Visual C++ runtime DLLs + the application folders. The launcher (`launcher/NanoCut.cs`) and installer
(`installer/Setup.cs`) are compiled with the .NET Framework `csc.exe` that is part of Windows, together with a generated
`BuildInfo.cs` (version, repository, asset name); the installer carries the application as a ZIP appended to itself.

## Installed layout

```
%LOCALAPPDATA%\Programs\NanoCut\
  NanoCut.exe       launcher: starts the backend hidden, opens the app window (Edge/Chrome app mode) only once the
                    backend answers, stays in the notification area (double-click = open again; right-click = logs,
                    quit), stops the backend ~3 min after the last window closed (never during a job), restarts a
                    crashed backend, checks for updates
  Uninstall.exe     removes the folder, shortcuts and the Apps & features entry
  version.txt       installed version
  python\           the bundled Python with all packages
  app\              nanocut/, webapp/, potentials/, reference/, examples/, tools/, docs
%LOCALAPPDATA%\NanoCut\logs\   launcher.log (also update checks), server.log, check.log
```

## Command line

```bat
NanoCut-Studio-Setup.exe /S /D=C:\Tools\NanoCut          silent install (also /noshortcuts /noregistry; /launch starts it after)
NanoCut.exe --check                                      start the backend, check API + OVITO, stop (exit code 0 = OK)
NanoCut.exe --browser                                    open in the default browser instead of an app window
NanoCut.exe --no-update                                  no update check
Uninstall.exe /S                                         silent uninstall
```

## Notes

- Not code-signed: SmartScreen may show "Windows protected your PC" → *More info* → *Run anyway* (signing needs a
  certificate; backlog in `PLAN_PHASE3.md` §7).
- The app listens only on 127.0.0.1. Dump files are read where they are.
