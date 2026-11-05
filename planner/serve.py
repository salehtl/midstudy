#!/usr/bin/env python3
"""midstudy planner server (stdlib only).

Serves the planner and a JSON API: scenes (one uploaded room photo each, calibrated by `midstudy-calib` in a job
queue), each scene's layouts, "Render" (a paid fal image edit of the photo with the furniture, with the scene photo as
a reference and an optional keep-room composite) and the furniture library (adds through `midstudy-add`, edits, trash
and restore). Every request needs a loopback Host (or one given with --allowed-host), every mutation needs
`X-Midstudy: 1` and a same-origin (or absent) Origin, and paid calls stay under a daily spend cap.
See contract/CONTRACT.md §2 (carried from nook) and §4.4 / §4.7 (scenes, render).

    python3 planner/serve.py [--port 8765] [--host 127.0.0.1] [--scenes-dir scenes] [--layouts-dir layouts]
                             [--renders-dir renders] [--library-dir library] [--costs-file <library-dir>/costs.csv]
                             [--calib "uv run --project calib midstudy-calib"]
                             [--midstudy-add "uv run --project pipeline midstudy-add"] [--daily-spend-usd 2]
                             [--allowed-host NAME ...]

Relative paths are resolved against the repo root. FAL_KEY comes from the environment, else from <repo>/.env (unless
MIDSTUDY_NO_DOTENV=1). With MIDSTUDY_FAL_MOCK set, /api/render makes no network calls (and midstudy-add replays
recorded responses). MIDSTUDY_FETCH_ALLOW=<host>:<port> (evals only) lets the URL fetcher reach that one address.
--calib and --midstudy-add are split like a shell would (shlex) once at startup and always run as an argument list,
never through a shell; nothing a client sends ever becomes part of a command (only paths the server made).
"""
import argparse
import contextlib
import fcntl
import http.client
import base64
import binascii
import csv
import io
import ipaddress
import json
import math
import os
import posixpath
import queue
import re
import secrets
import shlex
import socket
import ssl
import stat
import struct
import subprocess
import sys
import shutil
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

REPO = Path(__file__).resolve().parent.parent
# \Z, not $: "$" also matches before a trailing newline, so "evil\n" would pass as a slug.
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}\Z")
MAX_BODY = 32 * 1024 * 1024
MAX_THUMB = 2 * 1024 * 1024

# --- render this view (contract §2.6) -------------------------------------------------------
RENDER_MODELS = {
    "kontext": {"endpoint": "fal-ai/flux-pro/kontext", "image_key": "image_url", "cost": lambda mp: 0.04},
    "nano-banana": {"endpoint": "fal-ai/nano-banana/edit", "image_key": "image_urls", "cost": lambda mp: 0.0398},
    "qwen": {"endpoint": "fal-ai/qwen-image-edit", "image_key": "image_url", "cost": lambda mp: round(0.03 * mp, 4)},
}
DEFAULT_RENDER_PROMPT = (
    "Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, "
    "room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, "
    "soft natural daylight, subtle contact shadows. Do not add, remove or move anything."
)
# nano-banana with the scene photo as image 2 (contract §4.7)
REFERENCE_RENDER_PROMPT = (
    "Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. "
    "Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, "
    "reflections and contact shadows that match the room's light. Keep the camera, the room and everything already in "
    "it exactly as in image 2. Keep each piece of furniture's position, size, shape and color. Do not add, remove or "
    "move anything."
)
RENDER_NAME = re.compile(r"^render-\d{8}-\d{6}(-\d+)?\Z")
COSTS_HEADER = ["date", "id", "engine", "cost_usd", "mock", "input"]
FAL_TIMEOUT = 300
NO_KEY = "FAL_KEY not set: add FAL_KEY=... to midstudy/.env"
render_lock = threading.Lock()
reserved_names: set[str] = set()


def fal_mock() -> bool:
    return bool(os.environ.get("MIDSTUDY_FAL_MOCK"))


def fal_key() -> str | None:
    """FAL_KEY from the environment, else from <repo>/.env (unless MIDSTUDY_NO_DOTENV=1), same as the pipeline. Never logged."""
    if os.environ.get("FAL_KEY"):
        return os.environ["FAL_KEY"]
    if os.environ.get("MIDSTUDY_NO_DOTENV", "") not in ("", "0"):
        return None
    try:
        lines = (REPO / ".env").read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        key, sep, value = line.strip().removeprefix("export ").strip().partition("=")
        if sep and key.strip() == "FAL_KEY":
            value = value.strip().strip("'\"")
            if value:
                return value
    return None


def jpeg_size(data: bytes):
    """(width, height) from a JPEG's frame header (SOF), or None. Fill bytes and the markers that carry no length
    (TEM, RST0-7, a stray SOI) are stepped over, as decoders do; the frame header must come before the first scan."""
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 1 < len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:  # standalone: no length
            i += 2
            continue
        if marker in (0xD9, 0xDA) or i + 9 >= len(data):  # EOI or a scan before any frame header, or truncated
            return None
        length = (data[i + 2] << 8) | data[i + 3]
        if length < 2:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            w, h = (data[i + 7] << 8) | data[i + 8], (data[i + 5] << 8) | data[i + 6]
            return (w, h) if w and h else None
        i += 2 + length
    return None


def fmt_cost(cost: float) -> str:
    return f"{cost:.2f}" if round(cost, 2) == round(cost, 6) else f"{cost:.4f}"


@contextlib.contextmanager
def costs_locked(path: Path):
    """costs.csv.lock (flock) next to costs.csv: the small lock midstudy-add's cost rows take too (§2.9), never the
    library lock, so a render never waits for a running midstudy-add."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def append_cost(path: Path, date: str, name: str, engine: str, cost: float, mock: bool, view: str) -> None:
    """One row in the shared costs.csv (same columns as the pipeline), written atomically under costs.csv.lock."""
    with costs_locked(path):
        _append_cost(path, date, name, engine, cost, mock, view)


def _append_cost(path: Path, date: str, name: str, engine: str, cost: float, mock: bool, view: str) -> None:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if not text.strip():
        text = ",".join(COSTS_HEADER) + "\n"
    elif not text.endswith("\n"):
        text += "\n"
    row = io.StringIO()
    csv.writer(row, lineterminator="\n").writerow([date, name, engine, fmt_cost(cost), "true" if mock else "false", view])
    atomic_write_bytes(path, (text + row.getvalue()).encode("utf-8"))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class FalError(Exception):
    pass


def fal_call(endpoint: str, args: dict, key: str, timeout: float = FAL_TIMEOUT) -> dict:
    req = urllib.request.Request(
        f"https://fal.run/{endpoint}", data=json.dumps(args).encode("utf-8"), method="POST",
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode("utf-8", "replace")
        if e.code == 422 and "did not generate the expected output" in detail:
            # Seen live 2026-11-05: nano-banana/edit sometimes returns no image; the same request worked on a retry.
            raise FalError(f"{endpoint} returned no image this time. Try the render again.") from None
        raise FalError(f"fal {endpoint} returned HTTP {e.code}: {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FalError(f"could not reach fal ({endpoint}): {getattr(e, 'reason', e)}") from None
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise FalError(f"fal {endpoint} returned something that isn't JSON ({e})") from None


def download(url: str) -> bytes:
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "midstudy"}), timeout=120) as res:
        return res.read()


# --- small helpers ----------------------------------------------------------------------------------------
def iso_utc(t: float | None = None) -> str:
    dt = datetime.fromtimestamp(t, timezone.utc) if t is not None else datetime.now(timezone.utc)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def read_json_file(path: Path):
    """The parsed file, or None when it is missing or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None



# --- library API (contract §2.8) and money (§2.9) ------------------------------------------------------------
MAX_MODEL = 200 * 1024 * 1024
MAX_IMAGE = 20 * 1024 * 1024
MAX_DRAIN = 256 * 1024 * 1024  # an early error reads (and drops) a body up to this, so the client sees the answer
DRAIN_SECONDS = 60             # ...for at most this long
EARLY_DRAIN_SECONDS = 5        # after a 411/413 that was already sent
SOCKET_TIMEOUT = float(os.environ.get("MIDSTUDY_SOCKET_TIMEOUT") or 30)  # s one read or write may block (a client that
                                                                             # stops sending is dropped); the env var is for evals
ENGINE_PRICE = {"idol": lambda res: 0.10, "sam3d": lambda res: 0.02,
                "trellis2": lambda res: {512: 0.25, 1024: 0.30, 1536: 0.35}[res],
                "glb": lambda res: 0.0, "rug": lambda res: 0.0}
IMAGE_ENGINES = ("idol", "sam3d", "trellis2", "rug")  # idol is the default (contract §2.8, §3.2)
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
ZIP_ALLOWED = {".obj", ".mtl", ".png", ".jpg", ".jpeg"}
ZIP_MAX_ENTRIES = 1000
ZIP_MAX_UNPACKED = 500 * 1024 * 1024
# source.<ext> is never served: it is the upload as given, camera metadata (GPS) included (§2.8).
LIBRARY_ASSET = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}/(model\.glb|splat\.ply|splat\.spz|thumb\.jpg)\Z")
MIDSTUDY_ADD_TIMEOUT = 3600
LOCK_WAIT = 60  # s a library edit waits for a running midstudy-add before answering 503
FORGED = "cross-site request refused"
LOOPBACK = ("127.0.0.1", "localhost", "[::1]")
UNKNOWN_HOST = "unknown host name: add it with --allowed-host"
DEFAULT_MIDSTUDY_ADD = "uv run --project pipeline midstudy-add"


HOST_RE = re.compile(r"(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\Z")
CONTENT_LENGTH = re.compile(r"[0-9]{1,15}")  # ASCII digits (\d would take any Unicode digit)


def host_name(host: str) -> str:
    """A Host header's name without its port, lowercased (`[::1]:8765` -> `[::1]`), or "" when it isn't exactly
    `name[:port]` (so `127.0.0.1:80@evil.example` or `[::1]evil.example` never pass as loopback, §2.9)."""
    m = HOST_RE.match(host.strip().lower())
    return m.group(1) if m else ""


def clean_path(raw: str) -> str | None:
    """A request path without its query, percent-decoded, with `.`, `..` and repeated slashes resolved (§2.9 Paths),
    so every rule about what is served sees one spelling. Keeps a trailing slash. None for a path that can't name a
    file (a NUL or a backslash)."""
    p = unquote(raw.split("?", 1)[0].split("#", 1)[0])
    if "\x00" in p or "\\" in p:
        return None
    clean = posixpath.normpath("/" + p.lstrip("/"))  # a leading "/" means ".." can't climb above the root
    clean = "/" + clean.lstrip("/")  # normpath keeps a leading "//"
    if p.endswith("/") and clean != "/":
        clean += "/"
    return clean


def mock_cost() -> bool:
    """MIDSTUDY_FAL_MOCK_COST=1 (evals only): mock calls count at their real price, so the cap can be tested for $0."""
    return os.environ.get("MIDSTUDY_FAL_MOCK_COST", "") not in ("", "0")


def counts_against_cap() -> bool:
    """Live calls count; mock calls count for nothing unless MIDSTUDY_FAL_MOCK_COST=1."""
    return not fal_mock() or mock_cost()


def mb_text(n: int) -> str:
    """A size in MB (MiB, as the limits are), rounded up, so a body just over a limit never reads as the limit."""
    return f"{math.ceil(n / 2**20 * 10) / 10:.1f} MB"


def slugify(text: str) -> str:
    """Same as midstudy-add's default id (pipeline/src/midstudy_pipeline/cli.py)."""
    ascii_ = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_).strip("-")[:64].rstrip("-")


def num_text(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def check_dims(dims) -> dict:
    if not isinstance(dims, dict) or not all(
            isinstance(dims.get(k), (int, float)) and not isinstance(dims.get(k), bool) and dims[k] > 0 for k in "wdh"):
        raise ValueError('dims_cm is required: {"w": ..., "d": ..., "h": ...} in cm, all greater than 0')
    return {k: dims[k] for k in "wdh"}


def check_meta(meta, kind: str) -> dict:
    """The validated meta of an add (§2.8), with id and engine filled in. ValueError: one actionable sentence."""
    if not isinstance(meta, dict):
        raise ValueError("the meta must be a JSON object with at least name and dims_cm")
    name = meta.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name is required, e.g. \"Reading chair\"")
    out = {"name": name.strip(), "dims_cm": check_dims(meta.get("dims_cm"))}
    item_id = meta.get("id")
    if item_id is None or item_id == "":
        item_id = slugify(name)
        if not SLUG.match(item_id):
            raise ValueError(f"can't make an id from the name {name!r}: add an id like \"reading-chair\"")
    elif not isinstance(item_id, str) or not SLUG.match(item_id):
        raise ValueError(f"id must be a slug (lowercase letters, digits and dashes, up to 64), got {item_id!r}")
    out["id"] = item_id
    for key in ("category", "prompt"):
        v = meta.get(key)
        if v is not None and not isinstance(v, str):
            raise ValueError(f"{key} must be text")
        out[key] = v.strip() if isinstance(v, str) and v.strip() else None
    mount = meta.get("mount")
    if mount not in (None, "floor", "wall"):
        raise ValueError(f"mount must be floor or wall, got {mount!r}")
    out["mount"] = mount
    yaw = meta.get("yaw", 0)
    if yaw in (None, ""):
        yaw = 0
    if isinstance(yaw, bool) or yaw not in (0, 90, 180, 270):
        raise ValueError(f"yaw must be 0, 90, 180 or 270 (degrees), got {yaw!r}")
    out["yaw"] = int(yaw)
    if kind == "model":
        if meta.get("engine") not in (None, "", "glb"):
            raise ValueError(f"engine must be glb for a 3D model (or left out), got {meta.get('engine')!r}")
        out["engine"] = "glb"
    else:
        engine = meta.get("engine") or "idol"
        if engine not in IMAGE_ENGINES:
            raise ValueError(f"engine must be idol, sam3d, trellis2 or rug for an image, got {engine!r}")
        out["engine"] = engine
    res = meta.get("resolution")
    if res in (None, ""):
        res = 512
    if isinstance(res, bool) or res not in (512, 1024, 1536):
        raise ValueError(f"resolution must be 512, 1024 or 1536, got {res!r}")
    out["resolution"] = int(res)
    out["estimate"] = ENGINE_PRICE[out["engine"]](out["resolution"])
    return out


