"""Snapshot real API responses into frontend/fixtures/ for the offline demo (frontend deployed without backend).
The frontend labels this mode everywhere ("Offline demo · fixtures"). Run from the project root:

    .venv\\Scripts\\python webapp\\tools\\make_fixtures.py
"""
import datetime
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from fastapi.testclient import TestClient

from webapp.backend.app.main import app

OUT = os.path.join(ROOT, "webapp", "frontend", "fixtures")
SIM = "example-sample-run"
c = TestClient(app)
routes = {}


def save(route, name, data):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    routes[route] = name
    print(f"{route:70s} -> {name} ({os.path.getsize(os.path.join(OUT, name)) // 1024} kB)")


def job(route, method="get"):
    r = getattr(c, method)(route)
    body = r.json()
    if r.status_code == 202:
        while body["status"] not in ("done", "error"):
            time.sleep(0.5)
            body = c.get(f"/api/jobs/{body['id']}").json()
    return body


os.makedirs(OUT, exist_ok=True)
save("/api/simulations", "simulations.json", c.get("/api/simulations").json())
save("/api/tree?depth=2", "tree.json", c.get("/api/tree?depth=2").json())
save(f"/api/simulations/{SIM}", "overview.json", c.get(f"/api/simulations/{SIM}").json())
save(f"/api/simulations/{SIM}/parameters", "parameters.json", c.get(f"/api/simulations/{SIM}/parameters").json())
tr = c.get(f"/api/simulations/{SIM}/trajectory").json()
save(f"/api/simulations/{SIM}/trajectory", "trajectory.json", tr)
for i in range(len(tr["frames"])):
    route = f"/api/simulations/{SIM}/frames/{i}?props=mol,temperature"
    save(route, f"frame_{i}.json", c.get(route + "&max_atoms=15000").json())
save(f"/api/simulations/{SIM}/series", "series.json", c.get(f"/api/simulations/{SIM}/series").json())
save(f"/api/simulations/{SIM}/plots", "plots.json", [])        # images need the backend; offline gallery says so
save("/api/validation", "validation.json", job("/api/validation"))
meta = dict(generated=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), simulation=SIM,
            note="Snapshot of real API responses for the offline demo. Read-only; only the sample run is included.")
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
    json.dump(dict(meta=meta, routes=routes), f, indent=1)
print("index.json written:", len(routes), "routes")
