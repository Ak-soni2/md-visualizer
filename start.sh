#!/usr/bin/env bash
# NanoCut MD workstation - one-command start (Linux / macOS):  bash start.sh
# Creates .venv (again if it was copied from another computer), installs the packages when the requirement files
# change, and starts the app on http://127.0.0.1:8600/app/ . Needs Python 3.10-3.13 (python3).
set -e
cd "$(dirname "$0")"
PORT=${PORT:-8600}
PY=""
for p in python3.12 python3.11 python3.13 python3.10 python3; do
  if command -v "$p" >/dev/null && "$p" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)'; then PY="$p"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.10-3.13 not found: install python3.12 (e.g. sudo apt install python3.12 python3.12-venv)"; exit 1; }
if ! .venv/bin/python -c 'import sys' 2>/dev/null; then
  echo "Creating the virtual environment .venv ..."
  "$PY" -m venv --clear .venv
  rm -f .venv/.nanocut-requirements
fi
cat requirements.txt webapp/backend/requirements.txt > /tmp/nanocut-req.txt
if ! cmp -s /tmp/nanocut-req.txt .venv/.nanocut-requirements; then
  echo "Installing the required packages (first start: a few minutes, about 1 GB with OVITO) ..."
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt -r webapp/backend/requirements.txt
  cp /tmp/nanocut-req.txt .venv/.nanocut-requirements
fi
URL="http://127.0.0.1:$PORT/app/"
echo; echo "  NanoCut is starting on  $URL   (Ctrl+C to stop)"; echo
( sleep 4; (command -v xdg-open >/dev/null && xdg-open "$URL") || (command -v open >/dev/null && open "$URL") || true ) >/dev/null 2>&1 &
exec .venv/bin/python -m uvicorn webapp.backend.app.main:app --host 127.0.0.1 --port "$PORT"
