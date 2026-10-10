@echo off
rem NanoCut web app: FastAPI backend + static frontend at http://127.0.0.1:8600
cd /d "%~dp0\.."
if not exist .venv\Scripts\python.exe (
  echo Project virtual environment not found. Create it first, see SETUP.md
  exit /b 1
)
.venv\Scripts\python.exe -c "import fastapi" 2>nul || .venv\Scripts\python.exe -m pip install -r webapp\backend\requirements.txt
echo Open http://127.0.0.1:8600  (API docs: http://127.0.0.1:8600/docs)
.venv\Scripts\python.exe -m uvicorn webapp.backend.app.main:app --host 127.0.0.1 --port 8600
