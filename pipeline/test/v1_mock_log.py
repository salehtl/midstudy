"""v1's midstudy-add with MIDSTUDY_FAL_MOCK_LOG: the same JSON lines the v2 CLI writes (pipeline/src/fal.ts), so a
mocked v1 run and a mocked v2 run on the same inputs can be diffed (endpoint, arguments, the uploaded image's bytes).

    uv run --project pipeline python pipeline/test/v1_mock_log.py <midstudy-add arguments>

v1's code is not changed: MockFal's upload, call and fetch are wrapped here, each record appended as it happens.
"""
import hashlib
import json
import mimetypes
import os
import sys
from pathlib import Path

from midstudy_pipeline import cli, engines


def _log(record: dict) -> None:
    out = os.environ.get("MIDSTUDY_FAL_MOCK_LOG")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


def _queue_url(endpoint: str) -> str:
    run = os.environ.get("FAL_RUN_HOST", "fal.run")
    return f"https://{os.environ.get('FAL_QUEUE_RUN_HOST', 'queue.' + run)}/{endpoint}"


_upload, _call, _fetch = engines.MockFal.upload, engines.MockFal.call, engines.MockFal.fetch


def upload(self, path: Path) -> str:
    url = _upload(self, path)
    data = Path(path).read_bytes()
    _log({"op": "upload", "file": Path(path).name,
          "content_type": mimetypes.guess_type(str(path))[0] or "application/octet-stream",
          "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "url": url})
    return url


def call(self, endpoint: str, args: dict) -> dict:
    _log({"op": "call", "endpoint": endpoint, "url": _queue_url(endpoint), "arguments": args})
    return _call(self, endpoint, args)


def fetch(self, url: str, dest_dir: Path) -> Path:
    out = _fetch(self, url, dest_dir)
    _log({"op": "fetch", "url": url, "file": Path(out).name})
    return out


engines.MockFal.upload, engines.MockFal.call, engines.MockFal.fetch = upload, call, fetch

if __name__ == "__main__":
    cli.main(sys.argv[1:])
