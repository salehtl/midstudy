"""v1's answers for server/test/differential.test.ts: reads [{"fn": name, "args": [...]}, ...] (JSON) on stdin and prints
one JSON list of answers, each {"ok": value} or {"error": "<ExceptionClass>: <message>"}. Every case runs v1's own code
(planner/serve.py) or the Python standard library v1 relied on, so the TypeScript port is compared with the real
thing. Run with the dev shell's Python 3.12 (`nix develop -c python3 -I server/test/v1_oracle.py`). Nothing here
touches the network, .env or fixtures/photos."""
import argparse
import csv
import importlib.util
import io
import ipaddress
import json
import math
import os
import shlex
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urljoin, urlsplit, urlunsplit

REPO = Path(__file__).resolve().parent.parent.parent
os.environ["MIDSTUDY_NO_DOTENV"] = "1"
os.environ.pop("FAL_KEY", None)
os.environ.pop("MIDSTUDY_FAL_MOCK", None)
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("v1_serve", REPO / "planner" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def json_safe(v):
    if isinstance(v, float) and not math.isfinite(v):
        return {"float": repr(v)}
    if isinstance(v, (list, tuple)):
        return [json_safe(x) for x in v]
    if isinstance(v, dict):
        return {k: json_safe(x) for k, x in v.items()}
    return v


def split(url):
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    return {"scheme": p.scheme, "netloc": p.netloc, "path": p.path, "query": p.query, "fragment": p.fragment}


def hostname(url):
    try:
        p = urlsplit(url)
    except ValueError:
        return "ValueError"
    return p.hostname


def port(url):
    try:
        p = urlsplit(url)
    except ValueError:
        return "ValueError"
    try:
        return p.port
    except ValueError:
        return "invalid"


def join(base, url):
    try:
        return urljoin(base, url)
    except ValueError:
        return None


def ipv4(s):
    try:
        return int(ipaddress.IPv4Address(s))
    except ValueError:
        return None


def ipv6(s):
    try:
        n = int(ipaddress.IPv6Address(s))
    except ValueError:
        return None
    return [(n >> (16 * (7 - i))) & 0xFFFF for i in range(8)]


def fetch_allowed(allow, host, port):
    os.environ["MIDSTUDY_FETCH_ALLOW"] = allow
    try:
        return serve.fetch_allowed(host, port)
    finally:
        del os.environ["MIDSTUDY_FETCH_ALLOW"]


def query_value(qs, key):
    v = parse_qs(qs).get(key)
    return v[0] if v else None


def parse_csv(text):
    return list(csv.reader(io.StringIO(text, newline="")))


def csv_line(fields):
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerow(fields)
    return out.getvalue()


def costs_text(existing, row):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "costs.csv"
        if existing is not None:
            p.write_bytes(existing.encode("utf-8"))
        serve._append_cost(p, row["date"], row["id"], row["engine"], row["costUsd"], row["mock"], row["input"])
        return p.read_text(encoding="utf-8")


def spent_on(text, day):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "costs.csv"
        p.write_bytes(text.encode("utf-8"))
        lib = serve.LibraryService.__new__(serve.LibraryService)  # no worker thread: spent() reads costs_file only
        lib.costs_file = p
        return lib.spent(day)


def refusal(amount, spent, reserved, cap):
    """v1 reserve()'s decision, with costs.csv and the reservations set so that spent() and the sum are as given."""
    lib = serve.LibraryService.__new__(serve.LibraryService)
    import threading
    lib.mutex = threading.Lock()
    lib.cap = cap
    lib.reserved = {"other": reserved} if reserved else {}
    lib.spent = lambda day: spent
    return lib.reserve("k", amount)


def tool_error(error, stderr, code, tool):
    class Proc:
        pass
    p = Proc()
    p.stderr = stderr
    p.returncode = code
    out = {"error": error} if error is not None else {}
    return serve.tool_error(p, out, tool)


def add_error(stderr, code):
    err = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    mine = [ln for ln in err if ln.startswith("midstudy-add:")]
    return (mine or err or [f"midstudy-add exited with code {code}"])[-1]


def dotenv(text, key):
    for line in text.splitlines():
        k, sep, value = line.strip().removeprefix("export ").strip().partition("=")
        if sep and k.strip() == key:
            value = value.strip().strip("'\"")
            if value:
                return value
    return None


def py_float(s):
    try:
        return json_safe(float(s))
    except ValueError:
        return None


def py_int(s):
    try:
        return int(s)
    except ValueError:
        return None


def shlex_split(s):
    try:
        return {"ok": shlex.split(s)}
    except ValueError as e:
        return {"error": str(e)}


def iso_utc(ms):
    return serve.iso_utc(ms / 1000)


def iso_utc_ms(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_stamp(ms):
    return f"{datetime.fromtimestamp(ms / 1000, timezone.utc):%Y%m%d-%H%M%S}"


def utc_day(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def api_path(target):
    path = unquote(urlsplit(target).path)
    return path if path == "/api" or path.startswith("/api/") else None


def folder_location(target):
    p = urlsplit(target)
    return urlunsplit((p[0], p[1], p[2] + "/", p[3], p[4]))


def html_error(code, message):
    from http.server import DEFAULT_ERROR_MESSAGE
    import html
    from http import HTTPStatus
    return DEFAULT_ERROR_MESSAGE % {"code": code, "message": html.escape(message, quote=False),
                                    "explain": html.escape(HTTPStatus(code).description, quote=False)}


def guess_type(p):
    return serve.Handler.guess_type(serve.Handler, p)


def argparse_cli(argv):
    """v1 main()'s parser (planner/serve.py), its result or argparse's error message."""
    class Stop(Exception):
        pass

    class Parser(argparse.ArgumentParser):
        def error(self, message):
            raise Stop(message)

        def exit(self, status=0, message=None):
            raise Stop("exit")

    ap = Parser(description="midstudy planner server", prog="main.ts")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--scenes-dir", default="scenes")
    ap.add_argument("--library-dir", default=None)
    ap.add_argument("--layouts-dir", default="layouts")
    ap.add_argument("--renders-dir", default="renders")
    ap.add_argument("--costs-file", default=None)
    ap.add_argument("--calib", default=serve.DEFAULT_CALIB)
    ap.add_argument("--midstudy-add", default=serve.DEFAULT_MIDSTUDY_ADD)
    ap.add_argument("--allowed-host", action="append", default=[], metavar="NAME")
    ap.add_argument("--daily-spend-usd", type=float, default=2.0)
    try:
        with open(os.devnull, "w") as null:
            old = sys.stdout
            sys.stdout = null
            try:
                a = ap.parse_args(argv)
            finally:
                sys.stdout = old
    except Stop as e:
        return {"error": str(e)}
    return {"options": json_safe({"port": a.port, "host": a.host, "scenesDir": a.scenes_dir, "libraryDir": a.library_dir,
                                  "layoutsDir": a.layouts_dir, "rendersDir": a.renders_dir, "costsFile": a.costs_file,
                                  "calib": a.calib, "midstudyAdd": a.midstudy_add, "allowedHosts": a.allowed_host,
                                  "dailySpendUsd": a.daily_spend_usd})}


FUNCS = {
    "pyFixed": lambda x, d: format(x, f".{d}f"),
    "pyRound": lambda x, n: round(x, n),
    "fmtCost": serve.fmt_cost,
    "pyFloatRepr": lambda x: repr(float(x)),
    "pyFormatG": lambda x: format(x, "g"),
    "numText": serve.num_text,
    "mbText": serve.mb_text,
    "pyRepr": repr,
    "pyStrip": lambda s: s.strip(),
    "pySplitlines": lambda s: s.splitlines(),
    "shlexSplit": shlex_split,
    "parseCsv": parse_csv,
    "csvLine": csv_line,
    "costsText": costs_text,
    "spentOn": spent_on,
    "pyFloat": py_float,
    "pyInt": py_int,
    "urlsplit": split,
    "urlHostname": hostname,
    "urlPort": port,
    "urljoin": join,
    "unquote": unquote,
    "queryValue": query_value,
    "parseIpv4": ipv4,
    "parseIpv6": ipv6,
    "addressBlocked": serve.address_blocked,
    "fetchAllowed": fetch_allowed,
    "slugify": serve.slugify,
    "posixName": lambda s: PurePosixPath(s).name,
    "dotenvValue": dotenv,
    "isoUtc": iso_utc,
    "isoUtcMs": iso_utc_ms,
    "utcStamp": utc_stamp,
    "utcDay": utc_day,
    "lastJsonLine": serve.last_json_line,
    "toolError": tool_error,
    "addError": add_error,
    "refusal": refusal,
    "apiPathOf": api_path,
    "folderLocation": folder_location,
    "htmlErrorPage": html_error,
    "mimeType": guess_type,
    "hostName": serve.host_name,
    "parseCli": argparse_cli,
}

cases = json.load(sys.stdin)
answers = []
for case in cases:
    try:
        answers.append({"ok": json_safe(FUNCS[case["fn"]](*case["args"]))})
    except Exception as e:  # noqa: BLE001 - every exception is an answer
        answers.append({"error": f"{type(e).__name__}: {e}"})
print(json.dumps(answers))
