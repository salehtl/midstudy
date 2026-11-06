"""Summarise bench.sh's answers: per (set, solver) the worse of its runs (docs/notes/rooms-calib.md).

    python3 calib/spike/table.py OUT_DIR [--members] [--min-conf X]

--min-conf X re-reads each answer as if run.py's MIN_CONFIDENCE were X (members under it count as unplaced), from the
per-member truth rows. off_target = placed members outside a Phase A target (5 cm, 1.5 deg, 2 %), any confidence;
confident_wrong = placed members off by more than twice a target with confidence >= 0.5 (run.py's definition).
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path
from typing import Any

TARGET = (5.0, 1.5, 2.0)
KEYS = ["pos_err_cm_median", "pos_err_cm_max", "yaw_err_deg_median", "yaw_err_deg_max", "scale_err_pct_max",
        "unplaced", "confident_wrong", "off_target"]


def worse(a: Any, b: Any) -> Any:
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def rethreshold(t: dict[str, Any], min_conf: float | None) -> dict[str, Any]:
    pos: list[float] = []
    yaw: list[float] = []
    scl: list[float] = []
    unplaced = cw = off = 0
    for m in t["members"]:
        if m.get("unplaced") or (min_conf is not None and m["confidence"] < min_conf):
            unplaced += 1
            continue
        e = (m["pos_err_cm"], m["yaw_err_deg"], m["scale_err_pct"])
        pos.append(e[0])
        yaw.append(e[1])
        scl.append(e[2])
        if any(x > lim for x, lim in zip(e, TARGET, strict=True)):
            off += 1
        if any(x > 2 * lim for x, lim in zip(e, TARGET, strict=True)) and m["confidence"] >= 0.5:
            cw += 1
    med = statistics.median
    return {"pos_err_cm_median": round(med(pos), 2), "pos_err_cm_max": round(max(pos), 2),
            "yaw_err_deg_median": round(med(yaw), 3), "yaw_err_deg_max": round(max(yaw), 3),
            "scale_err_pct_max": round(max(scl), 2), "unplaced": unplaced, "confident_wrong": cw, "off_target": off,
            "members": t["members"]}


def main() -> int:
    out = Path(sys.argv[1])
    min_conf = float(sys.argv[sys.argv.index("--min-conf") + 1]) if "--min-conf" in sys.argv else None
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for f in sorted(out.glob("*.json")):
        set_, solver, _tag = f.stem.rsplit("-", 2)
        r = json.loads(f.read_text())
        t = rethreshold(r["truth"], min_conf)
        row = rows.setdefault((set_, solver), {"runs": 0})
        row["runs"] += 1
        for k in KEYS:
            row[k] = worse(row.get(k), t[k])
        row["cold_s"] = worse(row.get("cold_s"), r["timing"]["cold_s"])
        row["warm_s"] = worse(row.get("warm_s"), r["timing"]["warm_s"])
        row["peak_mem_gb"] = worse(row.get("peak_mem_gb"), r["memory"]["peak_mem_gb"])
        row["loop_cm"] = worse(row.get("loop_cm"), r["loop_residual_cm"])
        if "--members" in sys.argv:
            ms = {m["scene"]: m for m in r["members"]}
            for m in t["members"]:
                c = ms[m["scene"]]
                print(f"{f.stem:32} {m['scene']:12} " + (
                    "UNPLACED" if m.get("unplaced") else
                    f"pos {m['pos_err_cm']:7.2f} cm  yaw {m['yaw_err_deg']:7.3f}  scale {m['scale_err_pct']:6.2f} %")
                    + f"  conf {c['confidence']}  res {c['residual_cm']}  rejected {c.get('rejected_pose')}")
    cols = ["runs", *KEYS, "loop_cm", "cold_s", "warm_s", "peak_mem_gb"]
    print("| set | solver | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 2) + "|")
    for (set_, solver), row in sorted(rows.items()):
        print(f"| {set_} | {solver} | " + " | ".join(str(row.get(c)) for c in cols) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
