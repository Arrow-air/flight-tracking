"""Supabase Storage HTTP client (service-role) for the parser.

Env:
  SUPABASE_URL               (default http://127.0.0.1:54321 — local stack)
  SUPABASE_SERVICE_ROLE_KEY  (required for the watcher; never the anon key)
  STORAGE_BUCKET             raw uploads (default 'flight-logs' — matches
                             migration 20260810210500_storage.sql)
  SANITIZED_BUCKET           parser-written GPS-stripped copies (default
                             'flight-logs-sanitized' per the same migration)
"""

from __future__ import annotations

import json
import os

import requests

DEFAULT_URL = "http://127.0.0.1:54321"
DEFAULT_BUCKET = "flight-logs"
DEFAULT_SANITIZED_BUCKET = "flight-logs-sanitized"


class StorageError(RuntimeError):
    """A storage request failed. The message carries storage's own reason:
    storage answers most errors as HTTP 400 with the real code in a JSON
    body ({"statusCode": "404", "error": "not_found", ...}), so the bare
    HTTP status alone is misleading."""


class ObjectMissingError(StorageError):
    """The object isn't in the bucket. For a raw log this means the upload
    never finished (the flight_logs row exists, its bytes don't)."""


def _storage_reason(r: requests.Response) -> tuple[str, str]:
    """(code, human message) from a storage error response."""
    body = r.text[:500]
    try:
        j = json.loads(body)
    except ValueError:
        return str(r.status_code), body.strip() or r.reason
    code = str(j.get("statusCode") or j.get("error") or r.status_code)
    msg = j.get("message") or j.get("error") or body
    return code, str(msg)


def _raise_for_storage(r: requests.Response, what: str,
                       missing_means_object: bool = False) -> None:
    if r.ok:
        return
    code, msg = _storage_reason(r)
    missing = (code in ("404", "not_found")
               or "object not found" in msg.lower())
    if missing_means_object and missing and "bucket" not in msg.lower():
        raise ObjectMissingError(f"{what}: not in storage ({msg})")
    raise StorageError(f"{what}: HTTP {r.status_code} ({code}: {msg})")


class Storage:
    def __init__(self) -> None:
        self.base = os.environ.get("SUPABASE_URL", DEFAULT_URL).rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        self.bucket = os.environ.get("STORAGE_BUCKET", DEFAULT_BUCKET)
        self.sanitized_bucket = os.environ.get(
            "SANITIZED_BUCKET", DEFAULT_SANITIZED_BUCKET)
        if not self.key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY not set")
        self._headers = {
            "Authorization": f"Bearer {self.key}",
            "apikey": self.key,
        }

    def download(self, object_path: str, dest_path: str,
                 bucket: str | None = None) -> None:
        bucket = bucket or self.bucket
        url = f"{self.base}/storage/v1/object/{bucket}/{object_path}"
        with requests.get(url, headers=self._headers, stream=True,
                          timeout=300) as r:
            _raise_for_storage(r, f"download {bucket}/{object_path}",
                               missing_means_object=True)
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)

    def upload(self, object_path: str, src_path: str,
               bucket: str | None = None,
               content_type: str = "application/octet-stream") -> None:
        bucket = bucket or self.bucket
        url = f"{self.base}/storage/v1/object/{bucket}/{object_path}"
        with open(src_path, "rb") as f:
            r = requests.post(
                url, headers={**self._headers,
                              "Content-Type": content_type,
                              "x-upsert": "true"},
                data=f, timeout=600)
        _raise_for_storage(r, f"upload {bucket}/{object_path}")
