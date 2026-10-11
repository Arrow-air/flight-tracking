"""v2.4: storage error handling in the parser.

Supabase storage answers most errors as HTTP 400 with the real code in a
JSON body. The parser used to raise_for_status() and store
"HTTPError: 400 Client Error: Bad Request for url: ..." — which is how a log
whose upload never finished looked like a parse failure. These tests pin the
classification and the text written to flight_logs.error.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
import requests

from arrow_parser import storage as storage_mod
from arrow_parser.storage import ObjectMissingError, Storage, StorageError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import watcher  # noqa: E402


class FakeResponse:
    def __init__(self, status: int, body: str = "", chunks: list[bytes] | None = None):
        self.status_code = status
        self.text = body
        self.reason = "Bad Request" if status == 400 else "OK"
        self._chunks = chunks or []

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 400

    def iter_content(self, _size):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def storage_json(code: str, error: str, message: str) -> str:
    return json.dumps({"statusCode": code, "error": error, "message": message})


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://storage.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    return Storage()


def test_missing_object_raises_object_missing(store, monkeypatch, tmp_path):
    body = storage_json("404", "not_found", "Object not found")
    monkeypatch.setattr(storage_mod.requests, "get",
                        lambda *a, **k: FakeResponse(400, body))
    with pytest.raises(ObjectMissingError) as ei:
        store.download("f1/abc_log.BIN", str(tmp_path / "raw.bin"))
    assert "flight-logs/f1/abc_log.BIN" in str(ei.value)
    assert "Object not found" in str(ei.value)


def test_missing_bucket_is_not_a_missing_object(store, monkeypatch, tmp_path):
    body = storage_json("404", "Bucket not found", "Bucket not found")
    monkeypatch.setattr(storage_mod.requests, "get",
                        lambda *a, **k: FakeResponse(400, body))
    with pytest.raises(StorageError) as ei:
        store.download("f1/abc_log.BIN", str(tmp_path / "raw.bin"))
    assert not isinstance(ei.value, ObjectMissingError)


def test_other_storage_errors_keep_storage_reason(store, monkeypatch, tmp_path):
    body = storage_json("403", "Unauthorized", "Invalid Compact JWS")
    monkeypatch.setattr(storage_mod.requests, "get",
                        lambda *a, **k: FakeResponse(400, body))
    with pytest.raises(StorageError) as ei:
        store.download("f1/abc_log.BIN", str(tmp_path / "raw.bin"))
    msg = str(ei.value)
    assert not isinstance(ei.value, ObjectMissingError)
    assert "HTTP 400" in msg and "403" in msg and "Invalid Compact JWS" in msg


def test_non_json_error_body(store, monkeypatch, tmp_path):
    monkeypatch.setattr(storage_mod.requests, "get",
                        lambda *a, **k: FakeResponse(502, "<html>bad gateway</html>"))
    with pytest.raises(StorageError, match="HTTP 502"):
        store.download("f1/abc_log.BIN", str(tmp_path / "raw.bin"))


def test_download_writes_bytes_on_success(store, monkeypatch, tmp_path):
    monkeypatch.setattr(storage_mod.requests, "get",
                        lambda *a, **k: FakeResponse(200, chunks=[b"abc", b"def"]))
    dest = tmp_path / "raw.bin"
    store.download("f1/abc_log.BIN", str(dest))
    assert dest.read_bytes() == b"abcdef"


def test_upload_not_found_is_plain_storage_error(store, monkeypatch, tmp_path):
    src = tmp_path / "san.bin"
    src.write_bytes(b"x")
    body = storage_json("404", "not_found", "Object not found")
    monkeypatch.setattr(storage_mod.requests, "post",
                        lambda *a, **k: FakeResponse(400, body))
    with pytest.raises(StorageError) as ei:
        store.upload("f1/abc_log.BIN", str(src), bucket="flight-logs-sanitized")
    assert not isinstance(ei.value, ObjectMissingError)


def test_watcher_message_for_missing_raw_object():
    e = ObjectMissingError("download flight-logs/f1/a.BIN: not in storage (Object not found)")
    msg = watcher.error_message(e)
    # the frontend keys "Re-attach" off this prefix (src/lib/logs.ts isUnfinishedUpload)
    assert msg.startswith("upload didn't finish:")
    assert "Re-attach the same .bin" in msg


def test_watcher_message_for_other_errors_unchanged():
    assert watcher.error_message(ValueError("bad header")) == "ValueError: bad header"
    assert watcher.error_message(requests.HTTPError("boom")) == "HTTPError: boom"
