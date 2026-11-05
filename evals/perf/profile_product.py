"""E17 --profile helper: cProfile of v1's product page reader (planner/product_page.py) on given pages, in-process.

The server reads a page in a handler thread, which cProfile can't see, so this loads planner/serve.py the way the server
does (its address rules, pinned connections and fal helpers configured) and calls product_page.read(url, llm=False) in
the main thread: once to warm up (imports, compiled regexes), then once under the profiler.

Usage: python3 evals/perf/profile_product.py <repo> <pages base URL> <out dir> <path> [<path> ...]
Needs MIDSTUDY_FETCH_ALLOW=127.0.0.1:<pages port>, MIDSTUDY_NO_DOTENV=1 and MIDSTUDY_FAL_MOCK (perf.mjs sets them).
Prints one JSON object: {path: {status, wall_ms, total_ms, top: [{fn, self_ms, pct, calls}]}}.
"""

import cProfile
import importlib.util
import json
import pstats
import sys
import time
from pathlib import Path


def main() -> None:
    repo, base, out = Path(sys.argv[1]), sys.argv[2].rstrip("/"), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("midstudy_serve", repo / "planner" / "serve.py")
    serve = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(serve)
    reader = serve.product_page
    result = {}
    for p in sys.argv[4:]:
        url = base + p
        reader.read(url, llm=False)
        prof = cProfile.Profile()
        t0 = time.perf_counter()
        prof.enable()
        status, _body = reader.read(url, llm=False)
        prof.disable()
        wall = time.perf_counter() - t0
        st = pstats.Stats(prof)
        st.dump_stats(str(out / f"product{p.replace('/', '_')}.pstats"))
        tot = st.total_tt or 1e-9
        rows = sorted(st.stats.items(), key=lambda kv: -kv[1][2])[:15]
        result[p] = {
            "status": status,
            "wall_ms": round(wall * 1000, 1),
            "total_ms": round(tot * 1000, 1),
            "top": [{"fn": f"{fn[2]} {Path(fn[0]).name}:{fn[1]}", "self_ms": round(v[2] * 1000, 1), "pct": round(100 * v[2] / tot, 1), "calls": v[1]}
                    for fn, v in rows],
        }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
