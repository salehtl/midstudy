"""A stand-in for midstudy-add in server/test/library/routes.test.ts: v1 and v2 servers run it on their own scratch
libraries, so their job messages, library.json and argument lists can be compared without fal or a real pipeline. It
writes library.json the way midstudy-add does (indent 2, UTF-8, floats as Python spells them: `80.0`), the item's
folder, a costs.csv row (MIDSTUDY_FAL_MOCK_COST=1 prices mock calls), and records its argument list in
<library>/<id>/raw/argv.json. An id's prefix picks a failure: fail- (a `midstudy-add:` stderr line among others),
noise- (stderr without one), quiet- (nothing at all, exit 2), nosummary- (exit 0 without the JSON line), listsummary-
and nullsummary- (a summary that isn't an object), slow- (a second's sleep first)."""
import csv
import json
import os
import sys
import time
from pathlib import Path

PRICE = {"idol": 0.10, "sam3d": 0.02, "trellis2": 0.25, "glb": 0.0, "rug": 0.0}


def main():
    opts, pos = {}, []
    for a in sys.argv[1:]:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            opts[k] = v
        else:
            pos.append(a)
    lib = Path(opts["library"])
    item_id = opts.get("rescale") or opts.get("id") or ""
    if item_id.startswith("slow-"):
        time.sleep(1)
    if item_id.startswith("fail-"):
        print("loading the engine", file=sys.stderr)
        print(f"midstudy-add: couldn't make {item_id}: the engine said no", file=sys.stderr)
        print("  (details below)", file=sys.stderr)
        sys.exit(1)
    if item_id.startswith("noise-"):
        print("Traceback (most recent call last):\nValueError: boom\n", file=sys.stderr)
        sys.exit(3)
    if item_id.startswith("quiet-"):
        sys.exit(2)
    if item_id.startswith("nosummary-"):
        print("working...")
        sys.exit(0)
    if item_id.startswith("listsummary-"):
        print("[1, 2]")
        sys.exit(0)
    if item_id.startswith("nullsummary-"):
        print("null")
        sys.exit(0)
    path = lib / "library.json"
    data = json.loads(path.read_text("utf-8")) if path.exists() else {"version": 1, "items": []}
    folder = lib / item_id
    (folder / "raw").mkdir(parents=True, exist_ok=True)
    argv = [Path(a).name if a == (pos[0] if pos else None) else a for a in sys.argv[1:]]
    argv = [("--library=LIB" if a.startswith("--library=") else a) for a in argv]
    (folder / "raw" / "argv.json").write_text(json.dumps(argv) + "\n")
    replaced = False
    if "rescale" in opts:
        item = next(i for i in data["items"] if i.get("id") == item_id)
        if "dims" in opts:
            w, d, h = (float(x) for x in opts["dims"].split("x"))
            item["dims_cm"] = {"w": w, "d": d, "h": h}
        if "yaw" in opts:
            item["notes"] = f"turned {opts['yaw']}"
        engine, cost = "rescale", 0.0
    else:
        engine = opts["engine"]
        w, d, h = (float(x) for x in opts["dims"].split("x"))
        cost = PRICE[engine] if os.environ.get("MIDSTUDY_FAL_MOCK_COST", "") not in ("", "0") else 0.0
        splat = engine in ("idol", "sam3d")
        item = {"id": item_id, "name": opts["name"], "category": opts.get("category"), "dims_cm": {"w": w, "d": d, "h": h},
                "assets": {"glb": f"{item_id}/model.glb", "splat": f"{item_id}/splat.ply" if splat else None,
                           "spz": f"{item_id}/splat.spz" if splat else None, "thumb": None},
                "default_render": "splat" if splat else "glb",
                "source": {"engine": engine, "input": opts.get("source-input", ""), "prompt": opts.get("prompt"), "cost_usd": cost,
                           "mock": True, "created": "2026-11-05T12:00:00Z"},
                "fit": {"glb_error_pct": {"w": 0.0, "d": 0.0, "h": 0.0}, "splat_error_pct": None}, "notes": None}
        if "mount" in opts:
            item["mount"] = opts["mount"]
        (folder / "model.glb").write_bytes(b"glTF" + b"\x00" * 16)
        if splat:
            (folder / "splat.ply").write_bytes(b"ply\n")
            (folder / "splat.spz").write_bytes(b"\x1f\x8b")
        replaced = any(i.get("id") == item_id for i in data["items"])
        data["items"] = [i for i in data["items"] if i.get("id") != item_id] + [item]
        if cost:
            costs = lib / "costs.csv"
            new = not costs.exists()
            with open(costs, "a", newline="", encoding="utf-8") as f:
                out = csv.writer(f)
                if new:
                    out.writerow(["date", "id", "engine", "cost_usd", "mock", "input"])
                out.writerow([time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), item_id, engine, f"{cost:.2f}", "true", opts.get("source-input", "")])
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", "utf-8")
    if replaced:
        print(f"midstudy-add: replaced existing item '{item_id}' in {path}")
    print(json.dumps({"id": item_id, "engine": engine, "cost_usd": cost, "mock": True}))


main()