def zip_problem(path: Path) -> str | None:
    """The first broken §2.8 zip rule, or None. Same rules as the pipeline (pipeline/src/midstudy_pipeline/objzip.py)."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
    except (zipfile.BadZipFile, OSError) as e:
        return f"that isn't a readable zip ({e})"
    if len(infos) > ZIP_MAX_ENTRIES:
        return f"the zip has {len(infos)} entries, at most {ZIP_MAX_ENTRIES} are allowed"
    total, objs = 0, 0
    for info in infos:
        name = info.filename
        if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":") or "\\" in name:
            return f"the zip holds an absolute path ({name}): zip the folder's contents instead"
        if ".." in PurePosixPath(name).parts:
            return f"the zip holds a path that climbs out of it ({name}): re-zip the folder"
        if stat.S_ISLNK(info.external_attr >> 16):
            return f"the zip holds a link ({name}): zip the real files instead"
        if info.is_dir() or name.startswith("__MACOSX/") or PurePosixPath(name).name == ".DS_Store":
            continue
        ext = PurePosixPath(name).suffix.lower()
        if ext not in ZIP_ALLOWED:
            return f"the zip holds {name}: only .obj, .mtl, .png, .jpg and .jpeg files are allowed"
        objs += ext == ".obj"
        total += info.file_size
    if total > ZIP_MAX_UNPACKED:
        return f"the zip unpacks to {total / 1e6:.0f} MB, at most 500 MB is allowed"
    if objs != 1:
        return f"the zip must hold exactly one .obj with its .mtl and textures (found {objs})"
    return None


def image_kind(head: bytes) -> str | None:
    """jpeg, png, webp or heic from the first bytes, else None."""
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heis", b"heim"):
        return "heic"
    return None


# --- URL fetches (§2.9): the server downloads the image itself, to a pinned, checked address ------------------
FETCH_TIMEOUT = 20
FETCH_MAX = 20 * 1024 * 1024
FETCH_REDIRECTS = 3
PRIVATE = "that address is on a private network"
WEB_PAGE = "that's a web page: paste the image's own link (right-click the image, Copy Image Address)"
BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10",
    "224.0.0.0/4", "240.0.0.0/4", "::1/128", "::/128", "fd7a:115c:a1e0::/48", "fc00::/7", "fe80::/10", "ff00::/8",
    # NAT64's local-use prefix, IPv4-translated addresses and the old site-local range can all reach private hosts
    "64:ff9b:1::/48", "::ffff:0:0:0/96", "fec0::/10")]
NAT64 = ipaddress.ip_network("64:ff9b::/96")
IMAGE_SUFFIX = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                "image/heic": ".heic", "image/heif": ".heif"}


class FetchError(Exception):
    pass


def address_blocked(addr: str) -> bool:
    """True for loopback, private, link-local, CGNAT/tailnet, ULA, multicast and reserved addresses, in any v4-in-v6 form."""
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return True
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif int(ip) < 2 ** 32:  # ::a.b.c.d (IPv4-compatible), and :: / ::1
            ip = ipaddress.IPv4Address(int(ip))
        elif ip in NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
    return ip.is_multicast or any(ip in n for n in BLOCKED_NETS if n.version == ip.version)


def fetch_allowed(host: str, port: int) -> bool:
    """MIDSTUDY_FETCH_ALLOW=<host>:<port> (evals only) exempts exactly that host and port."""
    allow = os.environ.get("MIDSTUDY_FETCH_ALLOW", "")
    ahost, sep, aport = allow.rpartition(":")
    return bool(sep) and aport.isdigit() and int(aport) == port and ahost.strip("[]").lower() == host.lower()


class _Pinned:
    """Connects to the address checked at resolve time, never re-resolving the host. abort() cuts the connection
    from another thread (the 20 s watchdog), even after http.client has handed the socket to the response."""

    def _open(self):
        self.raw = socket.create_connection((self._ip, self.port), self.timeout)
        return self.raw.dup()

    def abort(self):
        raw = getattr(self, "raw", None)
        if raw is not None:
            try:
                raw.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        super().close()
        raw = getattr(self, "raw", None)
        if raw is not None:
            raw.close()


class _PinnedHTTP(_Pinned, http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = self._open()


class _PinnedHTTPS(_Pinned, http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        self.sock = self._context.wrap_socket(self._open(), server_hostname=self.host)


def fetch_image(url: str, dest_dir: Path) -> Path:
    """Download an image link to dest_dir (§2.9). Raises FetchError with one sentence for the user."""
    deadline = time.monotonic() + FETCH_TIMEOUT
    left = lambda: max(0.1, deadline - time.monotonic())
    for _hop in range(FETCH_REDIRECTS + 1):
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https"):
            raise FetchError("only http and https links work: paste the image's web address")
        host = parts.hostname
        if not host:
            raise FetchError("that link has no host name")
        try:
            port = parts.port or (443 if scheme == "https" else 80)
        except ValueError:
            raise FetchError("that link's port isn't a number") from None
        try:
            addrs = [ai[4][0] for ai in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
        except (socket.gaierror, UnicodeError, OSError):
            raise FetchError(f"couldn't find {host}: check the link") from None
        if not addrs or (not fetch_allowed(host, port) and any(address_blocked(a) for a in addrs)):
            raise FetchError(PRIVATE)
        conn_cls = _PinnedHTTPS if scheme == "https" else _PinnedHTTP
        conn = conn_cls(host, port, addrs[0], left())
        watchdog = threading.Timer(left(), conn.abort)
        watchdog.daemon = True
        watchdog.start()
        try:
            target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            conn.request("GET", target, headers={"User-Agent": "midstudy (image fetch)", "Accept": "image/*"})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location")
                if not location:
                    raise FetchError(f"the link redirects (HTTP {resp.status}) without saying where")
                url = urljoin(url, location)
                continue
            if resp.status != 200:
                raise FetchError(f"the link answered HTTP {resp.status}: check it opens the image in a browser")
            ctype = (resp.getheader("Content-Type") or "").split(";")[0].strip().lower()
            if ctype in ("text/html", "application/xhtml+xml"):
                raise FetchError(WEB_PAGE)
            if not ctype.startswith("image/"):
                raise FetchError(f"that link isn't an image (it's {ctype or 'untyped'}): paste the image's own link")
            length = resp.getheader("Content-Length")
            if length and length.isdigit() and int(length) > FETCH_MAX:
                raise FetchError("that image is over 20 MB: use a smaller one")
            dest = dest_dir / f"download{IMAGE_SUFFIX.get(ctype, '.img')}"
            got = 0
            with open(dest, "wb") as f:
                while True:
                    if time.monotonic() > deadline:
                        raise FetchError("the image took more than 20 s to download: try another link")
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    got += len(chunk)
                    if got > FETCH_MAX:
                        raise FetchError("that image is over 20 MB: use a smaller one")
                    f.write(chunk)
            if not got:
                raise FetchError("the link returned an empty file")
            return dest
        except (OSError, http.client.HTTPException) as e:  # timeouts, the watchdog's abort, TLS, refused...
            if isinstance(e, TimeoutError) or time.monotonic() > deadline:
                raise FetchError("the image took more than 20 s to download: try another link") from None
            if isinstance(e, ssl.SSLError):
                raise FetchError(f"couldn't connect securely to {host} ({e.reason or e})") from None
            raise FetchError(f"couldn't download from {host} ({type(e).__name__}): check the link") from None
        finally:
            watchdog.cancel()
            conn.close()
    raise FetchError(f"the link redirects more than {FETCH_REDIRECTS} times: paste the image's own link")


def load_product_page():
    """planner/product_page.py (§2.11), loaded by path: the Nix wrapper runs python3 -I, which keeps this folder off
    sys.path. It gets this file's address rules, pinned connections and fal helpers, so each exists once. No
    __pycache__ is written next to it."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("midstudy_product_page", Path(__file__).resolve().parent / "product_page.py")
    module = importlib.util.module_from_spec(spec)
    was = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = was
    module.configure(address_blocked=address_blocked, fetch_allowed=fetch_allowed, private=PRIVATE,
                     pinned_http=_PinnedHTTP, pinned_https=_PinnedHTTPS, fal_call=fal_call, fal_error=FalError,
                     fal_key=fal_key, fal_mock=fal_mock, mock_cost=mock_cost, counts_against_cap=counts_against_cap,
                     append_cost=append_cost, slugify=slugify)
    return module


product_page = load_product_page()


class Busy(Exception):
    pass


class LibraryService:
    """The library's one queue of midstudy-add jobs, its writes under <library>/.lock, and the daily spend cap."""

    def __init__(self, lib_dir: Path, costs_file: Path, midstudy_add: list[str], cap_usd: float):
        self.dir = lib_dir
        self.costs_file = costs_file
        self.midstudy_add = midstudy_add
        self.cap = cap_usd
        self.mutex = threading.Lock()        # jobs and reservations (in-process state)
        self.write_lock = threading.Lock()   # this process's library writes, with the flock below for other processes
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.private: dict[str, dict] = {}   # job id -> {cmd, cleanup}
        self.reserved: dict[str, float] = {}
        self.queue: queue.Queue = queue.Queue()
        threading.Thread(target=self.worker, name="midstudy-library-jobs", daemon=True).start()

    # --- lock and files -------------------------------------------------------------------------------------
    @contextlib.contextmanager
    def locked(self, wait: float | None = LOCK_WAIT):
        """<library>/.lock (flock), the same lock midstudy-add holds for a whole run. Raises Busy after `wait` s
        (None: wait as long as it takes, for writes that must not be lost, like a billed call's cost row)."""
        deadline = time.monotonic() + (wait if wait is not None else 1e12)
        if not self.write_lock.acquire(timeout=wait if wait is not None else -1):
            raise Busy()
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            with open(self.dir / ".lock", "a+") as f:
                while True:
                    try:
                        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() > deadline:
                            raise Busy() from None
                        time.sleep(0.2)
                try:
                    yield
                finally:
                    fcntl.flock(f, fcntl.LOCK_UN)
        finally:
            self.write_lock.release()

    def read(self) -> dict:
        data = read_json_file(self.dir / "library.json")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return {"version": 1, "items": []}
        return data

    def write(self, data: dict) -> None:
        """library.json, atomically, in midstudy-add's format. Call under locked()."""
        text = json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        atomic_write_bytes(self.dir / "library.json", text.encode("utf-8"))

    def item(self, item_id: str, data: dict | None = None) -> dict | None:
        data = self.read() if data is None else data
        return next((i for i in data["items"] if isinstance(i, dict) and i.get("id") == item_id), None)

    def trash(self) -> list[dict]:
        """[{id, name, deleted, dir}] of every trashed copy, newest first."""
        out = []
        root = self.dir / ".trash"
        if root.is_dir():
            for d in root.iterdir():
                meta = read_json_file(d / "entry.json") if d.is_dir() else None
                if isinstance(meta, dict) and isinstance(meta.get("entry"), dict):
                    out.append({"id": meta["entry"].get("id"), "name": meta["entry"].get("name"),
                                "deleted": meta.get("deleted"), "dir": d})
        out.sort(key=lambda t: (str(t["deleted"]), t["dir"].name), reverse=True)
        return out

    # --- spend cap ------------------------------------------------------------------------------------------
    def spent(self, day: str) -> float:
        """Today's (UTC) total in costs.csv."""
        total = 0.0
        try:
            with open(self.costs_file, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if (row.get("date") or "").startswith(day):
                        try:
                            total += float(row.get("cost_usd") or 0)
                        except ValueError:
                            pass
        except OSError:
            pass
        return round(total, 6)

    def _expire_held(self, day: str) -> None:
        """Drop reservations held for an earlier day (a timed-out paid job's, see hold_for_today). Call under mutex."""
        for key in [k for k in self.reserved if k.startswith("held:") and k.split(":")[1] != day]:
            del self.reserved[key]

    def spend(self) -> dict:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            self._expire_held(day)
            reserved = round(sum(self.reserved.values()), 6)
        return {"day": day, "spent_usd": self.spent(day), "reserved_usd": reserved, "cap_usd": self.cap}

    def reserve(self, key: str, amount: float) -> dict | None:
        """Reserve `amount` against today's cap. None when it fits, else the 402 body. Atomic for this server."""
        if amount <= 0:
            return None
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            self._expire_held(day)
            spent = self.spent(day)
            used = spent + sum(self.reserved.values())
            if used + amount > self.cap + 1e-9:
                held = used - spent
                if amount > self.cap + 1e-9:
                    error = f"this call costs ${fmt_cost(amount)}, more than the daily fal budget (${self.cap:.2f}) allows"
                else:
                    error = (f"today's fal budget (${self.cap:.2f}) is used up: ${spent:.2f} spent"
                             + (f" and ${held:.2f} reserved by calls still running" if held > 1e-9 else "")
                             + f", and this call costs ${fmt_cost(amount)}")
                return {"error": error, "spent_usd": spent, "cap_usd": self.cap}
            self.reserved[key] = amount
        return None

    def release(self, key: str) -> None:
        with self.mutex:
            self.reserved.pop(key, None)

    def hold_for_today(self, key: str) -> float:
        """Keep `key`'s reservation until the end of the UTC day instead of releasing it (a paid job killed at its
        timeout may still have been charged, §2.9). Returns the amount held."""
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.mutex:
            amount = self.reserved.pop(key, 0.0)
            if amount > 0:
                self.reserved[f"held:{day}:{key}"] = amount
        return amount

    # --- jobs -----------------------------------------------------------------------------------------------
    def new_job(self, kind: str, item_id: str, engine: str, estimate: float, cmd: list[str], cleanup: Path | None,
                reserve: float = 0.0, message: str = "waiting for the queue"):
        """Queue a midstudy-add run. Returns (job, None), or (None, 402 body) when the cap refuses it."""
        now = datetime.now(timezone.utc)
        job_id = f"l-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        refused = self.reserve(job_id, reserve)
        if refused:
            return None, refused
        job = {"id": job_id, "kind": kind, "item_id": item_id, "status": "queued", "engine": engine,
               "cost_usd_estimate": estimate, "cost_usd": None, "mock": fal_mock(), "created": iso_utc(),
               "started": None, "finished": None, "message": message, "item": None}
        with self.mutex:
            self.jobs[job_id] = job
            self.order.append(job_id)
            self.private[job_id] = {"cmd": cmd, "cleanup": cleanup}
            snapshot = dict(job)
        self.queue.put(job_id)
        return snapshot, None

    def list_jobs(self) -> list[dict]:
        with self.mutex:
            return [dict(self.jobs[j]) for j in reversed(self.order)]

    def get_job(self, job_id: str) -> dict | None:
        with self.mutex:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id: str, **fields) -> None:
        with self.mutex:
            self.jobs[job_id].update(fields)

    def worker(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self.run(job_id)
            except Exception as e:  # noqa: BLE001 - one bad job never stops the queue
                self.update(job_id, status="failed", finished=iso_utc(), message=f"the server failed to run midstudy-add ({type(e).__name__}: {e})")
            finally:
                self.release(job_id)
                with self.mutex:
                    extra = self.private.pop(job_id, {})
                if extra.get("cleanup"):
                    shutil.rmtree(extra["cleanup"], ignore_errors=True)

    def run(self, job_id: str) -> None:
        with self.mutex:
            cmd = self.private[job_id]["cmd"]
            job = self.jobs[job_id]
            kind, item_id = job["kind"], job["item_id"]
        self.update(job_id, status="running", started=iso_utc(),
                    message=f"refitting {item_id}" if kind == "rescale" else f"making {item_id} ({job['engine']})")
        try:
            proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=MIDSTUDY_ADD_TIMEOUT,
                                  stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            return self.update(job_id, status="failed", finished=iso_utc(),
                               message=f"midstudy-add isn't installed here ({cmd[0]} not found): set --midstudy-add")
        except subprocess.TimeoutExpired:
            message = f"midstudy-add ran for more than {MIDSTUDY_ADD_TIMEOUT // 60} minutes and was stopped"
            held = self.hold_for_today(job_id)
            if held > 0:
                message += (f"; fal may have charged for it, so its ${fmt_cost(held)} estimate stays reserved "
                            "against today's (UTC) budget")
            return self.update(job_id, status="failed", finished=iso_utc(), message=message)
        out_lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        if proc.returncode != 0:
            err = [ln.strip() for ln in proc.stderr.splitlines() if ln.strip()]
            mine = [ln for ln in err if ln.startswith("midstudy-add:")]
            message = (mine or err or [f"midstudy-add exited with code {proc.returncode}"])[-1]
            return self.update(job_id, status="failed", finished=iso_utc(), message=message)
        try:
            summary = json.loads(out_lines[-1])
        except (IndexError, json.JSONDecodeError):
            return self.update(job_id, status="failed", finished=iso_utc(),
                               message="midstudy-add finished without its JSON summary line")
        replaced = next((ln for ln in out_lines if "replaced existing item" in ln), None)
        if kind == "rescale":
            message = f"refit {item_id} ($0)"
        elif replaced:
            message = replaced.removeprefix("midstudy-add: ")
        else:
            message = f"added {item_id}"
        self.update(job_id, status="done", finished=iso_utc(), message=message, item=self.item(item_id),
                    cost_usd=summary.get("cost_usd", 0), mock=bool(summary.get("mock", fal_mock())))


MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".spz": "application/octet-stream",
    ".ply": "application/octet-stream",
    ".splat": "application/octet-stream",
    ".ksplat": "application/octet-stream",
    ".sog": "application/octet-stream",
}


def atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise



# --- scenes (contract §4.2, §4.4) -----------------------------------------------------------------------------
MAX_SCENE_UPLOAD = 25 * 1024 * 1024
CALIB_TIMEOUT = 600   # s, one calibration job (§4.4)
ALIGN_TIMEOUT = 180   # s, one keep-room align (§4.7)
DEFAULT_CALIB = "uv run --project calib midstudy-calib"
DEFAULT_CAMERA = {"fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -10.0, "roll_deg": 0.0}
CAMERA_RANGE = {"fov_y_deg": (20.0, 110.0), "height_m": (0.2, 3.0), "pitch_deg": (-80.0, 30.0), "roll_deg": (-20.0, 20.0)}
# scene.json `look` (contract §4.8): numbers (clamped) and booleans; null removes a key
LOOK_RANGE = {"exposure": (0.25, 4.0), "warmth": (-1.0, 1.0), "light_azimuth_deg": (-180.0, 180.0),
              "light_elevation_deg": (5.0, 90.0), "light_softness": (0.0, 1.0), "light_strength": (0.0, 3.0),
              "ambient": (0.0, 3.0)}
LOOK_BOOL = ("contact_shadows", "auto_light", "cast_shadows")
LOOK_HELP = ("look takes exposure (0.25 to 4), warmth (-1 to 1), light_azimuth_deg (-180 to 180), light_elevation_deg "
             "(5 to 90), light_softness (0 to 1), light_strength (0 to 3) and ambient (0 to 3) as numbers, contact_shadows, "
             "auto_light and cast_shadows as true or false, and null for any of them to remove it")
SCENE_ASSET = re.compile(r"^([a-z0-9][a-z0-9-]{0,63})/(photo\.jpg|depth\.png|thumb\.jpg)\Z")
UPLOAD_EXT = {"jpeg": "jpg", "png": "png", "heic": "heic", "webp": "webp"}
LAYOUT_KEYS = ("version", "name", "title", "scene_name", "library", "updated", "items", "notes")
MAX_LAYOUT_TITLE = 120
LAYOUT_ITEM_KEYS = ("uid", "id", "render", "position", "rotation_y_deg", "mounted", "dims_cm")
NOT_IMAGE = "that file isn't a JPEG, PNG, HEIC or WebP image"
TRASH_META = "trash.json"  # {name, title, deleted} in a trashed scene's folder
TRASHED_SCENE = re.compile(r"^([a-z0-9][a-z0-9-]*?\d{8}-\d{6}(?:-\d+)?)-\d{8}-\d{6}(?:-\d+)?\Z")


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def clamp_camera(cam: dict) -> dict:
    """The camera block with every value clamped to its range (contract §4.1), as floats."""
    out = {}
    for k, (lo, hi) in CAMERA_RANGE.items():
        v = cam.get(k, DEFAULT_CAMERA[k]) if isinstance(cam, dict) else DEFAULT_CAMERA[k]
        out[k] = round(min(hi, max(lo, float(v))), 6) if is_num(v) else DEFAULT_CAMERA[k]
    return out


def png_size(data: bytes):
    """(width, height) from a PNG's IHDR, or None."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def file_jpeg_size(path: Path):
    """(w, h) of a JPEG on disk from its first 512 KB (photo.jpg carries no metadata, so the frame header is early)."""
    try:
        with open(path, "rb") as f:
            return jpeg_size(f.read(512 * 1024))
    except OSError:
        return None


def decode_data_uri(value, kinds: tuple[str, ...]) -> bytes | None:
    """The bytes of a base64 data URI whose type is one of `kinds` (e.g. ("jpeg",) or ("png",)), else None."""
    if not isinstance(value, str):
        return None
    pattern = "|".join(re.escape(k) for k in kinds).replace("jpeg", "jpe?g")
    m = re.fullmatch(rf"data:image/(?:{pattern});base64,([A-Za-z0-9+/=\s]+)", value)
    if not m:
        return None
    try:
        return base64.b64decode(re.sub(r"\s", "", m.group(1)), validate=True)
    except (binascii.Error, ValueError):
        return None


def plain_jfif(seg: bytes) -> bytes:
    """An APP0 segment (its length bytes and payload) as a plain 16-byte JFIF header with no thumbnail, or b"" (drop
    it): a JFIF thumbnail, or a JFXX extension (whose payload can be a whole JPEG with its own EXIF and GPS), is an
    embedded image that carries what the main one was cleaned of."""
    if len(seg) >= 16 and seg[2:7] == b"JFIF\x00":
        return b"\xff\xe0\x00\x10" + seg[2:14] + b"\x00\x00"
    return b""


def clean_jpeg(data: bytes) -> bytes | None:
    """The JPEG without its metadata: APP1–APP15 (EXIF, GPS, XMP, ICC, …) and COM segments dropped wherever they are
    (before the first scan or between progressive scans), APP0 kept only as a plain JFIF header (plain_jfif), and
    nothing after EOI. The image data is copied as it is
    (no re-encode). None when it isn't a well-formed JPEG. Used on JPEGs a client sends (the render composite, the
    thumbnail), which the server stores, serves and sends to fal: none of that may carry camera metadata."""
    n = len(data)
    if n < 4 or data[:2] != b"\xff\xd8":
        return None
    out = bytearray(b"\xff\xd8")
    i = 2
    while i < n:
        if data[i] != 0xFF:
            return None
        while i < n and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= n:
            return None
        m = data[i]
        i += 1
        if m == 0xD9:  # EOI: whatever follows (a second image, a trailer) is dropped
            out += b"\xff\xd9"
            return bytes(out)
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            out += bytes((0xFF, m))
            continue
        if m == 0x00 or i + 2 > n:
            return None
        length = (data[i] << 8) | data[i + 1]
        if length < 2 or i + length > n:
            return None
        if m == 0xE0:
            out += plain_jfif(data[i:i + length])  # JFIF without its thumbnail; JFXX and other APP0s are dropped
        elif not (0xE1 <= m <= 0xEF or m == 0xFE):
            out += bytes((0xFF, m)) + data[i:i + length]
        i += length
        if m == 0xDA:  # SOS: the entropy-coded data runs to the next marker (FF 00 is a stuffed byte, FF D0–D7 a restart)
            j = i
            while True:
                j = data.find(b"\xff", j)
                if j < 0 or j + 1 >= n:
                    return None
                nx = data[j + 1]
                if nx == 0x00 or 0xD0 <= nx <= 0xD7:
                    j += 2
                    continue
                break
            out += data[i:j]
            i = j
    return None


def public_calib(calib: dict | None) -> dict | None:
    """calib.json as the API serves it: without the camera's make and model (contract §4.4). They stay in calib.json
    on disk, beside the focal length and the EXIF FOV, which are all the planner needs; what the server serves carries
    no camera metadata."""
    if not isinstance(calib, dict) or not isinstance(calib.get("exif"), dict):
        return calib
    exif = {k: v for k, v in calib["exif"].items() if k not in ("make", "model")}
    return {**calib, "exif": exif}


def last_json_line(text: str):
    """The last non-empty stdout line parsed as JSON, or None (contract §4.3: the tools' output contract)."""
    for line in reversed([ln.strip() for ln in (text or "").splitlines() if ln.strip()]):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return None
    return None


def tool_error(proc, out, tool: str) -> str:
    """The one-sentence error of a failed midstudy-calib run: its JSON `error`, else its last `midstudy-calib: …`
    stderr line, else the exit code."""
    if isinstance(out, dict) and isinstance(out.get("error"), str) and out["error"].strip():
        return out["error"].strip()
    err = [ln.strip() for ln in (proc.stderr or "").splitlines() if ln.strip()]
    mine = [ln.removeprefix("midstudy-calib:").strip() for ln in err if ln.startswith("midstudy-calib:")]
    return (mine or err or [f"{tool} exited with code {proc.returncode}"])[-1]


def name_order(name: str) -> tuple[str, int]:
    """("scene-20261104-201500", 3) for "scene-20261104-201500-3": a sort key that orders collision suffixes as numbers."""
    m = re.fullmatch(r"(.*?\d{8}-\d{6})(?:-(\d+))?", name)
    return (m.group(1), int(m.group(2) or 1)) if m else (name, 0)


class SceneService:
    """Scenes on disk (contract §4.2) and their calibration jobs: one queue, one job at a time, in memory, separate
    from the library's queue. Scene folder writes (scene.json, create, delete) happen under one lock. The queue also
    runs light jobs (§4.8 backfill: lighting.json alone), which never touch scene.json, the camera or calib_status."""

    def __init__(self, scenes_dir: Path, layouts_dir: Path, calib: list[str]):
        self.dir = scenes_dir
        self.layouts_dir = layouts_dir
        self.calib = calib
        self.lock = threading.RLock()
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.private: dict[str, dict] = {}   # job id -> {cmd, cleanup}
        self.last: dict[str, str] = {}       # scene -> its newest calibration job id
        self.light_last: dict[str, str] = {}  # scene -> its newest light job id (§4.8 backfill; never in self.last)
        self.queue: queue.Queue = queue.Queue()
        threading.Thread(target=self.worker, name="midstudy-calib-jobs", daemon=True).start()

    # --- files ------------------------------------------------------------------------------------------------
    def path(self, name: str) -> Path:
        return self.dir / name

    def exists(self, name: str) -> bool:
        return isinstance(name, str) and bool(SLUG.match(name)) and (self.dir / name / "scene.json").is_file()

    def read(self, name: str) -> dict | None:
        data = read_json_file(self.dir / name / "scene.json") if SLUG.match(name or "") else None
        return data if isinstance(data, dict) else None

    def write(self, name: str, data: dict) -> None:
        atomic_write_json(self.dir / name / "scene.json", data)

    def names(self) -> list[str]:
        if not self.dir.is_dir():
            return []
        return [p.name for p in self.dir.iterdir() if SLUG.match(p.name) and (p / "scene.json").is_file()]

    def calib_json(self, name: str) -> dict | None:
        data = read_json_file(self.dir / name / "calib.json")
        return data if isinstance(data, dict) else None

    def layout_count(self, name: str) -> int:
        d = self.layouts_dir / name
        return sum(1 for p in d.glob("*.json") if SLUG.match(p.stem) and p.is_file()) if d.is_dir() else 0

    # --- the scene object (§4.4) -----------------------------------------------------------------------------
    def status(self, name: str, has_calib: bool) -> tuple[str, str | None]:
        with self.lock:
            job = self.jobs.get(self.last.get(name, ""))
            job = dict(job) if job else None
        if job and job["status"] in ("queued", "running"):
            return ("pending" if job["status"] == "queued" else "running"), None
        if job and job["status"] == "failed":
            return "failed", job.get("message")
        if has_calib:
            return "done", None
        return "failed", "the calibration didn't finish (the server restarted): calibrate it again"

    def scene_object(self, name: str, data: dict | None = None) -> dict | None:
        data = self.read(name) if data is None else data
        if data is None:
            return None
        d = self.dir / name
        url = lambda f: f"/scenes/{name}/{f}?v={int((d / f).stat().st_mtime)}" if (d / f).is_file() else None
        size = file_jpeg_size(d / "photo.jpg") if (d / "photo.jpg").is_file() else None
        calib = self.calib_json(name)
        floor = calib.get("floor") if isinstance(calib, dict) else None
        found = floor.get("found") if isinstance(floor, dict) else None
        status, error = self.status(name, calib is not None)
        title = data.get("title")
        return {
            "name": name, "title": title if isinstance(title, str) and title.strip() else None,
            "created": data.get("created"), "saved": data.get("saved"),
            "photo_url": url("photo.jpg"), "thumb_url": url("thumb.jpg"), "depth_url": url("depth.png"),
            "w": size[0] if size else None, "h": size[1] if size else None,
            "camera_source": data.get("camera_source") or "default",
            "floor_found": found if isinstance(found, bool) else None,
            "layouts": self.layout_count(name), "calib_status": status, "calib_error": error,
        }

    def lighting_json(self, name: str) -> dict | None:
        data = read_json_file(self.dir / name / "lighting.json")
        return data if isinstance(data, dict) else None

    def lighting_status(self, name: str, has_lighting: bool) -> tuple[str, str | None]:
        """(lighting_status, lighting_error) for GET /api/scenes/<name> (contract §4.8): done with a lighting.json;
        else what the scene's newest light job says (pending, running, failed with its message, none: it found no
        light), unless a calibration came after it: pending or running while that is queued or running (it writes
        lighting.json itself); else missing (nothing has tried in this server run)."""
        if has_lighting:
            return "done", None
        with self.lock:
            lj, cj = self.jobs.get(self.light_last.get(name, "")), self.jobs.get(self.last.get(name, ""))
            if lj is not None and lj.get("dropped"):
                lj = None
            if lj is not None and cj is not None and self.order.index(cj["id"]) > self.order.index(lj["id"]):
                lj = None  # a calibration after the light job: it decides
            lj, cj = (dict(lj) if lj else None), (dict(cj) if cj else None)
        if lj is not None:
            if lj["status"] in ("queued", "running"):
                return ("pending" if lj["status"] == "queued" else "running"), None
            if lj["status"] == "failed":
                return "failed", lj.get("message") or "inferring the light failed"
            return ("none" if lj.get("lighting") is False else "missing"), None
        if cj is not None and cj["status"] in ("queued", "running"):
            return ("pending" if cj["status"] == "queued" else "running"), None
        return "missing", None

    def full(self, name: str) -> dict | None:
        """GET /api/scenes/<name>: scene.json, the scene object's fields, `calib` (calib.json or null), `lighting`
        (lighting.json as it is, or null), `lighting_status` and `lighting_error` (contract §4.8)."""
        data = self.read(name)
        if data is None:
            return None
        lighting = self.lighting_json(name)
        status, error = self.lighting_status(name, lighting is not None)
        return {**data, **self.scene_object(name, data), "camera": clamp_camera(data.get("camera") or {}),
                "calib": public_calib(self.calib_json(name)), "lighting": lighting, "lighting_status": status,
                "lighting_error": error}

    def all(self) -> list[dict]:
        """Newest first by `created`; ties (uploads in the same second) by the name's collision suffix as a number, so
        scene-…-10 comes before scene-…-9."""
        out = [s for s in (self.scene_object(n) for n in self.names()) if s]
        out.sort(key=lambda s: (str(s.get("created") or ""), *name_order(s["name"])), reverse=True)
        return out

    # --- create, update, delete -------------------------------------------------------------------------------
    def create(self, upload: Path, tmp: Path, filename: str, ext: str, size: int, title: str | None):
        """Make scenes/<name>/scene.json and queue `<calib> run <upload> --out scenes/<name>`. The job owns tmp."""
        now = datetime.now(timezone.utc)
        base = f"scene-{now:%Y%m%d-%H%M%S}"
        with self.lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            name, n = base, 1
            while (self.dir / name).exists():
                n += 1
                name = f"{base}-{n}"
            (self.dir / name).mkdir()
            self.write(name, {"version": 1, "title": title, "created": iso_utc(), "saved": None,
                              "camera": dict(DEFAULT_CAMERA), "camera_source": "default",
                              "upload": {"filename": filename, "ext": ext, "bytes": size}})
            job = self.queue_job(name, [*self.calib, "run", str(upload), "--out", str((self.dir / name).resolve())], tmp)
        return name, job

    def queue_job(self, name: str, cmd: list[str], cleanup: Path | None, kind: str = "calibrate") -> dict:
        """Queue a calibration (kind calibrate) or a light job (kind light, §4.8: `<calib> light <scene-dir>`, which
        writes lighting.json only). Both share the one queue; each kind has its own "newest job" per scene."""
        now = datetime.now(timezone.utc)
        job_id = f"{'l' if kind == 'light' else 'c'}-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        job = {"id": job_id, "kind": kind, "scene": name, "status": "queued", "created": iso_utc(),
               "started": None, "finished": None, "message": "waiting for the calibration queue", "calib": None}
        if kind == "light":
            job["lighting"] = None  # true: lighting.json written; false: no clear light in the photo
        with self.lock:
            self.jobs[job_id] = job
            self.order.append(job_id)
            self.private[job_id] = {"cmd": cmd, "cleanup": cleanup}
            (self.light_last if kind == "light" else self.last)[name] = job_id
            snapshot = dict(job)
        self.queue.put(job_id)
        return snapshot

    def busy(self, name: str) -> bool:
        with self.lock:
            job = self.jobs.get(self.last.get(name, ""))
            return bool(job) and job["status"] in ("queued", "running")

    def calibrate(self, name: str):
        """POST …/calibrate: `fit` on photo.jpg, or `run` on a copy of source.<ext> when photo.jpg is missing.
        Returns (job, None) or (None, (status, message))."""
        with self.lock:
            if not self.exists(name):
                return None, (HTTPStatus.NOT_FOUND, f"no scene named {name!r}: GET /api/scenes lists them")
            if self.busy(name):
                return None, (HTTPStatus.CONFLICT, "this scene is already calibrating: wait for it to finish")
            d = self.dir / name
            if (d / "photo.jpg").is_file():
                return self.queue_job(name, [*self.calib, "fit", str(d.resolve())], None), None
            sources = sorted(d.glob("source.*"))
            if not sources:
                return None, (HTTPStatus.CONFLICT, "this scene has no photo to calibrate: make a new scene from the photo")
            tmp = Path(tempfile.mkdtemp(prefix="midstudy-scene-"))
            copy = tmp / f"upload{sources[0].suffix.lower()}"
            shutil.copyfile(sources[0], copy)
            return self.queue_job(name, [*self.calib, "run", str(copy), "--out", str(d.resolve())], tmp), None

    def light(self, name: str) -> tuple[int, dict]:
        """POST …/light (§4.8 backfill): queue `<calib> light <scene-dir>` for a scene without lighting.json.
        (202, {job}) queued, or the light job already queued or running for it (two devices may open the scene at
        once); (200, {lighting_status: done}) when lighting.json is there; 409 while the scene calibrates or without
        photo.jpg; 404 unknown."""
        with self.lock:
            if not self.exists(name):
                return HTTPStatus.NOT_FOUND, {"error": f"no scene named {name!r}: GET /api/scenes lists them"}
            if self.busy(name):
                return HTTPStatus.CONFLICT, {"error": "this scene is calibrating; its lighting comes with it"}
            d = self.dir / name
            if not (d / "photo.jpg").is_file():
                return HTTPStatus.CONFLICT, {"error": "this scene has no photo to infer the light from: calibrate it first"}
            if self.lighting_json(name) is not None:
                return HTTPStatus.OK, {"lighting_status": "done"}
            job = self.jobs.get(self.light_last.get(name, ""))
            if job and job["status"] in ("queued", "running") and not job.get("dropped"):
                return HTTPStatus.ACCEPTED, {"job": {k: v for k, v in job.items() if k != "dropped"}}
            return HTTPStatus.ACCEPTED, {"job": self.queue_job(name, [*self.calib, "light", str(d.resolve())], None, kind="light")}

    def update(self, name: str, patch: dict) -> dict:
        """PUT /api/scenes/<name> (validated by the handler): merge, clamp, stamp `saved` unless only the title came."""
        with self.lock:
            data = self.read(name)
            if data is None:
                raise KeyError(name)
            if "title" in patch:
                data["title"] = patch["title"]
            if "camera" in patch:
                data["camera"] = clamp_camera({**clamp_camera(data.get("camera") or {}), **patch["camera"]})
            if "camera_source" in patch:
                data["camera_source"] = patch["camera_source"]
            if "look" in patch:
                # only the keys it carries; null removes one (§4.8)
                look = dict(data.get("look") or {}) if isinstance(data.get("look"), dict) else {}
                for k, v in patch["look"].items():
                    if v is None:
                        look.pop(k, None)
                    elif k in LOOK_RANGE:
                        lo, hi = LOOK_RANGE[k]
                        look[k] = round(min(hi, max(lo, float(v))), 6)
                    else:
                        look[k] = bool(v)
                data["look"] = look
            if set(patch) - {"title"}:
                data["saved"] = iso_utc()
            data.setdefault("version", 1)
            self.write(name, data)
        return data

    def delete(self, name: str) -> str:
        """Move scenes/<name>/ (and layouts/<name>/ inside it as layouts/) to scenes/.trash/<name>-<stamp>/. A queued
        job for it is dropped, a running one's result is ignored."""
        with self.lock:
            if not self.exists(name):
                raise KeyError(name)
            for job_id in self.order:
                job = self.jobs[job_id]
                if job["scene"] == name and job["status"] in ("queued", "running"):
                    job["dropped"] = True
                    if job["status"] == "queued":
                        job.update(status="failed", finished=iso_utc(), message="the scene was deleted")
            base = f"{name}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
            trash, n = self.dir / ".trash" / base, 1
            while trash.exists():
                n += 1
                trash = self.dir / ".trash" / f"{base}-{n}"
            trash.parent.mkdir(parents=True, exist_ok=True)
            title = (self.read(name) or {}).get("title")
            shutil.move(str(self.dir / name), str(trash))
            layouts = self.layouts_dir / name
            if layouts.is_dir():
                shutil.move(str(layouts), str(trash / "layouts"))
            atomic_write_json(trash / TRASH_META, {"name": name, "title": title if isinstance(title, str) else None,
                                                   "deleted": iso_utc()})
        return f"{self.dir.name}/.trash/{trash.name}"

    def trash(self) -> list[dict]:
        """[{name, title, deleted, dir}] for every deleted scene in scenes/.trash/, newest first."""
        root = self.dir / ".trash"
        out = []
        if root.is_dir():
            for d in root.iterdir():
                if not d.is_dir() or not (d / "scene.json").is_file():
                    continue
                meta = read_json_file(d / TRASH_META)
                if isinstance(meta, dict) and isinstance(meta.get("name"), str) and SLUG.match(meta["name"]):
                    name, deleted, title = meta["name"], meta.get("deleted"), meta.get("title")
                else:  # trashed before trash.json existed: <name>-<UTC stamp>[-n]
                    m = TRASHED_SCENE.match(d.name)
                    if not m:
                        continue
                    name, deleted = m.group(1), iso_utc(d.stat().st_mtime)
                    title = (read_json_file(d / "scene.json") or {}).get("title")
                created = (read_json_file(d / "scene.json") or {}).get("created")
                out.append({"name": name, "title": title if isinstance(title, str) else None,
                            "created": created if isinstance(created, str) else None, "deleted": str(deleted or ""), "dir": d})
        out.sort(key=lambda t: (t["deleted"], t["dir"].name), reverse=True)
        return out

    def restore(self, name: str) -> dict:
        """POST …/restore: the newest trashed copy of `name` back to scenes/<name>/, its layouts back to
        layouts/<name>/. KeyError: none in the trash; FileExistsError: a scene by that name exists again."""
        with self.lock:
            copies = [t for t in self.trash() if t["name"] == name]
            if not copies:
                raise KeyError(name)
            if (self.dir / name).exists() or (self.layouts_dir / name).exists():
                raise FileExistsError(name)
            src = copies[0]["dir"]
            dest = self.dir / name
            shutil.move(str(src), str(dest))
            (dest / TRASH_META).unlink(missing_ok=True)
            if (dest / "layouts").is_dir():
                self.layouts_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dest / "layouts"), str(self.layouts_dir / name))
        return self.scene_object(name)

    # --- jobs -------------------------------------------------------------------------------------------------
    def list_jobs(self) -> list[dict]:
        with self.lock:
            return [{k: v for k, v in self.jobs[j].items() if k != "dropped"} for j in reversed(self.order)]

    def get_job(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return {k: v for k, v in job.items() if k != "dropped"} if job else None

    def worker(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self.run(job_id)
            except Exception as e:  # noqa: BLE001 - one bad job never stops the queue
                with self.lock:
                    self.jobs[job_id].update(status="failed", finished=iso_utc(),
                                             message=f"the server failed to run the calibration ({type(e).__name__}: {e})")
            finally:
                with self.lock:
                    extra = self.private.pop(job_id, {})
                if extra.get("cleanup"):
                    shutil.rmtree(extra["cleanup"], ignore_errors=True)

    def run(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs[job_id]
            if job["status"] != "queued":  # dropped while it waited (the scene was deleted)
                return
            cmd = self.private[job_id]["cmd"]
            name = job["scene"]
            light = job["kind"] == "light"
            job.update(status="running", started=iso_utc(), message="inferring the light" if light else "calibrating the photo")
        try:
            proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=CALIB_TIMEOUT,
                                  stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            return self.finish(job_id, False, f"the calibration tool isn't installed here ({cmd[0]} not found): set --calib")
        except subprocess.TimeoutExpired:
            what = "inferring the light" if light else "the calibration"
            return self.finish(job_id, False, f"{what} ran for more than {CALIB_TIMEOUT // 60} minutes and was stopped")
        out = last_json_line(proc.stdout)
        if proc.returncode != 0 or not isinstance(out, dict) or out.get("ok") is not True:
            if proc.returncode == 0 and not isinstance(out, dict):
                return self.finish(job_id, False, "midstudy-calib finished without its JSON result line")
            return self.finish(job_id, False, tool_error(proc, out, "midstudy-calib"))
        if light:
            return self.light_done(job_id, out)
        with self.lock:
            dropped = job.get("dropped")
            if dropped:
                # The tool may have re-created the folder after the delete moved it: remove what it left.
                left = self.dir / name
                if left.is_dir() and not (left / "scene.json").exists():
                    shutil.rmtree(left, ignore_errors=True)
                job.update(status="failed", finished=iso_utc(), message="the scene was deleted")
                return
            calib = self.calib_json(name) or {k: v for k, v in out.items() if k != "ok"}
            data = self.read(name)
            if data is not None and data.get("camera_source") in ("auto", "default", None):
                data["camera"] = clamp_camera(calib.get("camera") or {})
                data["camera_source"] = "auto"
                self.write(name, data)
            src = calib.get("source")
            floor = calib.get("floor") if isinstance(calib.get("floor"), dict) else {}
            note = "" if src in ("moge-2", "truth") and floor.get("found") else " · check the floor"
            job.update(status="done", finished=iso_utc(), calib=public_calib(calib), message=f"calibrated ({src or 'unknown'}){note}")

    def light_done(self, job_id: str, out: dict) -> None:
        """A light job that ran: never touches scene.json, the camera or calib_status (§4.8)."""
        with self.lock:
            job = self.jobs[job_id]
            if job.get("dropped"):
                left = self.dir / job["scene"]
                if left.is_dir() and not (left / "scene.json").exists():
                    shutil.rmtree(left, ignore_errors=True)
                job.update(status="failed", finished=iso_utc(), message="the scene was deleted")
                return
            found = out.get("lighting") is True
            cct = out.get("cct_k")
            message = (f"lighting inferred ({round(cct)} K)" if is_num(cct) else "lighting inferred") if found else "no clear light in the photo"
            job.update(status="done", finished=iso_utc(), lighting=found, message=message)

    def finish(self, job_id: str, ok: bool, message: str) -> None:
        with self.lock:
            job = self.jobs[job_id]
            if job.get("dropped"):
                left = self.dir / job["scene"]
                if left.is_dir() and not (left / "scene.json").exists():
                    shutil.rmtree(left, ignore_errors=True)
                message = "the scene was deleted"
            job.update(status="done" if ok else "failed", finished=iso_utc(), message=message)



class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME, "": "application/octet-stream"}
    timeout = SOCKET_TIMEOUT  # StreamRequestHandler sets it on the socket: no handler thread waits forever on a body

    def __init__(self, *args, layouts_dir: Path, renders_dir: Path, costs_file: Path, scenes: "SceneService",
                 library_dir: Path | None = None, library: "LibraryService | None" = None,
                 allowed_hosts: tuple[str, ...] = (), **kwargs):
        self.hosts = {*LOOPBACK, *(host_name(h) for h in allowed_hosts)} - {""}  # §2.9 Host names (never "")
        self.layouts_dir = layouts_dir
        self.renders_dir = renders_dir
        self.costs_file = costs_file
        self.scenes = scenes
        self.library_dir = library_dir or (REPO / "library")
        if library is None:  # main() always passes one; this is for embedding the handler elsewhere
            library = LibraryService(self.library_dir, costs_file, shlex.split(DEFAULT_MIDSTUDY_ADD), 2.0)
        self.library = library
        self.body_done = False
        super().__init__(*args, directory=str(REPO), **kwargs)

    def translate_path(self, path):
        # Every rule below sees the normalized path (§2.9 Paths), so /./library/costs.csv is the same 404 as
        # /library/costs.csv. Nothing hidden (.env holds FAL_KEY, .git, .lock, .trash) is served under any spelling.
        p = clean_path(path)
        if p is None or any(x.startswith(".") for x in p.split("/")):
            return str(REPO / ".missing")
        if p.startswith("/renders/"):
            name = p[len("/renders/"):]
            if not name or "/" in name or "\\" in name or name.startswith("."):
                return str(self.renders_dir / ".missing")
            return str(self.renders_dir / name)
        if p == "/scenes" or p.startswith("/scenes/"):
            # photo.jpg, depth.png and thumb.jpg only: never source.*, calib.json, lighting.json, scene.json, .trash or a
            # listing (§4.4).
            m = SCENE_ASSET.match(p[len("/scenes/"):])
            return str(self.scenes.dir / m.group(1) / m.group(2)) if m else str(self.scenes.dir / ".missing")
        if p.startswith("/library/"):
            # Item assets and library.json only: never raw/, .trash/, .lock, costs.csv or a listing (§2.8).
            rel = p[len("/library/"):]
            if rel != "library.json" and not LIBRARY_ASSET.match(rel):
                return str(self.library_dir / ".missing")
            return str(self.library_dir.joinpath(*[x for x in rel.split("/") if x]))
        # Everything else is an allowlist: the planner's own files and nothing more. The repo also holds the user's
        # photos (fixtures/photos/, camera originals dropped at the root, with or without an extension), scratch scenes
        # under evals/out/ and the tracked library/costs.csv, and APFS is case-insensitive, so "/Fixtures/photos/…" or
        # "/Library/costs.csv" would reach them through any rule that matched spellings (§2.9 Paths, §4.4 Static).
        parts = [x for x in p.split("/") if x]
        if parts and parts[0] == "planner":
            return str(REPO.joinpath(*parts))
        return str(REPO / ".missing")

    def list_directory(self, path):
        """No directory listings anywhere (they'd show library/_inbox, raw/ and the like): a folder is a 404."""
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    # --- plumbing --------------------------------------------------------
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def parse_request(self):
        self.body_done = False  # one handler serves every request on a keep-alive connection
        if not super().parse_request():
            return False
        if host_name(self.headers.get("Host") or "") not in self.hosts:
            self.error_json(HTTPStatus.FORBIDDEN, UNKNOWN_HOST)  # §2.9 Host names (DNS rebinding), before anything else
            return False
        if len(self.headers.get_all("Content-Length") or []) > 1:
            # Two lengths (even equal ones) frame the body ambiguously: refuse instead of picking one (§2.9).
            self.body_done = True
            self.close_connection = True
            self.error_json(HTTPStatus.BAD_REQUEST, "the request has more than one Content-Length header")
            return False
        length = self.headers.get("Content-Length")
        if length is not None and not CONTENT_LENGTH.fullmatch(length.strip()):
            # ASCII digits only: str.isdigit() takes "²" and int() then fails (a 500); a sign or a space frames nothing.
            self.body_done = True
            self.close_connection = True
            self.error_json(HTTPStatus.BAD_REQUEST, "the Content-Length header isn't a number of bytes")
            return False
        return True

    def chunked(self) -> bool:
        return "chunked" in (self.headers.get("Transfer-Encoding") or "").lower()

    def discard_body(self, seconds: float = DRAIN_SECONDS) -> None:
        """Read and drop an unread request body (up to MAX_DRAIN, for at most `seconds`), so an early error reaches
        the client instead of a reset. A body that doesn't arrive in time closes the connection."""
        if self.body_done or self.command in ("GET", "HEAD"):
            return
        self.body_done = True
        deadline = time.monotonic() + seconds
        try:
            if self.chunked():
                total = 0
                while True:
                    size = int(self.rfile.readline(1024).split(b";")[0].strip() or b"0", 16)
                    if size == 0:
                        while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                            pass
                        return
                    total += size
                    if total > MAX_DRAIN or time.monotonic() > deadline:
                        break
                    self.rfile.read(size + 2)
                self.close_connection = True
                return
            left = int(self.headers.get("Content-Length") or 0)
            if left > MAX_DRAIN:
                self.close_connection = True
                return
            while left > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.close_connection = True
                    return
                # A read blocks for at most what is left of the drain (not the connection's 30 s), so a client that
                # sends nothing after an early 411/413 is dropped after EARLY_DRAIN_SECONDS.
                self.connection.settimeout(max(0.05, min(remaining, SOCKET_TIMEOUT)))
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                left -= len(chunk)
        except (ValueError, OSError):  # TimeoutError is an OSError
            self.close_connection = True
        finally:
            try:
                self.connection.settimeout(SOCKET_TIMEOUT)
            except OSError:
                pass

    def forged(self) -> bool:
        """§2.9: a mutation needs X-Midstudy: 1 and an Origin that's absent or this page's own. Answers 403 itself."""
        origin = self.headers.get("Origin")
        host = self.headers.get("Host") or ""
        own = (f"http://{host}", f"https://{host}")
        if self.headers.get("X-Midstudy") == "1" and (origin is None or (host and origin in own)):
            return False
        self.error_json(HTTPStatus.FORBIDDEN, FORGED)
        return True

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status: int, data) -> None:
        # 411 and 413 answer at once, before the (missing or too large) body: the client sees the answer even if it
        # never sends that body. The connection closes after it, once a short drain has given the client time to read it.
        early = status in (HTTPStatus.LENGTH_REQUIRED, HTTPStatus.REQUEST_ENTITY_TOO_LARGE) and not self.body_done
        if early:
            self.close_connection = True
        else:
            self.discard_body()
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if early:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        if early:
            try:
                self.wfile.flush()
            except OSError:
                return
            self.discard_body(seconds=EARLY_DRAIN_SECONDS)

    def error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def body_stalled(self, e: BaseException) -> None:
        """A request body stopped arriving (the socket timed out) or the client went away while sending it: one
        sentence (408) if the client can still read it, and the connection closes. Never a 500 with the exception."""
        self.body_done = True
        self.close_connection = True
        if isinstance(e, TimeoutError):
            try:
                self.error_json(HTTPStatus.REQUEST_TIMEOUT, f"the request body stopped arriving (nothing for {SOCKET_TIMEOUT:g} s): send it again")
            except OSError:
                pass

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ValueError("empty request body")
        if length > MAX_BODY:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        self.body_done = True
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"body is not valid JSON: {e}") from None
        except RecursionError:
            raise ValueError("body is not valid JSON: it is nested too deeply") from None

    def api_path(self):
        path = unquote(urlsplit(self.path).path)
        return path if path == "/api" or path.startswith("/api/") else None

    def query(self, key: str) -> str | None:
        """The ?<key>= of this request, or None when there is none."""
        values = parse_qs(urlsplit(self.path).query).get(key)
        return values[0] if values else None

    # --- static ----------------------------------------------------------
    def hidden(self) -> bool:
        """Never serve dotfiles/dirs (.env holds FAL_KEY, .git, .venv), however the path is spelled."""
        p = clean_path(self.path)
        return p is None or any(x.startswith(".") for x in p.split("/"))

    def do_GET(self):
        api = self.api_path()
        if api is not None:
            return self.handle_api_get(api)
        if urlsplit(self.path).path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/planner/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.hidden():
            return self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        if clean_path(self.path) == "/library/library.json" and not (self.library_dir / "library.json").is_file():
            # A library dir nothing has been added to yet (a fresh --library-dir): an empty library (§2.2), not a 404
            # that the browser logs as a console error on every page load.
            return self.send_json(HTTPStatus.OK, {"version": 1, "items": []})
        return super().do_HEAD() if self.command == "HEAD" else super().do_GET()

    do_HEAD = do_GET  # same routing; send_json and super().do_HEAD() skip the body

    def do_PUT(self):
        if self.forged():
            return
        api = self.api_path()
        if api is None:
            return self.error_json(HTTPStatus.METHOD_NOT_ALLOWED, "PUT is only supported under /api")
        try:
            m = re.fullmatch(r"/api/scenes/([^/]*)/thumb", api)
            if m:
                return self.put_scene_thumb(m.group(1))
            m = re.fullmatch(r"/api/scenes/([^/]*)", api)
            if m and m.group(1) != "jobs":
                return self.put_scene(m.group(1))
            m = re.fullmatch(r"/api/layouts/([^/]*)", api)
            if m:
                return self.put_layout(m.group(1))
            m = re.fullmatch(r"/api/library/items/([^/]*)/thumb", api)
            if m:
                return self.put_library_thumb(m.group(1))
            return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: PUT {api}")
        except Busy:
            return self.library_busy()
        except (TimeoutError, ConnectionError) as e:
            return self.body_stalled(e)
        except Exception as e:  # keep the server alive and answer in JSON
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")

    def do_POST(self):
        if self.forged():
            return
        api = self.api_path()
        try:
            if api == "/api/render":
                return self.post_render()
            if api == "/api/scenes":
                return self.post_scene()
            m = re.fullmatch(r"/api/scenes/([^/]*)/calibrate", api or "")
            if m:
                return self.calibrate_scene(m.group(1))
            m = re.fullmatch(r"/api/scenes/([^/]*)/light", api or "")
            if m:
                return self.light_scene(m.group(1))
            m = re.fullmatch(r"/api/scenes/([^/]*)/restore", api or "")
            if m:
                return self.restore_scene(m.group(1))
            if api == "/api/library/items":
                return self.post_library_upload()
            if api == "/api/library/items/from-url":
                return self.post_library_from_url()
            if api == "/api/library/product":
                return self.post_library_product()
            m = re.fullmatch(r"/api/library/items/([^/]*)/restore", api or "")
            if m:
                return self.restore_library_item(m.group(1))
        except Busy:
            return self.library_busy()
        except (TimeoutError, ConnectionError) as e:
            return self.body_stalled(e)
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: POST {api or urlsplit(self.path).path}")

    def do_PATCH(self):
        if self.forged():
            return
        api = self.api_path()
        try:
            m = re.fullmatch(r"/api/library/items/([^/]*)", api or "")
            if m:
                return self.patch_library_item(m.group(1))
        except Busy:
            return self.library_busy()
        except (TimeoutError, ConnectionError) as e:
            return self.body_stalled(e)
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: PATCH {api or urlsplit(self.path).path}")

    def do_DELETE(self):
        if self.forged():
            return
        api = self.api_path()
        try:
            m = re.fullmatch(r"/api/library/items/([^/]*)", api or "")
            if m:
                return self.delete_library_item(m.group(1))
            m = re.fullmatch(r"/api/scenes/([^/]*)", api or "")
            if m and m.group(1) != "jobs":
                return self.delete_scene(m.group(1))
            m = re.fullmatch(r"/api/layouts/([^/]*)", api or "")
            if m:
                return self.delete_layout(m.group(1))
        except Busy:
            return self.library_busy()
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: DELETE {api or urlsplit(self.path).path}")

    # --- api -------------------------------------------------------------
    def handle_api_get(self, api: str):
        try:
            if api == "/api/scenes":
                trash = [{k: t[k] for k in ("name", "title", "created", "deleted")} for t in self.scenes.trash()]
                return self.send_json(HTTPStatus.OK, {"scenes": self.scenes.all(), "trash": trash})
            if api == "/api/scenes/jobs":
                return self.send_json(HTTPStatus.OK, {"jobs": self.scenes.list_jobs()})
            m = re.fullmatch(r"/api/scenes/jobs/([^/]*)", api)
            if m:
                job = self.scenes.get_job(m.group(1))
                return self.send_json(HTTPStatus.OK, job) if job else self.error_json(
                    HTTPStatus.NOT_FOUND, f"no calibration job {m.group(1)!r}: GET /api/scenes/jobs lists them")
            m = re.fullmatch(r"/api/scenes/([^/]*)", api)
            if m:
                return self.get_scene(m.group(1))
            if api == "/api/layouts":
                return self.list_layouts()
            m = re.fullmatch(r"/api/layouts/([^/]*)", api)
            if m:
                return self.get_layout(m.group(1))
            if api == "/api/renders":
                return self.list_renders()
            if api == "/api/library":
                return self.get_library()
            if api == "/api/library/jobs":
                return self.send_json(HTTPStatus.OK, {"jobs": self.library.list_jobs()})
            m = re.fullmatch(r"/api/library/jobs/([^/]*)", api)
            if m:
                job = self.library.get_job(m.group(1))
                return self.send_json(HTTPStatus.OK, job) if job else self.error_json(
                    HTTPStatus.NOT_FOUND, f"no library job {m.group(1)!r}: GET /api/library/jobs lists them")
            if api == "/api/spend":
                return self.send_json(HTTPStatus.OK, self.library.spend())
            return self.error_json(HTTPStatus.NOT_FOUND, f"no such endpoint: GET {api}")
        except Exception as e:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{type(e).__name__}: {e}")

    # --- scenes (contract §4.4) ---------------------------------------------
    def no_scene(self, name: str):
        if not SLUG.match(name or ""):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no scene named {name!r} (scene names are slugs: a-z, 0-9, -)")
        return self.error_json(HTTPStatus.NOT_FOUND, f"no scene named {name!r}: GET /api/scenes lists them")

    def get_scene(self, name: str):
        data = self.scenes.full(name) if SLUG.match(name) else None
        return self.send_json(HTTPStatus.OK, data) if data else self.no_scene(name)

    def post_scene(self):
        length = self.headers.get("Content-Length")
        if self.chunked() or length is None or not CONTENT_LENGTH.fullmatch(length.strip()):
            self.close_connection = True
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: send the photo as the request body")
        length = int(length)
        if length > MAX_SCENE_UPLOAD:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                                   f"that photo is {mb_text(length)}: a scene photo can be at most 25 MB")
        filename = PurePosixPath((self.headers.get("X-Midstudy-Filename") or "").replace("\\", "/")).name.strip()
        if not filename:
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Midstudy-Filename is required (the photo's name, e.g. IMG_0042.HEIC)")
        title = None
        raw_meta = self.headers.get("X-Midstudy-Meta")
        if raw_meta:
            try:
                meta = json.loads(base64.b64decode(raw_meta, validate=True).decode("utf-8"))
            except (binascii.Error, ValueError, UnicodeDecodeError):
                meta = None
            if not isinstance(meta, dict) or not (meta.get("title") is None or isinstance(meta.get("title"), str)):
                return self.error_json(HTTPStatus.BAD_REQUEST, 'X-Midstudy-Meta must be base64 of a JSON object like {"title": "Lounge"}')
            t = (meta.get("title") or "").strip()
            if len(t) > 200:
                return self.error_json(HTTPStatus.BAD_REQUEST, "the title can be at most 200 characters")
            title = t or None
        if length == 0:
            return self.error_json(HTTPStatus.BAD_REQUEST, NOT_IMAGE)
        tmp = Path(tempfile.mkdtemp(prefix="midstudy-scene-"))  # private, never under a served path
        try:
            part = tmp / "upload.part"
            with open(part, "wb") as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            self.body_done = True
            if left > 0:
                raise ValueError("the upload stopped before the end: try again")
            with open(part, "rb") as f:
                kind = image_kind(f.read(16))
            if kind is None:
                raise ValueError(NOT_IMAGE)
            ext = UPLOAD_EXT[kind]
            upload = tmp / f"upload.{ext}"
            part.rename(upload)
        except ValueError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        name, job = self.scenes.create(upload, tmp, filename[:200], ext, length, title)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job, "scene": name})

    def put_scene(self, name: str):
        if not self.scenes.exists(name):
            return self.no_scene(name)
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(body, dict) or not body:
            return self.error_json(HTTPStatus.BAD_REQUEST, "the body must be a JSON object with any of title, camera, camera_source, look")
        unknown = sorted(set(body) - {"title", "camera", "camera_source", "look"})
        if unknown:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"{', '.join(unknown)} can't be set: use title, camera, camera_source or look")
        patch = {}
        if "title" in body:
            t = body["title"]
            if t is not None and not isinstance(t, str):
                return self.error_json(HTTPStatus.BAD_REQUEST, "title must be text or null")
            t = (t or "").strip()
            if len(t) > 200:
                return self.error_json(HTTPStatus.BAD_REQUEST, "the title can be at most 200 characters")
            patch["title"] = t or None
        if "camera" in body:
            cam = body["camera"]
            if not isinstance(cam, dict) or not cam:
                return self.error_json(HTTPStatus.BAD_REQUEST, 'camera must be an object like {"fov_y_deg": 55, "height_m": 1.4, "pitch_deg": -10, "roll_deg": 0}')
            bad = sorted(set(cam) - set(CAMERA_RANGE))
            if bad:
                return self.error_json(HTTPStatus.BAD_REQUEST, f"camera has unknown fields ({', '.join(bad)}): use fov_y_deg, height_m, pitch_deg, roll_deg")
            notnum = sorted(k for k, v in cam.items() if not is_num(v))
            if notnum:
                return self.error_json(HTTPStatus.BAD_REQUEST, f"camera {', '.join(notnum)} must be a number")
            patch["camera"] = cam
        if "camera_source" in body:
            if body["camera_source"] not in ("auto", "manual", "default"):
                return self.error_json(HTTPStatus.BAD_REQUEST, "camera_source must be auto, manual or default")
            patch["camera_source"] = body["camera_source"]
        if "look" in body:
            look = body["look"]
            if not isinstance(look, dict):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"look must be an object: {LOOK_HELP}")
            bad = sorted(set(look) - set(LOOK_RANGE) - set(LOOK_BOOL))
            if bad:
                return self.error_json(HTTPStatus.BAD_REQUEST, f"look has unknown keys ({', '.join(bad)}): {LOOK_HELP}")
            # bool is an int in Python: a boolean never passes as a number, nor 0/1 as a boolean
            wrong = sorted(k for k, v in look.items() if v is not None and not (is_num(v) if k in LOOK_RANGE else isinstance(v, bool)))
            if wrong:
                return self.error_json(HTTPStatus.BAD_REQUEST, f"look {', '.join(wrong)} has the wrong type: {LOOK_HELP}")
            patch["look"] = look
        try:
            self.scenes.update(name, patch)
        except KeyError:
            return self.no_scene(name)
        return self.send_json(HTTPStatus.OK, self.scenes.full(name))

    def put_scene_thumb(self, name: str):
        if not self.scenes.exists(name):
            return self.no_scene(name)
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        data = decode_data_uri(body.get("image") if isinstance(body, dict) else None, ("jpeg",))
        if data and len(data) > MAX_THUMB:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "thumbnail is over 2 MB: send a smaller JPEG")
        data = clean_jpeg(data) if data and data[:3] == b"\xff\xd8\xff" else None  # served: no metadata
        if not data:
            return self.error_json(HTTPStatus.BAD_REQUEST, "image must be a JPEG data URI (data:image/jpeg;base64,...)")
        with self.scenes.lock:
            if not self.scenes.exists(name):
                return self.no_scene(name)
            atomic_write_bytes(self.scenes.path(name) / "thumb.jpg", data)
        return self.send_json(HTTPStatus.OK, {"ok": True, "thumb_url": self.scenes.scene_object(name)["thumb_url"]})

    def calibrate_scene(self, name: str):
        if not SLUG.match(name):
            return self.no_scene(name)
        job, refused = self.scenes.calibrate(name)
        if refused:
            return self.error_json(*refused)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job})

    def light_scene(self, name: str):
        if not SLUG.match(name):
            return self.no_scene(name)
        status, body = self.scenes.light(name)
        return self.send_json(status, body)

    def delete_scene(self, name: str):
        if not self.scenes.exists(name):
            return self.no_scene(name)
        try:
            trash = self.scenes.delete(name)
        except KeyError:
            return self.no_scene(name)
        return self.send_json(HTTPStatus.OK, {"ok": True, "trash": trash})

    def restore_scene(self, name: str):
        if not SLUG.match(name):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no deleted scene named {name!r}")
        try:
            scene = self.scenes.restore(name)
        except KeyError:
            return self.error_json(HTTPStatus.NOT_FOUND, f"{name!r} isn't in the scenes' trash")
        except FileExistsError:
            return self.error_json(HTTPStatus.CONFLICT, f"a scene {name!r} (or its layouts) exists again: delete it first")
        return self.send_json(HTTPStatus.OK, scene)

    # --- layouts, per scene (contract §2.7) ---------------------------------------------------------------------
    def layout_scene(self):
        """The ?scene= of a layouts request when it names a scene, else None (the error already sent)."""
        name = self.query("scene")
        if name is None or name == "":
            self.error_json(HTTPStatus.BAD_REQUEST, "add ?scene=<name>: layouts belong to a scene")
            return None
        if not SLUG.match(name):
            self.error_json(HTTPStatus.BAD_REQUEST, f"scene must be a slug (a-z, 0-9, -): {name!r}")
            return None
        if not self.scenes.exists(name):
            self.no_scene(name)
            return None
        return name

    def bad_layout_name(self, name: str) -> bool:
        if SLUG.match(name or ""):
            return False
        self.error_json(HTTPStatus.BAD_REQUEST, f"layout name must be a slug like \"reading-corner\" (a-z, 0-9, -): {name!r}")
        return True

    def list_layouts(self):
        scene = self.layout_scene()
        if scene is None:
            return
        details = []
        d = self.layouts_dir / scene
        if d.is_dir():
            for p in sorted(d.glob("*.json")):
                if not SLUG.match(p.stem) or not p.is_file():
                    continue
                data = read_json_file(p)
                items = data.get("items") if isinstance(data, dict) else None
                updated = data.get("updated") if isinstance(data, dict) else None
                title = data.get("title") if isinstance(data, dict) else None
                details.append({"name": p.stem, "title": title if isinstance(title, str) and title.strip() else None,
                                "items": len(items) if isinstance(items, list) else 0,
                                "updated": updated if isinstance(updated, str) else iso_utc(p.stat().st_mtime)})
        return self.send_json(HTTPStatus.OK, {"layouts": [x["name"] for x in details], "details": details})

    def get_layout(self, name: str):
        scene = self.layout_scene()
        if scene is None or self.bad_layout_name(name):
            return
        path = self.layouts_dir / scene / f"{name}.json"
        if not path.is_file():
            return self.error_json(HTTPStatus.NOT_FOUND, f"scene {scene!r} has no layout named {name!r}")
        data = read_json_file(path)
        if data is None:
            return self.error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"layout {name!r} of scene {scene!r} is unreadable: fix or delete it")
        return self.send_json(HTTPStatus.OK, data)

    def put_layout(self, name: str):
        scene = self.layout_scene()
        if scene is None or self.bad_layout_name(name):
            return
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(body, dict) or not isinstance(body.get("items"), list):
            return self.error_json(HTTPStatus.BAD_REQUEST, 'a layout must be a JSON object with an "items" array')
        items = []
        for i, it in enumerate(body["items"]):
            if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not SLUG.match(it["id"]):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"item {i} needs an id (a library item's slug)")
            pos = it.get("position")
            if not (isinstance(pos, list) and len(pos) == 3 and all(is_num(v) for v in pos)):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"item {i} ({it['id']}) needs a position [x, elevation, z] in meters")
            rot = it.get("rotation_y_deg", 0)
            if not is_num(rot):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"item {i} ({it['id']}): rotation_y_deg must be a number")
            uid = it.get("uid") if isinstance(it.get("uid"), str) and it.get("uid") else f"{it['id']}-{i + 1}"
            out = {"uid": uid, "id": it["id"], "render": it.get("render") if it.get("render") in ("glb", "splat") else "glb",
                   "position": [float(v) for v in pos], "rotation_y_deg": float(rot)}
            if it.get("mounted") in ("floor", "wall"):
                out["mounted"] = it["mounted"]
            dims = it.get("dims_cm")
            if isinstance(dims, dict) and all(is_num(dims.get(k)) for k in "wdh"):
                out["dims_cm"] = {k: dims[k] for k in "wdh"}
            items.append(out)
        lib = body.get("library")
        notes = body.get("notes")
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            return self.error_json(HTTPStatus.BAD_REQUEST, "title must be text (the layout's name as typed) or null")
        title = " ".join((title or "").split())
        if len(title) > MAX_LAYOUT_TITLE:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"the title can be at most {MAX_LAYOUT_TITLE} characters")
        doc = {"version": 1, "name": name, "title": title or None, "scene_name": scene,
               "library": lib if isinstance(lib, str) else None, "updated": iso_utc(), "items": items}
        if isinstance(notes, str):
            doc["notes"] = notes
        atomic_write_json(self.layouts_dir / scene / f"{name}.json", doc)
        return self.send_json(HTTPStatus.OK, doc)

    def delete_layout(self, name: str):
        scene = self.layout_scene()
        if scene is None or self.bad_layout_name(name):
            return
        path = self.layouts_dir / scene / f"{name}.json"
        if not path.is_file():
            return self.error_json(HTTPStatus.NOT_FOUND, f"scene {scene!r} has no layout named {name!r}")
        # Not gone for good: layouts/<scene>/.trash/<layout>-<UTC stamp>.json (never listed or served). The planner's
        # Undo puts the layout back with a PUT of the copy it read first.
        trash_dir = self.layouts_dir / scene / ".trash"
        trash_dir.mkdir(parents=True, exist_ok=True)
        base = f"{name}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
        trash, n = trash_dir / f"{base}.json", 1
        while trash.exists():
            n += 1
            trash = trash_dir / f"{base}-{n}.json"
        os.replace(path, trash)
        return self.send_json(HTTPStatus.OK, {"ok": True, "name": name, "scene": scene,
                                              "trash": f"{self.layouts_dir.name}/{scene}/.trash/{trash.name}"})

    # --- library (contract §2.8) ------------------------------------------------------------------
    def library_busy(self):
        return self.error_json(HTTPStatus.SERVICE_UNAVAILABLE,
                               "the library is busy with another change (a midstudy-add run): try again in a minute")

    def get_library(self):
        data = self.library.read()
        trash = [{k: t[k] for k in ("id", "name", "deleted")} for t in self.library.trash()]
        return self.send_json(HTTPStatus.OK, dict(data, trash=trash))

    def add_command(self, src: Path, meta: dict, label: str) -> list[str]:
        # Every value as --opt=<v> and the input as an absolute path, so a name like "-Shelf" is never read as a flag.
        cmd = [*self.library.midstudy_add, str(src.resolve()), f"--name={meta['name']}", f"--id={meta['id']}",
               "--dims=" + "x".join(num_text(meta["dims_cm"][k]) for k in "wdh"), f"--engine={meta['engine']}",
               f"--library={self.library_dir.resolve()}", f"--source-input={label}"]
        if meta["category"]:
            cmd += [f"--category={meta['category']}"]
        if meta["mount"]:
            cmd += [f"--mount={meta['mount']}"]
        if meta["yaw"]:
            cmd += [f"--yaw={meta['yaw']}"]
        if meta["engine"] == "sam3d" and meta["prompt"]:
            cmd += [f"--prompt={meta['prompt']}"]
        if meta["engine"] == "trellis2":
            cmd += [f"--resolution={meta['resolution']}"]
        return cmd

    def queue_add(self, src: Path, tmp: Path, meta: dict, label: str, reserved_key: str | None = None):
        """202 {job, cost_usd_estimate}, or 402 when the cap refuses it. The job owns (and removes) tmp."""
        exists = self.library.item(meta["id"]) is not None
        message = f"waiting for the queue; replaces the existing {meta['id']}" if exists else "waiting for the queue"
        reserve = meta["estimate"] if counts_against_cap() else 0.0
        if reserved_key:  # already reserved before the download: hand it over to the job
            self.library.release(reserved_key)
        job, refused = self.library.new_job("add", meta["id"], meta["engine"], meta["estimate"],
                                            self.add_command(src, meta, label), tmp, reserve, message)
        if refused:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job, "cost_usd_estimate": meta["estimate"]})

    def post_library_upload(self):
        kind = (self.headers.get("X-Midstudy-Kind") or "").strip().lower()
        if kind not in ("model", "image"):
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Midstudy-Kind must be model or image")
        filename = PurePosixPath((self.headers.get("X-Midstudy-Filename") or "").replace("\\", "/")).name
        if not filename:
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Midstudy-Filename is required (the file's name, e.g. chair.glb)")
        try:
            meta = json.loads(base64.b64decode(self.headers.get("X-Midstudy-Meta") or "", validate=True).decode("utf-8"))
        except (binascii.Error, ValueError, UnicodeDecodeError):
            meta = None
        if not isinstance(meta, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "X-Midstudy-Meta must be base64 of a JSON object with name and dims_cm")
        ext = PurePosixPath(filename).suffix.lower()
        if kind == "model":
            if ext in (".usdz", ".usd", ".usda", ".usdc", ".reality"):
                return self.error_json(HTTPStatus.BAD_REQUEST, f"{ext} isn't supported: convert to GLB first (e.g. Reality Converter or Blender)")
            if ext == ".gltf":
                return self.error_json(HTTPStatus.BAD_REQUEST, "a .gltf needs its side files: convert it to .glb first, or zip an .obj with its .mtl and textures")
            if ext not in (".glb", ".zip"):
                return self.error_json(HTTPStatus.BAD_REQUEST, "a model must be a .glb, or a .zip holding one .obj with its .mtl and textures")
        elif ext not in IMAGE_EXTS:
            return self.error_json(HTTPStatus.BAD_REQUEST, "a photo must be a JPEG, PNG, HEIC or WebP file")
        try:
            meta = check_meta(meta, kind)
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        length = self.headers.get("Content-Length")
        if self.chunked() or length is None or not CONTENT_LENGTH.fullmatch(length.strip()):
            self.close_connection = True
            return self.error_json(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required: send the file as the request body")
        length = int(length)
        limit = MAX_MODEL if kind == "model" else MAX_IMAGE
        if length > limit:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                                   f"that file is {mb_text(length)}: {'models' if kind == 'model' else 'photos'} can be at most {limit // (1024 * 1024)} MB")
        if length == 0:
            return self.error_json(HTTPStatus.BAD_REQUEST, "the file is empty")
        tmp = Path(tempfile.mkdtemp(prefix="midstudy-upload-"))  # private, never under a served path
        try:
            src = tmp / f"upload{ext}"
            with open(src, "wb") as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            self.body_done = True
            if left > 0:
                raise ValueError("the upload stopped before the end: try again")
            with open(src, "rb") as f:
                head = f.read(16)
            if kind == "image" and image_kind(head) is None:
                raise ValueError("that file isn't a JPEG, PNG, HEIC or WebP image")
            if ext == ".glb" and head[:4] != b"glTF":
                raise ValueError("that file isn't a GLB (binary glTF): export it again as .glb")
            if ext == ".zip":
                problem = zip_problem(src)
                if problem:
                    raise ValueError(problem)
        except ValueError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return self.queue_add(src, tmp, meta, filename)

    def post_library_from_url(self):
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        url = body.get("image_url") if isinstance(body, dict) else None
        if not isinstance(url, str) or not url.strip():
            return self.error_json(HTTPStatus.BAD_REQUEST, 'the body must be JSON like {"image_url": "https://...", "name": ..., "dims_cm": {...}}')
        url = url.strip()
        try:
            meta = check_meta({k: v for k, v in body.items() if k != "image_url"}, "image")
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        key = f"fetch-{secrets.token_hex(4)}"  # hold the estimate while downloading, so the cap is checked first
        refused = self.library.reserve(key, meta["estimate"] if counts_against_cap() else 0.0)
        if refused:
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        tmp = Path(tempfile.mkdtemp(prefix="midstudy-fetch-"))
        try:
            src = fetch_image(url, tmp)
            with open(src, "rb") as f:
                if image_kind(f.read(16)) is None:
                    raise FetchError("that link isn't a JPEG, PNG, HEIC or WebP image")
        except FetchError as e:
            self.library.release(key)
            shutil.rmtree(tmp, ignore_errors=True)
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        except BaseException:
            self.library.release(key)
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return self.queue_add(src, tmp, meta, url, reserved_key=key)

    def post_library_product(self):
        """POST /api/library/product (§2.11): what a shop's product page says. Adds nothing; a bad page is a 422."""
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        url = body.get("url") if isinstance(body, dict) else None
        if not isinstance(url, str) or not url.strip() or len(url) > 4096:
            return self.error_json(HTTPStatus.BAD_REQUEST, 'the body must be JSON like {"url": "https://...", "llm": true}')
        if not isinstance(body.get("llm", True), bool):
            return self.error_json(HTTPStatus.BAD_REQUEST, "llm must be true or false")
        status, data = product_page.read(url.strip(), llm=body.get("llm", True), reserve=self.library.reserve,
                                         release=self.library.release, costs_file=self.costs_file)
        return self.send_json(status, data)

    def patch_library_item(self, item_id: str):
        try:
            patch = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(patch, dict) or not patch:
            return self.error_json(HTTPStatus.BAD_REQUEST, "the body must be a JSON object with any of name, category, mount, yaw, default_render, dims_cm")
        unknown = sorted(set(patch) - {"name", "category", "mount", "yaw", "default_render", "dims_cm"})
        if unknown:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"{', '.join(unknown)} can't be edited: use name, category, mount, yaw, default_render or dims_cm")
        with self.library.locked():
            data = self.library.read()
            item = self.library.item(item_id, data) if SLUG.match(item_id) else None
            if item is None:
                return self.error_json(HTTPStatus.NOT_FOUND, f"no library item {item_id!r}: GET /api/library lists them")
            try:
                if "name" in patch and (not isinstance(patch["name"], str) or not patch["name"].strip()):
                    raise ValueError("name must be non-empty text")
                if "category" in patch and patch["category"] is not None and not isinstance(patch["category"], str):
                    raise ValueError("category must be text or null")
                if "mount" in patch and patch["mount"] not in ("floor", "wall"):
                    raise ValueError("mount must be floor or wall")
                if "default_render" in patch:
                    if patch["default_render"] not in ("glb", "splat"):
                        raise ValueError("default_render must be glb or splat")
                    assets = item.get("assets") or {}
                    has = (assets.get("splat") or assets.get("spz")) if patch["default_render"] == "splat" else assets.get("glb")
                    if not has:
                        raise ValueError(f"this item has no {patch['default_render']} asset, so it can't be its default render")
                    if patch["default_render"] == "glb" and (item.get("source") or {}).get("engine") == "idol":
                        # §4.5 Shows as: an Idol piece's model.glb is a stand-in box, never drawn.
                        raise ValueError("an Idol piece has no mesh to show: its model.glb is a stand-in box")
                yaw = patch.get("yaw", 0) or 0
                if isinstance(yaw, bool) or yaw not in (0, 90, 180, 270):
                    raise ValueError("yaw must be 0, 90, 180 or 270 (degrees, relative to now)")
                dims = check_dims(patch["dims_cm"]) if "dims_cm" in patch else None
            except ValueError as e:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
            changed = False
            for key in ("name", "category", "mount", "default_render"):
                if key in patch:
                    value = patch[key].strip() if isinstance(patch[key], str) else patch[key]
                    changed |= item.get(key) != value
                    item[key] = value
            if changed:
                self.library.write(data)
        refit = int(yaw) != 0 or (dims is not None and {k: float(v) for k, v in dims.items()} !=
                                  {k: float((item.get("dims_cm") or {}).get(k, 0)) for k in "wdh"})
        if not refit:
            return self.send_json(HTTPStatus.OK, item)
        cmd = [*self.library.midstudy_add, f"--rescale={item_id}", f"--library={self.library_dir.resolve()}"]
        if dims is not None:
            cmd += ["--dims=" + "x".join(num_text(dims[k]) for k in "wdh")]
        if yaw:
            cmd += [f"--yaw={int(yaw)}"]
        job, _ = self.library.new_job("rescale", item_id, "glb", 0.0, cmd, None)
        return self.send_json(HTTPStatus.ACCEPTED, {"job": job})

    def put_library_thumb(self, item_id: str):
        """PUT /api/library/items/<id>/thumb {"image": JPEG data URI} (≤ 2 MB): the planner's rendering of a piece added
        from a 3D file (midstudy-add makes thumbnails from photos only). Stored without metadata as <id>/thumb.jpg and
        set as assets.thumb; 200 the item."""
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        data = decode_data_uri(body.get("image") if isinstance(body, dict) else None, ("jpeg",))
        if data and len(data) > MAX_THUMB:
            return self.error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "thumbnail is over 2 MB: send a smaller JPEG")
        data = clean_jpeg(data) if data and data[:3] == b"\xff\xd8\xff" else None  # served: no metadata
        if not data or not jpeg_size(data):
            return self.error_json(HTTPStatus.BAD_REQUEST, "image must be a JPEG data URI (data:image/jpeg;base64,...)")
        with self.library.locked():
            lib = self.library.read()
            item = self.library.item(item_id, lib) if SLUG.match(item_id) else None
            if item is None:
                return self.error_json(HTTPStatus.NOT_FOUND, f"no library item {item_id!r}: GET /api/library lists them")
            folder = self.library_dir / item_id
            if not folder.is_dir():
                return self.error_json(HTTPStatus.CONFLICT, f"library item {item_id!r} has no folder: add it again")
            atomic_write_bytes(folder / "thumb.jpg", data)
            assets = item.get("assets") if isinstance(item.get("assets"), dict) else {}
            item["assets"] = {**assets, "thumb": f"{item_id}/thumb.jpg"}
            self.library.write(lib)
        return self.send_json(HTTPStatus.OK, item)

    def delete_library_item(self, item_id: str):
        with self.library.locked():
            data = self.library.read()
            item = self.library.item(item_id, data) if SLUG.match(item_id) else None
            if item is None:
                return self.error_json(HTTPStatus.NOT_FOUND, f"no library item {item_id!r}: GET /api/library lists them")
            base = f"{item_id}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
            trash, n = self.library_dir / ".trash" / base, 1
            while trash.exists():
                n += 1
                trash = self.library_dir / ".trash" / f"{base}-{n}"
            trash.mkdir(parents=True)
            folder = self.library_dir / item_id
            if folder.is_dir():
                shutil.move(str(folder), str(trash / item_id))
            atomic_write_json(trash / "entry.json", {"deleted": iso_utc(), "entry": item})
            data["items"] = [i for i in data["items"] if not (isinstance(i, dict) and i.get("id") == item_id)]
            self.library.write(data)
        return self.send_json(HTTPStatus.OK, {"ok": True, "trash": trash.relative_to(self.library_dir).as_posix()})

    def restore_library_item(self, item_id: str):
        if not SLUG.match(item_id):
            return self.error_json(HTTPStatus.NOT_FOUND, f"no trashed item {item_id!r}")
        with self.library.locked():
            data = self.library.read()
            if self.library.item(item_id, data) is not None or (self.library_dir / item_id).exists():
                return self.error_json(HTTPStatus.CONFLICT, f"an item {item_id!r} exists again: remove it (or rename the new one) first")
            copies = [t for t in self.library.trash() if t["id"] == item_id]
            if not copies:
                return self.error_json(HTTPStatus.NOT_FOUND, f"{item_id!r} isn't in the library's trash")
            trash = copies[0]["dir"]
            entry = read_json_file(trash / "entry.json")["entry"]
            if (trash / item_id).is_dir():
                shutil.move(str(trash / item_id), str(self.library_dir / item_id))
            data["items"].append(entry)
            self.library.write(data)
            shutil.rmtree(trash, ignore_errors=True)
        return self.send_json(HTTPStatus.OK, entry)


    # --- render (contract §2.6, §4.7) ------------------------------------------------
    def list_renders(self):
        scene = self.query("scene")
        renders = []
        if self.renders_dir.is_dir():
            for p in self.renders_dir.glob("render-*.json"):
                if not RENDER_NAME.match(p.stem):
                    continue
                try:
                    meta = json.loads(p.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(meta, dict) and (scene is None or meta.get("scene") == scene):
                    renders.append(meta)
        renders.sort(key=lambda m: (str(m.get("created", "")), str(m.get("name", ""))), reverse=True)
        return self.send_json(HTTPStatus.OK, {"renders": renders, "mock": fal_mock()})

    def reserve_render_name(self, now: datetime) -> str:
        base = f"render-{now:%Y%m%d-%H%M%S}"
        with render_lock:
            n, name = 1, base
            while name in reserved_names or any(
                    (self.renders_dir / f"{name}{ext}").exists() for ext in (".jpg", "-input.jpg", "-raw.jpg", ".json")):
                n += 1
                name = f"{base}-{n}"
            reserved_names.add(name)
        return name

    def post_render(self):
        try:
            body = self.read_json_body()
        except ValueError as e:
            return self.error_json(HTTPStatus.BAD_REQUEST, str(e))
        if not isinstance(body, dict):
            return self.error_json(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
        data = decode_data_uri(body.get("image"), ("jpeg",))
        # Stored, served and sent to fal: without any metadata the client's JPEG may carry (§2.6, privacy).
        data = clean_jpeg(data) if data and data[:3] == b"\xff\xd8\xff" else None
        if not data:
            return self.error_json(HTTPStatus.BAD_REQUEST, "image must be a JPEG data URI (data:image/jpeg;base64,...)")
        model = body.get("model") or "nano-banana"
        if model not in RENDER_MODELS:
            return self.error_json(HTTPStatus.BAD_REQUEST, f"unknown model {model!r} (choose from {', '.join(RENDER_MODELS)})")
        prompt = body.get("prompt")
        if prompt is not None and not isinstance(prompt, str):
            return self.error_json(HTTPStatus.BAD_REQUEST, "prompt must be a string")
        scene = body.get("scene")
        if scene is not None and (not isinstance(scene, str) or not self.scenes.exists(scene)):
            return self.no_scene(scene if isinstance(scene, str) else "")
        layout = body.get("layout") if isinstance(body.get("layout"), str) and SLUG.match(body.get("layout")) else None
        keep_room = body.get("keep_room") is True
        mask = None
        photo = None
        if scene:
            photo_path = self.scenes.path(scene) / "photo.jpg"
            if not photo_path.is_file():
                return self.error_json(HTTPStatus.CONFLICT, "this scene has no photo yet: wait for it to finish calibrating")
            photo = photo_path.read_bytes()
        if keep_room:
            if not scene:
                return self.error_json(HTTPStatus.BAD_REQUEST, "keep_room needs the scene: send scene with it")
            mask = decode_data_uri(body.get("mask"), ("png",))
            if not mask or png_size(mask) is None:
                return self.error_json(HTTPStatus.BAD_REQUEST, "keep_room needs a mask: a PNG data URI (data:image/png;base64,...) at the photo's size")
            psize = jpeg_size(photo)
            if psize and tuple(png_size(mask)) != tuple(psize):
                w, h = png_size(mask)
                return self.error_json(HTTPStatus.BAD_REQUEST, f"the mask is {w} x {h}, but it must be the photo's size ({psize[0]} x {psize[1]})")
        reference = model == "nano-banana" and photo is not None
        if not prompt or not prompt.strip():
            prompt = REFERENCE_RENDER_PROMPT if reference else DEFAULT_RENDER_PROMPT
        spec = RENDER_MODELS[model]
        size = jpeg_size(data)
        if not size:
            # The price can depend on the size (qwen: $0.03 a megapixel), so a composite whose frame header can't be
            # read isn't guessed at 1 MP against the cap: it is refused (§2.6, §2.9).
            return self.error_json(HTTPStatus.BAD_REQUEST, "the image's size can't be read from its JPEG frame header: send a plain baseline or progressive JPEG")
        megapixels = size[0] * size[1] / 1e6
        mock = fal_mock()
        key = None if mock else fal_key()
        if not mock and not key:
            return self.error_json(HTTPStatus.SERVICE_UNAVAILABLE, NO_KEY)

        price = spec["cost"](megapixels)
        now = datetime.now(timezone.utc)
        name = self.reserve_render_name(now)
        refused = self.library.reserve(name, price if counts_against_cap() else 0.0)  # §2.9 spend cap
        if refused:
            with render_lock:
                reserved_names.discard(name)
            return self.send_json(HTTPStatus.PAYMENT_REQUIRED, refused)
        try:
            return self.render(data, model, prompt, scene, layout, photo if reference else None, keep_room, mask,
                               spec, size, price, mock, key, now, name)
        finally:
            self.library.release(name)

    def render(self, data, model, prompt, scene, layout, reference, keep_room, mask, spec, size, price, mock, key, now, name):
        cost = price if mock and mock_cost() else 0.0
        stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        if mock:
            result = data  # mock: the "render" is the input, $0 (or its real price with MIDSTUDY_FAL_MOCK_COST=1), no network
        else:
            uri = lambda b: "data:image/jpeg;base64," + base64.b64encode(b).decode("ascii")
            if spec["image_key"] == "image_urls":
                image_arg = [uri(data)] + ([uri(reference)] if reference else [])
            else:
                image_arg = uri(data)
            args = {spec["image_key"]: image_arg, "prompt": prompt, "output_format": "jpeg"}
            try:
                out = fal_call(spec["endpoint"], args, key)
            except FalError as e:
                return self.error_json(HTTPStatus.BAD_GATEWAY, str(e))
            # fal has returned, so the call is billed: record it even if the download below fails.
            cost = price
            append_cost(self.costs_file, stamp, name, f"render:{model}", cost, False, scene or "")
            images = out.get("images") if isinstance(out, dict) else None
            url = images[0].get("url") if isinstance(images, list) and images and isinstance(images[0], dict) else None
            if not url:
                return self.error_json(HTTPStatus.BAD_GATEWAY, f"fal {spec['endpoint']} returned no image (${fmt_cost(cost)} recorded)")
            try:
                result = download(url)
            except Exception as e:  # noqa: BLE001 - any download failure is a 502
                return self.error_json(HTTPStatus.BAD_GATEWAY, f"could not download the render ({e}); ${fmt_cost(cost)} recorded")
        atomic_write_bytes(self.renders_dir / f"{name}-input.jpg", data)
        aligned = None
        if keep_room:
            atomic_write_bytes(self.renders_dir / f"{name}-raw.jpg", result)
            aligned = self.align(scene, name, mask)
            if not aligned["applied"]:
                atomic_write_bytes(self.renders_dir / f"{name}.jpg", result)
        else:
            atomic_write_bytes(self.renders_dir / f"{name}.jpg", result)
        final = (self.renders_dir / f"{name}.jpg").read_bytes()
        out_size = jpeg_size(final)
        meta = {
            "name": name,
            "url": f"/renders/{name}.jpg",
            "input_url": f"/renders/{name}-input.jpg",
            "raw_url": f"/renders/{name}-raw.jpg" if keep_room else None,
            "model": model,
            "endpoint": spec["endpoint"],
            "cost_usd": cost,
            "mock": mock,
            "prompt": prompt,
            "created": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "scene": scene,
            "layout": layout,
            "reference": reference is not None,
            "keep_room": keep_room,
            "aligned": aligned,
            "width": size[0] if size else None,
            "height": size[1] if size else None,
            "out_w": out_size[0] if out_size else None,
            "out_h": out_size[1] if out_size else None,
        }
        atomic_write_json(self.renders_dir / f"{name}.json", meta)
        if mock:
            append_cost(self.costs_file, stamp, name, f"render:{model}", cost, True, scene or "")
        with render_lock:
            reserved_names.discard(name)  # the files now hold the name; after a failure it stays reserved
        return self.send_json(HTTPStatus.OK, meta)

    def align(self, scene: str, name: str, mask: bytes) -> dict:
        """Keep room exact (§4.7): `<calib> align <scene photo.jpg> <name>-raw.jpg <mask.png> --out <name>.jpg`. The
        tool writes to a temp name that is renamed into place only when it applied; any failure (no calib/, a bad
        exit) counts as not applied, with the reason."""
        photo = (self.scenes.path(scene) / "photo.jpg").resolve()
        raw = (self.renders_dir / f"{name}-raw.jpg").resolve()
        tmp = Path(tempfile.mkdtemp(prefix="midstudy-align-"))
        out = self.renders_dir / f".{name}.aligned.jpg"
        try:
            (tmp / "mask.png").write_bytes(mask)
            cmd = [*self.scenes.calib, "align", str(photo), str(raw), str(tmp / "mask.png"), "--out", str(out.resolve())]
            try:
                proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=ALIGN_TIMEOUT, stdin=subprocess.DEVNULL)
            except FileNotFoundError:
                return {"applied": False, "inliers": None, "residual_px": None,
                        "reason": f"the calibration tool isn't installed here ({cmd[0]} not found): set --calib"}
            except subprocess.TimeoutExpired:
                return {"applied": False, "inliers": None, "residual_px": None,
                        "reason": f"align ran for more than {ALIGN_TIMEOUT} s and was stopped"}
            res = last_json_line(proc.stdout)
            if proc.returncode != 0 or not isinstance(res, dict) or res.get("ok") is not True:
                return {"applied": False, "inliers": None, "residual_px": None,
                        "reason": tool_error(proc, res, "midstudy-calib align")}
            inliers = res.get("inliers") if is_num(res.get("inliers")) else None
            residual = res.get("residual_px") if is_num(res.get("residual_px")) else None
            if res.get("applied") is True and out.is_file():
                os.replace(out, self.renders_dir / f"{name}.jpg")
                return {"applied": True, "inliers": inliers, "residual_px": residual}
            reason = res.get("reason") if isinstance(res.get("reason"), str) else (
                "align said it applied but wrote no image" if res.get("applied") is True else "align did not apply")
            return {"applied": False, "inliers": inliers, "residual_px": residual, "reason": reason}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            try:
                out.unlink()
            except OSError:
                pass


def resolve(p: str) -> Path:
    path = Path(p).expanduser()
    return path if path.is_absolute() else (REPO / path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="midstudy planner server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--scenes-dir", default="scenes", help="the scenes (one folder per uploaded photo; default: the repo's scenes/)")
    ap.add_argument("--library-dir", default=None, help="serve /library/ from here (default: the repo's library/)")
    ap.add_argument("--layouts-dir", default="layouts")
    ap.add_argument("--renders-dir", default="renders")
    ap.add_argument("--costs-file", default=None,
                    help="default: <library-dir>/costs.csv, where midstudy-add writes its rows; if given, it must be that file")
    ap.add_argument("--calib", default=DEFAULT_CALIB,
                    help=f"the calibration command, run as an argument list (default: {DEFAULT_CALIB})")
    ap.add_argument("--midstudy-add", default=DEFAULT_MIDSTUDY_ADD,
                    help=f"the command that adds furniture, run with --library <library-dir> (default: {DEFAULT_MIDSTUDY_ADD})")
    ap.add_argument("--allowed-host", action="append", default=[], metavar="NAME",
                    help="also answer requests with this Host name, e.g. midstudy.example.com (repeatable; loopback names always work)")
    ap.add_argument("--daily-spend-usd", type=float, default=2.0,
                    help="cap on paid fal calls (library adds and renders) per UTC day, in USD (default 2)")
    args = ap.parse_args(argv)
    if args.daily_spend_usd < 0:
        ap.error("--daily-spend-usd can't be negative")
    calib = shlex.split(args.calib)
    if not calib:
        ap.error("--calib can't be empty")
    for h in args.allowed_host:
        # The same rule as a Host header (§2.9): exactly name[:port]. A URL or a typo would otherwise add "" to the
        # allowlist, which a request with no Host, or a malformed one, would match.
        if not host_name(h):
            ap.error(f"--allowed-host {h!r} isn't a host name: give it as name or name:port (e.g. midstudy.example.com)")

    library_dir = resolve(args.library_dir or "library")
    costs_file = resolve(args.costs_file) if args.costs_file else library_dir / "costs.csv"
    # midstudy-add always writes <library-dir>/costs.csv, so the cap would miss its rows (library adds would be
    # unlimited) if this read another file: refuse any other --costs-file, with or without --library-dir (§2.9 W2).
    if costs_file.resolve() != (library_dir / "costs.csv").resolve():
        sys.exit(f"midstudy planner: --costs-file {costs_file} isn't {library_dir / 'costs.csv'}, where midstudy-add writes "
                 "its costs: drop --costs-file (it defaults to <library-dir>/costs.csv)")
    library = LibraryService(library_dir, costs_file, shlex.split(args.midstudy_add), args.daily_spend_usd)
    layouts_dir = resolve(args.layouts_dir)
    scenes = SceneService(resolve(args.scenes_dir), layouts_dir, calib)
    handler = partial(Handler, layouts_dir=layouts_dir, renders_dir=resolve(args.renders_dir), costs_file=costs_file,
                      scenes=scenes, library_dir=library_dir, library=library, allowed_hosts=tuple(args.allowed_host))
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"midstudy planner: http://{args.host}:{httpd.server_address[1]}/planner/  (serving {REPO})", flush=True)
    if fal_mock():
        print("midstudy planner: MIDSTUDY_FAL_MOCK is set, so Render makes no fal calls and costs $0", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
