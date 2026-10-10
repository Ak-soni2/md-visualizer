#!/bin/bash
# NanoCut web app: FastAPI backend + static frontend at http://127.0.0.1:8600
cd "$(dirname "$0")/.."
PY=.venv/bin/python; [ -x "$PY" ] || PY=.venv/Scripts/python.exe
"$PY" -c "import fastapi" 2>/dev/null || "$PY" -m pip install -r webapp/backend/requirements.txt
echo "Open http://127.0.0.1:8600  (API docs: /docs)"
exec "$PY" -m uvicorn webapp.backend.app.main:app --host 127.0.0.1 --port 8600
