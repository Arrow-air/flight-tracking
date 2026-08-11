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

import os

import requests

DEFAULT_URL = "http://127.0.0.1:54321"
DEFAULT_BUCKET = "flight-logs"
DEFAULT_SANITIZED_BUCKET = "flight-logs-sanitized"


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
        url = (f"{self.base}/storage/v1/object/"
               f"{bucket or self.bucket}/{object_path}")
        with requests.get(url, headers=self._headers, stream=True,
                          timeout=300) as r:
            r.raise_for_status()
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)

    def upload(self, object_path: str, src_path: str,
               bucket: str | None = None,
               content_type: str = "application/octet-stream") -> None:
        url = (f"{self.base}/storage/v1/object/"
               f"{bucket or self.bucket}/{object_path}")
        with open(src_path, "rb") as f:
            r = requests.post(
                url, headers={**self._headers,
                              "Content-Type": content_type,
                              "x-upsert": "true"},
                data=f, timeout=600)
        r.raise_for_status()
