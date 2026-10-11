"""Minimal in-process background jobs (thread pool, de-duplicated by key). No queue/database needed at this scale."""
import os
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="nanocut-job")
# Serverless (Vercel): memory is not shared between invocations, so a job polled later may land on another instance.
# There every job runs inside the request that starts it and the response carries the result (status "done").
INLINE = bool(os.environ.get("VERCEL") or os.environ.get("NANOCUT_INLINE_JOBS"))
_lock = threading.Lock()
_jobs = {}          # id -> record
_by_key = {}        # key -> id (latest)


def submit(key, label, fn, *args, **kwargs):
    """Start fn in the background unless a job with the same key is queued/running/finished OK. Returns the record."""
    with _lock:
        jid = _by_key.get(key)
        if jid and _jobs[jid]["status"] in ("queued", "running", "done"):
            return _jobs[jid]
        jid = uuid.uuid4().hex[:12]
        rec = dict(id=jid, key=key, label=label, status="queued", progress=0.0, message="", result=None, error=None,
                   created=time.time(), started=None, finished=None)
        _jobs[jid] = rec
        _by_key[key] = jid

    def progress(frac, msg=""):
        rec["progress"] = float(frac)
        rec["message"] = msg

    def run():
        rec["status"] = "running"
        rec["started"] = time.time()
        try:
            rec["result"] = fn(*args, progress=progress, **kwargs)
            rec["status"] = "done"
            rec["progress"] = 1.0
        except Exception as e:                       # report, never crash the server
            rec["status"] = "error"
            rec["error"] = f"{type(e).__name__}: {e}"
            rec["trace"] = traceback.format_exc(limit=4)
        rec["finished"] = time.time()

    if INLINE:
        run()
    else:
        _pool.submit(run)
    return rec


def forget(key):
    with _lock:
        _by_key.pop(key, None)


def by_key(key):
    jid = _by_key.get(key)
    return _jobs.get(jid) if jid else None


def get(jid):
    return _jobs.get(jid)


def public(rec, with_result=True):
    if rec is None:
        return None
    keys = ["id", "key", "label", "status", "progress", "message", "error", "created", "started", "finished"]
    out = {k: rec.get(k) for k in keys}
    if with_result and rec.get("status") == "done":
        out["result"] = rec.get("result")
    return out
