"""align-room on real MoGe-2 depth, measured against the golden room's truth (docs/notes/rooms-calib-real.md).

Run with calib's environment (the rooms extra), from the repo root, through the eval lock:

    nix develop -c node scripts/eval-lock.mjs --exclusive -- \\
      uv run --project calib --extra rooms python evals/rooms_moge.py calibrate     # real MoGe-2 on the golden photos
    ... python evals/rooms_moge.py solve [--set room|alt]                            # real MASt3R once, its views cached
    ... python evals/rooms_moge.py analyze [--set room|alt] [--depth moge|exact] [--json out.json]
    ... python evals/rooms_moge.py diagnose [--set room|alt]                         # the error sources, one at a time
    ... python evals/rooms_moge.py align [--set room|alt] [--depth moge|exact]       # the real align-room command

Everything goes to evals/out/rooms-moge/ (git-ignored): scenes/<id>/ (each golden photo calibrated by the real
`midstudy-calib run`, not the fixtures' exact depth), views-<set>.npz (MASt3R's cameras and depth: they depend only on
the photos, so the same views serve every variant below and MASt3R's ~0.5 cm run-to-run noise drops out).

Sets: `room` = living-wide (the frame) + room-1..6 (truth.json pose_in_room). `alt` = a second set for held-out checks:
steep-roll (the frame: it stands at living-wide's camera, other height, pitch and roll), portrait (same spot), room-2,
room-4, room-5.

Errors per placed member: position (cm) raw (the room frame read as metres, before Set scale), after the single best
global scale (what the user's one tape measurement fixes), yaw (degrees), and scale error (%): the member's scale against
the true one, (H_i / h_i) · (h_0 / H_0), h the calibrated camera height, H the true one.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

import numpy as np

REPO = Path(__file__).resolve().parent.parent
SCENES = REPO / "fixtures/scenes"
OUT = REPO / "evals/out/rooms-moge"
SETS = {
    "room": ["living-wide", "room-1", "room-2", "room-3", "room-4", "room-5", "room-6"],
    "alt": ["steep-roll", "portrait", "room-2", "room-4", "room-5"],
}
ALL = sorted({s for v in SETS.values() for s in v})
ROOM = SETS["room"]
# every pair of the golden room (the earlier one the frame), and steep-roll and portrait (at living-wide's spot) with
# each room photo; three more multi-photo sets with other frames
PAIRS = [f"{a}+{b}" for i, a in enumerate(ROOM) for b in ROOM[i + 1:]] + [f"{a}+{b}" for a in ("steep-roll", "portrait") for b in ROOM[1:]]
MULTI = ["room-1+room-2+room-3+room-5", "room-3+room-4+room-5+room-6", "portrait+room-1+room-3+room-6"]
GROUPS = {"pairs": PAIRS, "multi": MULTI, "sets": ["room", "alt"], "all": ["room", "alt", *MULTI, *PAIRS]}


def ids_of(name: str) -> list[str]:
    """A named set, or photo ids joined with '+' (the first is the frame)."""
    return SETS.get(name) or name.split("+")


def names(arg: str) -> list[str]:
    """--set: a set, a group (pairs, multi, sets, all) or several of them, comma-separated."""
    return [n for part in arg.split(",") for n in GROUPS.get(part, [part])]

from midstudy_calib.rooms import mast3r as m3  # noqa: E402
from midstudy_calib.rooms import score as sc  # noqa: E402
from midstudy_calib.rooms import solver as sv  # noqa: E402
from midstudy_calib.rooms.geometry import Placement, relative_to, wrap_deg  # noqa: E402
from midstudy_calib.rooms.photos import Camera, RoomPhoto, load  # noqa: E402


def truth(sid: str) -> tuple[Placement, Camera]:
    t = json.loads((SCENES / sid / "truth.json").read_text())
    c = t["camera"]
    cam = Camera(math.radians(c["fov_y_deg"]), c["height_m"], math.radians(c["pitch_deg"]), math.radians(c["roll_deg"]))
    p = t.get("pose_in_room")
    pl = Placement(p["x_m"], p["z_m"], math.radians(p["yaw_deg"]), 1.0) if p else Placement(0.0, 0.0, 0.0, 1.0)
    return pl, cam


def photos(ids: list[str], depth: str) -> list[RoomPhoto]:
    root = SCENES if depth == "exact" else OUT / "scenes"
    return [load(root / s) for s in ids]


# ---------------------------------------------------------------- calibrate

def calibrate(_: argparse.Namespace) -> None:
    env = {**os.environ, "MIDSTUDY_NO_DOTENV": "1", "NOOK_NO_DOTENV": "1"}
    env.pop("MIDSTUDY_CALIB_MOCK", None)
    p = subprocess.Popen([str(Path(sys.executable).parent / "midstudy-calib"), "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env=env)
    assert p.stdin and p.stdout
    rows = []
    for sid in ALL:
        out = OUT / "scenes" / sid
        out.mkdir(parents=True, exist_ok=True)
        p.stdin.write(json.dumps({"id": sid, "cmd": "run", "args": [str(SCENES / sid / "photo.jpg"), "--out", str(out)]}) + "\n")
        p.stdin.flush()
        r = json.loads(p.stdout.readline())
        if not r.get("ok"):
            raise SystemExit(f"{sid}: {r}")
        c, (_, t) = r["camera"], truth(sid)
        rows.append({"id": sid, "fov": c["fov_y_deg"], "fov_t": round(math.degrees(t.fov_y), 2), "h": c["height_m"], "h_t": t.height,
                     "h_err_pct": round(100 * (c["height_m"] / t.height - 1), 2), "pitch": c["pitch_deg"],
                     "pitch_err": round(c["pitch_deg"] - math.degrees(t.pitch), 2),
                     "roll": c["roll_deg"], "roll_err": round(c["roll_deg"] - math.degrees(t.roll), 2)})
        print(json.dumps(rows[-1]), flush=True)
    p.stdin.close()
    p.wait()
    (OUT / "calib.json").write_text(json.dumps(rows, indent=1))


# ---------------------------------------------------------------- solve (MASt3R once)

def solve(a: argparse.Namespace) -> None:
    """MASt3R on each set (one process: the network loads once), its views saved for the other commands."""
    from midstudy_calib.moge_runner import pick_device

    got: list[sv.View] = []

    def capture(_p: list[RoomPhoto], views: list[sv.View]) -> list[sc.Candidate | None]:
        got.extend(views)
        return [None] * len(views)

    setattr(m3, "from_views", capture)  # noqa: B010
    device = pick_device("auto")
    for name in names(a.set):
        got.clear()
        m3.Mast3r().solve(photos(ids_of(name), "moge"), device)
        arrs: dict[str, Any] = {}
        for i, v in enumerate(got):
            for k in ("c2w", "k", "depth", "conf", "u", "v"):
                arrs[f"{i}_{k}"] = getattr(v, k)
        np.savez_compressed(OUT / f"views-{name}.npz", n=len(got), **arrs)
        print(f"saved {len(got)} views to {OUT / f'views-{name}.npz'}", flush=True)


def views(set_: str) -> list[sv.View]:
    z = np.load(OUT / f"views-{set_}.npz")
    return [sv.View(*(z[f"{i}_{k}"] for k in ("c2w", "k", "depth", "conf", "u", "v"))) for i in range(int(z["n"]))]


# ---------------------------------------------------------------- errors

def errors(ids: list[str], ph: list[RoomPhoto], pls: list[Placement | None]) -> dict[str, Any]:
    """Per member: raw position error (cm), after the best global scale, yaw, scale error (%)."""
    t0, c0 = truth(ids[0])
    h0 = ph[0].cam().height
    want = [relative_to(truth(s)[0], t0) for s in ids]
    # the best global scale, robustly: the median member's, then least squares over the members within 20 cm of it
    # (one wrong placement, e.g. a bare wall 2 m off, would otherwise drag it)
    pairs = [(p, w) for p, w in zip(pls[1:], want[1:], strict=True) if p is not None and p.x * p.x + p.z * p.z > 1e-9]
    g = float(np.median([(p.x * w.x + p.z * w.z) / (p.x * p.x + p.z * p.z) for p, w in pairs])) if pairs else 1.0
    keep = [(p, w) for p, w in pairs if math.hypot(g * p.x - w.x, g * p.z - w.z) < 0.2]
    if keep:
        g = sum(p.x * w.x + p.z * w.z for p, w in keep) / sum(p.x * p.x + p.z * p.z for p, w in keep)
    ga = c0.height / h0  # a perfect Set scale in the frame's photo
    rows = []
    for sid, s, p, w in zip(ids, ph, pls, want, strict=True):
        if p is None:
            rows.append({"id": sid, "placed": False})
            continue
        h_t = truth(sid)[1].height
        s_true = (h_t / s.cam().height) * (h0 / c0.height)
        rows.append({"id": sid, "placed": True, "raw_cm": round(100 * math.hypot(p.x - w.x, p.z - w.z), 2),
                     "scaled_cm": round(100 * math.hypot(g * p.x - w.x, g * p.z - w.z), 2),
                     "anchor_cm": round(100 * math.hypot(ga * p.x - w.x, ga * p.z - w.z), 2),
                     "yaw_deg": round(abs(wrap_deg(math.degrees(p.yaw - w.yaw))), 3),
                     "scale_pct": round(100 * (p.scale / s_true - 1), 2)})
    return {"global_scale": round(g, 4), "global_scale_true": round(c0.height / h0, 4), "members": rows}


def table(title: str, e: dict[str, Any], scored: list[sc.Scored] | None = None) -> None:
    print(f"\n{title}  (best global scale {e['global_scale']}, H0/h0 {e['global_scale_true']})")
    print(f"  {'photo':12} {'raw cm':>7} {'scaled cm':>9} {'yaw °':>6} {'scale %':>8} {'conf':>6} {'res cm':>7}")
    for i, r in enumerate(e["members"]):
        s = scored[i] if scored else None
        cf = f"{s.confidence:6.3f}" if s else "     -"
        rs = f"{s.residual_cm:7.2f}" if s and s.residual_cm is not None else "      -"
        if not r["placed"]:
            print(f"  {r['id']:12} {'(not placed by the solver)':>33} {cf} {rs}")
            continue
        print(f"  {r['id']:12} {r['raw_cm']:7.2f} {r['scaled_cm']:9.2f} {r['yaw_deg']:6.2f} {r['scale_pct']:8.2f} {cf} {rs}")


def scored_once(ph: list[RoomPhoto], cands: list[sc.Candidate | None]) -> list[sc.Scored]:
    pts = [p.lift_rel(step=6) for p in ph]
    return sc.score_once(ph, cands, pts)[0]


def analyze(a: argparse.Namespace) -> dict[str, Any]:
    ids = ids_of(a.set)
    ph = photos(ids, a.depth)
    cands = sv.from_views(ph, views(a.set))
    pls = [c.placement if c else None for c in cands]
    e = errors(ids, ph, pls)
    once = scored_once(ph, cands)
    final, loop = sc.score(ph, cands)
    table(f"[{a.set}, {a.depth} depth] from_views, scored once (every candidate kept)", e, once)
    kept = ", ".join(f"{s}:{'—' if f.placement is None else f.confidence}" for s, f in zip(ids, final, strict=True))
    print("  after score() (unplacing below MIN_CONFIDENCE):", kept, "loop", loop)
    out = {"set": a.set, "depth": a.depth, **e, "confidence_once": [s.confidence for s in once], "residual_once": [s.residual_cm for s in once],
           "final": [None if f.placement is None else f.confidence for f in final], "loop_residual_cm": loop,
           "diag": [s.diag for s in once]}
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1, default=str))
    return out


def diagnose(a: argparse.Namespace) -> None:
    """Swap one ingredient of the MoGe calibration for the truth at a time, with the same MASt3R views."""
    ids = ids_of(a.set)
    vs = views(a.set)
    moge, exact = photos(ids, "moge"), photos(ids, "exact")
    tc = [truth(s)[1] for s in ids]

    def with_cam(ph: list[RoomPhoto], f: Any) -> list[RoomPhoto]:
        return [dataclasses.replace(p, camera=f(p.cam(), t)) for p, t in zip(ph, tc, strict=True)]

    variants = {
        "exact depth, true camera (the fixtures)": exact,
        "MoGe depth, MoGe camera (what runs)": moge,
        "MoGe depth, true pitch+roll": with_cam(moge, lambda c, t: Camera(c.fov_y, c.height, t.pitch, t.roll)),
        "MoGe depth, true height": with_cam(moge, lambda c, t: Camera(c.fov_y, t.height, c.pitch, c.roll)),
        "MoGe depth, true pitch+roll+height": with_cam(moge, lambda c, t: Camera(c.fov_y, t.height, t.pitch, t.roll)),
    }
    for name, ph in variants.items():
        cands = sv.from_views(ph, vs)
        pls = [c.placement if c else None for c in cands]
        table(name, errors(ids, ph, pls), scored_once(ph, cands))
        print("  scale_source:", [c.diag.get("scale_source") if c else None for c in cands], " scale_by_depth/scale:",
              [round(cast(float, c.diag["scale_by_depth"]) / c.placement.scale, 4) if c and c.diag.get("scale_by_depth") else None for c in cands])
    # scoring: the TRUE poses (in the frame's MoGe units, true per-member scales) on MoGe depth, with depth.png carried
    # at the placement's (floor) scale as Phase B did, then at its own depth scale (Candidate.depth_scale, the fix)
    cm = sv.from_views(moge, vs)
    h0, H0 = moge[0].cam().height, tc[0].height
    t0 = truth(ids[0])[0]
    for label, use_ds in (("floor scale (before)", False), ("depth.png's own scale (after)", True)):
        truth_c: list[sc.Candidate | None] = []
        for i, (p, t) in enumerate(zip(moge, tc, strict=True)):
            w = relative_to(truth(ids[i])[0], t0)
            k = h0 / H0
            c = cm[i]
            truth_c.append(sc.Candidate(Placement(w.x * k, w.z * k, w.yaw, (t.height / p.cam().height) * k),
                                        depth_scale=c.depth_scale if use_ds and c is not None else None))
        print(f"\nTRUE poses scored on MoGe depth, depth.png at the {label}:")
        for sid, s in zip(ids, scored_once(moge, truth_c), strict=True):
            print(f"  {sid:12} conf {s.confidence:.3f} res {s.residual_cm} overlap {s.diag.get('overlap')} constraint {s.diag.get('constraint')}")
    print("\nTRUE poses scored on exact depth:")
    tex: list[sc.Candidate | None] = [sc.Candidate(relative_to(truth(s)[0], t0)) for s in ids]
    for sid, s in zip(ids, scored_once(exact, tex), strict=True):
        print(f"  {sid:12} conf {s.confidence:.3f} res {s.residual_cm} overlap {s.diag.get('overlap')}")


def align(a: argparse.Namespace) -> None:
    from midstudy_calib.records import AlignRoomArgs
    from midstudy_calib.rooms.command import align_room

    os.environ.pop("MIDSTUDY_CALIB_MOCK", None)
    ids = ids_of(a.set)
    root = SCENES if a.depth == "exact" else OUT / "scenes"
    res = align_room(AlignRoomArgs([root / s for s in ids], OUT / f"align-{a.set}-{a.depth}", "mast3r", "auto"))
    ph = photos(ids, a.depth)
    pls: list[Placement | None] = []
    for m in res["members"]:
        p, s = m["pose"], m["scale"]
        pls.append(None if p is None or s is None else Placement(p["x_m"], p["z_m"], math.radians(p["yaw_deg"]), s))
    e = errors(ids, ph, pls)
    print(f"\nalign-room [{a.set}, {a.depth}]: best global scale {e['global_scale']} (H0/h0 {e['global_scale_true']}), loop {res['loop_residual_cm']}")
    for m, r in zip(res["members"], e["members"], strict=True):
        print(f"  {m['scene']:12} conf {m['confidence']:.3f} res {m['residual_cm']}  {r}")
    (OUT / f"align-{a.set}-{a.depth}.json").write_text(json.dumps({"align": res, "errors": e}, indent=1, default=str))


POS_CM, YAW_DEG, SCALE_PCT = 5.0, 1.5, 2.0  # the targets (calib/tests/test_align_room_golden.py)


def right(r: dict[str, Any]) -> bool:
    """Within target after Set scale (the best global scale; with one placed member that leaves its error across the
    line from the frame, `anchor_cm` is the error with a perfect Set scale in the frame's photo instead)."""
    return bool(r["placed"]) and r["pos_cm"] <= POS_CM and r["yaw_deg"] <= YAW_DEG and abs(r["scale_pct"]) <= SCALE_PCT


def evaluate(a: argparse.Namespace) -> None:
    """from_views and score() (what align-room does) on every set, against truth: confident-wrong must be 0."""
    tally = {"placed right": 0, "placed WRONG": 0, "unplaced, solver right": 0, "unplaced, solver wrong": 0}
    worst: list[str] = []
    rows_out = []
    for name in names(a.set):
        ids = ids_of(name)
        ph = photos(ids, a.depth)
        cands = sv.from_views(ph, views(name))
        final, loop = sc.score(ph, cands)
        e_all = errors(ids, ph, [c.placement if c else None for c in cands])  # every candidate, to judge the solver
        e_fin = errors(ids, ph, [f.placement for f in final])  # what align-room keeps (Set scale fitted to those)
        n_fin = sum(1 for f in final[1:] if f.placement is not None)
        for i in range(1, len(ids)):
            ra, rf = e_all["members"][i], e_fin["members"][i]
            for r, n in ((ra, sum(1 for c in cands[1:] if c is not None)), (rf, n_fin)):
                if r["placed"]:
                    r["pos_cm"] = r["scaled_cm"]
                    _ = n
            f = final[i]
            solver_right = right(ra)
            if f.placement is not None:
                k = "placed right" if right(rf) else "placed WRONG"
            else:
                k = "unplaced, solver right" if solver_right else "unplaced, solver wrong"
            tally[k] += 1
            d = f.diag
            line = (f"{name:42} {ids[i]:11} {k:23} pos {ra.get('pos_cm', '-'):>6} yaw {ra.get('yaw_deg', '-'):>6} scale% {ra.get('scale_pct', '-'):>6} "
                    f"conf {f.confidence if f.placement is not None else d.get('rejected_confidence', 0.0)} "
                    f"res {f.residual_cm if f.placement is not None else d.get('rejected_residual_cm')} "
                    f"ov {d.get('overlap')} cons {d.get('constraint')} tilt {d.get('tilt_deg')} solv {d.get('solver_confidence')}")
            rows_out.append({"set": name, "id": ids[i], "class": k, "all": ra, "final": rf, "diag": d})
            if a.verbose or k in ("placed WRONG", "unplaced, solver right"):
                print(line)
            if k == "placed WRONG":
                worst.append(line)
        _ = loop
    print(f"\n[{a.set}, {a.depth} depth] " + ", ".join(f"{k}: {v}" for k, v in tally.items()))
    if a.json:
        Path(a.json).write_text(json.dumps({"tally": tally, "rows": rows_out}, indent=1, default=str))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("calibrate")
    for n in ("solve", "analyze", "diagnose", "align", "evaluate"):
        p = sub.add_parser(n)
        p.add_argument("--set", default="room", help="a set (room, alt, or ids joined with +); solve and evaluate also take "
                       "groups (pairs, multi, sets, all) and comma-separated lists")
        if n in ("analyze", "align", "evaluate"):
            p.add_argument("--depth", default="moge", choices=["moge", "exact"])
        if n in ("analyze", "evaluate"):
            p.add_argument("--json")
        if n == "evaluate":
            p.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    {"calibrate": calibrate, "solve": solve, "analyze": analyze, "diagnose": diagnose, "align": align, "evaluate": evaluate}[a.cmd](a)


if __name__ == "__main__":
    main()
