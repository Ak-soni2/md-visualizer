# Setting up and running NanoCut (virtual environment)

Nothing here needs LAMMPS or OVITO on your computer. The UI, the deck generation, the geometry preview, the mock
animation and the results visualiser are pure Python. (LAMMPS is only used by the optional *Validate / preview run*
buttons, which look for a runtime in WSL and simply report "not available" otherwise.)

## 1. One-time setup (Windows, PowerShell or cmd)

```bat
cd C:\BTP\md-visulaizer
py -3.12 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Linux / macOS:

```bash
cd md-visulaizer
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Start the visualiser

```bat
run_ui.bat
```
(or `./run_ui.sh`, or manually `streamlit run ui/app.py`). A browser tab opens at http://localhost:8501.

## 3. Generate input files without the UI

```bat
python make_decks.py --list
python make_decks.py --preset "ref_10_10 (Cutting/10-10)" --out runs\my_case
python make_decks.py --preset "ref_10_10 (Cutting/10-10)" --set process.depth_nm=2.0 --set process.speed_ms=100 --out runs\d2_v100
python make_decks.py --params params.json --out runs\from_ui
```

The folder contains `A.in`, `B.in`, the potential file, `run.sh`/`run.bat`, `params.json`, `README.md`.
On the cluster: `mpirun -np 10 lmp -in A.in -log A.log` then `mpirun -np 10 lmp -in B.in -log B.log` in that folder.

## 4. Verify (optional, reproduces VERIFICATION_REPORT.md)

```bat
python -m tests.test_nanocut
python tools\verify_decks.py
python tools\verify_potentials.py      :: needs the WSL LAMMPS runtime
python tools\make_report.py
```

## 5. Files you will touch

| file | purpose |
|---|---|
| `ui/app.py` | the visualiser |
| `make_decks.py` | command-line deck generation |
| `nanocut/presets.py` | add your own presets |
| `BIBLE.md` | all project context in one place |
