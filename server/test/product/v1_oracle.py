"""v1's own product reader (planner/product_page.py), as an oracle for v2's differential tests.

Reads one JSON request per line on stdin and writes one JSON answer per line: {"op": ..., ...args} -> {"ok": value}
or {"raised": "<ExceptionName>"}. Ops mirror midstudy_product::api (`line_chains`, `parse_size_text`, `text_readings`,
`unit_hint`, `thickness`, `has_size`, `matches`, `category`, `num`, `unit`, `axis`, `fmt`, `quote_numbers`,
`llm_text`, `neutralize`, `items`) plus whole-page ones the TypeScript reader is compared on (`unescape`, `squash`,
`loads`, `text_lines`, `page`, `extract_pasted`). Nothing here fetches, reads .env or calls fal.
Run with the dev shell's Python: python3 -I server/test/product/v1_oracle.py
"""
import importlib.util
import json
import math
import pathlib
import sys

sys.dont_write_bytecode = True
REPO = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("v1_product_page", REPO / "planner" / "product_page.py")
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


def ctx_of(c):
    return pp._Ctx(bool(c.get("is_rug")), c.get("hint"), [], bool(c.get("is_bed")))


def reading(r):
    if r is None:
        return None
    return {"w": r.w, "d": r.d, "h": r.h, "unit": r.unit, "label": r.label, "unit_note": r.unit_note,
            "notes": list(r.notes), "quote": r.quote, "source": r.source}


def item(it):
    return {"start": it.start, "end": it.end, "value": it.value, "unit": it.unit, "axis": it.axis,
            "num_text": it.num_text, "to": it.to}


def jsonable(v):
    if isinstance(v, float) and not math.isfinite(v):
        return repr(v)
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    return v


def run(req):
    op = req["op"]
    if op == "line_chains":
        return [[item(it) for it in ch] for ch in pp._line_chains(req["text"])]
    if op == "items":
        return [item(it) for it in pp._items(req["text"])]
    if op == "parse_size_text":
        ctx = ctx_of(req["ctx"])
        r = pp._parse_size_text(req["text"], ctx, source=req["source"], label=req.get("label"),
                                pair_ok=req["pair_ok"], warn_unitless=req["warn_unitless"])
        return {"reading": reading(r), "dropped_unitless": ctx.unitless_dropped}
    if op == "make_reading":
        ctx = ctx_of(req["ctx"])
        parts = [(p["axis"], p["value"], p["unit"], p["text"]) + ((p["to"],) if p.get("to") is not None else ())
                 for p in req["parts"]]
        r = pp._make_reading(parts, ctx, source=req["source"], quote=req["quote"], label=req.get("label"),
                             pair_ok=req["pair_ok"], warn_unitless=req["warn_unitless"])
        return {"reading": reading(r), "dropped_unitless": ctx.unitless_dropped}
    if op == "text_readings":
        return [reading(r) for r in pp._text_readings(req["lines"], ctx_of(req["ctx"]))]
    if op == "unit_hint":
        return pp._unit_hint(req["lines"])
    if op == "thickness":
        th = pp._thickness(req["lines"], req.get("hint"))
        return None if th is None else [th[0], "thickness from the page: " + pp.re.sub(r"\s+", " ", th[1])[:60]]
    if op == "has_size":
        return bool(pp._HAS_SIZE.search(req["text"]))
    if op == "matches":
        rx = {"distract": pp._DISTRACT, "intro": pp._INTRO, "sample": pp._SAMPLE, "size_opt": pp._SIZE_OPT,
              "size_words": pp._SIZE_WORDS, "robot": pp._ROBOT}[req["kind"]]
        return bool(rx.search(req["text"]))
    if op == "category":
        return pp._category_of(req["text"])
    if op == "num":
        return pp._num(req["text"])
    if op == "unit":
        return pp._unit(req["text"])
    if op == "axis":
        return pp._axis(req["text"])
    if op == "fmt":
        return pp._fmt(req["value"])
    if op == "quote_numbers":
        return pp._quote_numbers(req["text"])
    if op == "llm_text":
        return pp._llm_text(req["lines"])
    if op == "neutralize":
        return pp._neutralize(req["text"])
    if op == "round1":
        return round(req["value"] + 1e-9, 1)
    if op == "unescape":
        return pp.html.unescape(req["text"])
    if op == "squash":
        return pp._squash(req["text"])
    raise ValueError(f"unknown op {op}")


for line in sys.stdin:
    if not line.strip():
        continue
    try:
        out = {"ok": jsonable(run(json.loads(line)))}
    except Exception as e:  # noqa: BLE001 - the oracle reports what v1 raised
        out = {"raised": type(e).__name__, "message": str(e)[:300]}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
