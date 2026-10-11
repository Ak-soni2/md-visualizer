"""Vercel Blob (private store) for the hosted backend: uploads from the browser and result files for the browser.

Serverless instances share no disk, so on Vercel a dump uploaded in one request must be readable by the instance that
serves the next one, and a rendered image or a ZIP must be downloadable from any instance. Both go through the
project's private Blob store (env BLOB_READ_WRITE_TOKEN, set by `vercel blob create-store --access private`):
  - the browser uploads straight to Blob with a short-lived client token limited to one pathname (client_token),
  - instances download those files when OVITO needs them (download),
  - results are uploaded by the instance and handed to the browser as presigned GET URLs valid for an hour.
Protocol as implemented by the official @vercel/blob client (API version 12). Standard library only.
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request

API = os.environ.get("VERCEL_BLOB_API_URL", "https://vercel.com/api/blob")
VERSION = "12"
UPLOAD_PREFIX, OUTPUT_PREFIX = "uploads/", "outputs/"
_delegation = {}


def token():
    return os.environ.get("BLOB_READ_WRITE_TOKEN", "")


def enabled():
    return token().startswith("vercel_blob_rw_")


def store_id():
    return token().split("_")[3]


def _b64(b):
    return base64.b64encode(b).decode()


def _request(method, url, body=None, headers=None, timeout=300):
    h = {"authorization": f"Bearer {token()}", "x-api-version": VERSION, "x-vercel-blob-store-id": store_id(), **(headers or {})}
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Blob {method} {urllib.parse.urlparse(url).path}: {e.code} {e.read()[:300].decode('utf-8', 'replace')}") from None


def client_token(pathname, max_bytes, valid_s=3600):
    """Token for the browser to upload exactly `pathname` (at most max_bytes), signed with the store's read-write token."""
    payload = _b64(json.dumps({"pathname": pathname, "maximumSizeInBytes": int(max_bytes), "allowOverwrite": True,   # compact, as JSON.stringify
                               "validUntil": int((time.time() + valid_s) * 1000)}, separators=(",", ":")).encode())
    key = hmac.new(token().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"vercel_blob_client_{store_id()}_{_b64(f'{key}.{payload}'.encode())}"


def blob_url(pathname):
    return f"https://{store_id()}.private.blob.vercel-storage.com/{pathname}"


def put_file(local, pathname, content_type="application/octet-stream"):
    """Upload a local file (the server's own results). Files above 64 MB go up in 8 MB parts."""
    size = os.path.getsize(local)
    head = {"x-vercel-blob-access": "private", "x-content-type": content_type, "x-allow-overwrite": "1"}
    q = urllib.parse.urlencode({"pathname": pathname})
    if size <= 64 << 20:
        with open(local, "rb") as f:
            return json.load(_request("PUT", f"{API}/?{q}", f.read(), head))
    up = json.load(_request("POST", f"{API}/mpu?{q}", None, {**head, "x-mpu-action": "create"}))
    parts, n = [], 1
    with open(local, "rb") as f:
        while chunk := f.read(8 << 20):
            r = json.load(_request("POST", f"{API}/mpu?{q}", chunk, {**head, "x-mpu-action": "upload", "x-mpu-key": urllib.parse.quote(up["key"]),
                                                                     "x-mpu-upload-id": up["uploadId"], "x-mpu-part-number": str(n)}))
            parts.append({"etag": r["etag"], "partNumber": n})
            n += 1
    return json.load(_request("POST", f"{API}/mpu?{q}", json.dumps(parts).encode(), {**head, "content-type": "application/json", "x-mpu-action": "complete",
                                                                                    "x-mpu-key": urllib.parse.quote(up["key"]), "x-mpu-upload-id": up["uploadId"]}))


def download(pathname, dest, progress=None):
    """Private blob -> local file (streamed)."""
    r = _request("GET", blob_url(pathname), timeout=600)
    total, done = int(r.headers.get("content-length") or 0), 0
    tmp = f"{dest}.part"
    with open(tmp, "wb") as f:
        while chunk := r.read(4 << 20):
            f.write(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)
    os.replace(tmp, dest)


def presign_get(pathname):
    """GET URL for a private blob that needs no credentials, valid up to an hour (one delegation per instance)."""
    d = _delegation.get("get")
    if not d or d["validUntil"] < time.time() * 1000 + 600_000:
        until = int((time.time() + 3600) * 1000)
        r = json.load(_request("POST", f"{API}/signed-token", json.dumps({"pathname": "*", "operations": ["get"], "validUntil": until}).encode(),
                               {"content-type": "application/json"}))
        d = _delegation["get"] = dict(r, validUntil=until)
    canonical = "\n".join(sorted(["operation=get", f"pathname={pathname}"]))
    sig = base64.urlsafe_b64encode(hmac.new(d["clientSigningToken"].encode(), canonical.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return blob_url(pathname) + "?" + urllib.parse.urlencode({"vercel-blob-delegation": d["delegationToken"], "vercel-blob-signature": sig})


def publish(local, name, content_type="application/octet-stream"):
    """A result file -> presigned download URL (kept for a day)."""
    pathname = f"{OUTPUT_PREFIX}{time.strftime('%Y%m%d')}/{os.urandom(8).hex()}/{name}"
    put_file(local, pathname, content_type)
    return presign_get(pathname)


def cleanup(max_age_s=24 * 3600):
    """Delete uploads and outputs older than a day (best effort; called when an upload starts)."""
    try:
        old, cursor = [], None
        for _ in range(20):
            q = {"limit": "1000", **({"cursor": cursor} if cursor else {})}
            r = json.load(_request("GET", f"{API}?{urllib.parse.urlencode(q)}", timeout=30))
            for b in r.get("blobs", []):
                up = b.get("uploadedAt", "")
                try:
                    t = time.mktime(time.strptime(up[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
                except ValueError:
                    continue
                if time.time() - t > max_age_s:
                    old.append(b["url"])
            cursor = r.get("cursor")
            if not r.get("hasMore"):
                break
        for i in range(0, len(old), 500):
            _request("POST", f"{API}/delete", json.dumps({"urls": old[i:i + 500]}).encode(), {"content-type": "application/json"}, timeout=60)
        return len(old)
    except Exception:
        return 0
