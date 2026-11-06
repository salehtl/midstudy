"""v1's answers for server/test/scenes/logic.test.ts: reads [{"fn": name, "args": [...]}, ...] (JSON) on stdin and
prints one JSON list of answers, each {"ok": value} or {"error": "<ExceptionClass>: <message>"}. Every case runs v1's
own code (planner/serve.py: its handlers with a stand-in `self`, SceneService on a scratch folder, its helpers), so the
TypeScript port is compared with the real thing. Nothing here touches the network, .env or fixtures/photos."""
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent.parent
os.environ["MIDSTUDY_NO_DOTENV"] = "1"
os.environ.pop("FAL_KEY", None)
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("v1_serve", REPO / "planner" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)
Handler = serve.Handler
NOW = "2026-11-05T12:00:00Z"


class Answered(Exception):
    pass


class FakeScenes:
    """What put_scene and put_layout ask of SceneService: the scene exists; update records the patch."""

    def __init__(self):
        self.patch = None

    def exists(self, name):
        return True

    def update(self, name, patch):
        self.patch = patch

    def full(self, name):
        return {"full": name}


class Fake:
    """A stand-in for the request handler: the body as read_json_body would give it, answers recorded."""

    def __init__(self, body, query=None):
        self.body = body
        self.scenes = FakeScenes()
        self.answer = None
        self.layouts_dir = Path(tempfile.mkdtemp(prefix="v1-oracle-layouts-"))
        self.q = query

    def read_json_body(self):
        return self.body

    def error_json(self, status, message):
        self.answer = {"status": int(status), "error": message}

    def send_json(self, status, data):
        self.answer = {"status": int(status), "data": data}

    def no_scene(self, name):
        return Handler.no_scene(self, name)

    def query(self, key):
        return self.q

    def layout_scene(self):
        return Handler.layout_scene(self)

    def bad_layout_name(self, name):
        return Handler.bad_layout_name(self, name)


def put_scene(body):
    f = Fake(body)
    Handler.put_scene(f, "scene-20261105-120000")
    if f.answer and "error" in f.answer:
        return f.answer
    return {"status": 200, "patch": f.scenes.patch}


def put_layout(body, name):
    f = Fake(body, query="scene-20261105-120000")
    written = {}
    orig_write, orig_iso = serve.atomic_write_json, serve.iso_utc
    serve.atomic_write_json = lambda path, data: written.update(path=str(path), data=data)
    serve.iso_utc = lambda t=None: NOW
    try:
        Handler.put_layout(f, name)
    finally:
        serve.atomic_write_json, serve.iso_utc = orig_write, orig_iso
    return f.answer


def update(scene_json, patch):
    """SceneService.update on a scratch scenes folder: what scene.json becomes (saved: whether it was stamped)."""
    d = Path(tempfile.mkdtemp(prefix="v1-oracle-scenes-"))
    svc = serve.SceneService.__new__(serve.SceneService)  # no worker thread: update needs only the files and the lock
    svc.dir, svc.layouts_dir, svc.lock = d, d / "layouts", serve.threading.RLock()
    name = "scene-20261105-120000"
    (d / name).mkdir()
    (d / name / "scene.json").write_text(json.dumps(scene_json))
    data = svc.update(name, patch)
    out = json.loads((d / name / "scene.json").read_text())
    out["saved"] = out.get("saved") != scene_json.get("saved")
    return {"returned_matches_file": json.loads(json.dumps(data)) == json.loads((d / name / "scene.json").read_text()), "file": out}


def mtime(ns, folder):
    ns = int(ns)  # nanoseconds since the epoch, as text (JSON numbers lose them)
    p = Path(folder) / ("m" + str(ns))
    p.write_bytes(b"")
    os.utime(p, ns=(ns, ns))
    t = p.stat().st_mtime
    return {"path": str(p), "repr": repr(t), "int": int(t), "iso": serve.iso_utc(t)}


def light_message(found, cct):
    svc = serve.SceneService.__new__(serve.SceneService)
    svc.lock = serve.threading.RLock()
    svc.jobs = {"l-1": {"id": "l-1", "scene": "x", "status": "running"}}
    svc.dir = Path(tempfile.mkdtemp(prefix="v1-oracle-"))
    serve.SceneService.light_done(svc, "l-1", {"ok": True, "lighting": found, "cct_k": cct})
    return svc.jobs["l-1"]["message"]


def calibrated_message(calib):
    # v1 SceneService.run, verbatim (it runs only after a real tool run)
    src = calib.get("source")
    floor = calib.get("floor") if isinstance(calib.get("floor"), dict) else {}
    note = "" if src in ("moge-2", "truth") and floor.get("found") else " · check the floor"
    return f"calibrated ({src or 'unknown'}){note}"


def trashed(name):
    m = serve.TRASHED_SCENE.match(name)
    return m.group(1) if m else None


FNS = {
    "clamp_camera": lambda cam: serve.clamp_camera(cam),
    "public_calib": lambda calib: serve.public_calib(calib),
    "name_order": lambda name: list(serve.name_order(name)),
    "trashed": trashed,
    "put_scene": put_scene,
    "put_layout": put_layout,
    "update": update,
    "mtime": mtime,
    "light_message": light_message,
    "calibrated_message": calibrated_message,
    "no_scene": lambda name: Handler.no_scene(Fake(None), name) or None,
}


def main():
    cases = json.load(sys.stdin)
    out = []
    for c in cases:
        try:
            if c["fn"] == "no_scene":
                f = Fake(None)
                Handler.no_scene(f, *c["args"])
                out.append({"ok": f.answer})
            else:
                out.append({"ok": FNS[c["fn"]](*c["args"])})
        except Exception as e:  # noqa: BLE001 - v1's exception is the answer
            out.append({"error": f"{type(e).__name__}: {e}"})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
