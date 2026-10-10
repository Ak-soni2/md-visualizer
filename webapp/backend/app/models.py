"""Model summaries (atom counts, box, tool position). Runs carry one in params.json (written by NanoCut at
generation time); presets and reference decks need geometry.Model, which is built in a background job and cached."""
import hashlib
import json
from functools import lru_cache

from nanocut.deck import model_summary
from nanocut.geometry import Model
from nanocut.schema import Experiment

from . import catalog, jobs


def _key(exp):
    return "model:" + hashlib.sha1(json.dumps(exp, sort_keys=True).encode()).hexdigest()[:16]


@lru_cache(maxsize=12)
def _build(exp_json):
    m = Model(Experiment.from_json(exp_json))
    s = model_summary(m)
    s["laser_center_A"] = list(m.laser_center)
    s["laser_radius_A"] = m.laser_radius
    s["tool_outline_A"] = [[round(x, 3), round(y, 3)] for x, y in m.tool_outline()]
    return s, m


def build_summary(exp, progress=None):
    if progress:
        progress(0.1, "enumerating lattice")
    s, _ = _build(json.dumps(exp, sort_keys=True))
    return s


def model_object(exp):
    """Live Model (cached). Only call from background jobs: it enumerates every atom."""
    return _build(json.dumps(exp, sort_keys=True))[1]


def summary_for(sim, start=True):
    """Return (summary, job_record). For runs the stored summary is used directly (provenance: params.json)."""
    if sim["kind"] == "run":
        pj = catalog.params_json(sim) or {}
        return pj.get("model"), None
    exp = catalog.experiment_dict(sim)
    if not exp:
        return None, None
    key = _key(exp)
    rec = jobs.by_key(key)
    if rec and rec["status"] == "done":
        return rec["result"], rec
    if start and (rec is None or rec["status"] == "error"):
        if rec is not None:
            jobs.forget(key)
        rec = jobs.submit(key, f"model of {sim['label']}", build_summary, exp)
    return None, rec
