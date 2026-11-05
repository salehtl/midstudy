"""Writes engine.mjs and lighting.mjs: v1's pure functions lifted verbatim from planner/engine.js and planner/lighting.js
(the differential tests' reference), around hand-written harnesses (*.template.mjs) that supply the state v1 keeps.

`/*@lift <file> <first>..<last>*/` in the template becomes the text of <file> from line <first> through the end of the
statement that starts at line <last> (braces matched), between `// <<v1 <file>:<a>-<b>` and `// v1>>` markers, which
v1-sync.mjs checks against planner/ while it exists. Run from the repo root: python3 core/crates/wasm-web/tests/v1/lift.py
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
FILES = {"engine": REPO / "planner/engine.js", "lighting": REPO / "planner/lighting.js"}


def statement_end(lines: list[str], start: int) -> int:
    depth, seen = 0, False
    for i in range(start, len(lines)):
        line = re.sub(r"'(?:[^'\\]|\\.)*'", "''", lines[i])  # quoted strings never hold braces here, but be safe
        for ch in line:
            if ch == "{":
                depth += 1
                seen = True
            elif ch == "}":
                depth -= 1
        if depth <= 0 and (seen or i == start):
            return i
    raise SystemExit(f"unbalanced braces from line {start + 1}")


def lift(m: re.Match) -> str:
    key, first, last = m.group(1), int(m.group(2)), int(m.group(3))
    lines = FILES[key].read_text().split("\n")
    end = statement_end(lines, last - 1)
    body = "\n".join(lines[first - 1 : end + 1])
    return f"// <<v1 planner/{FILES[key].name}:{first}-{end + 1}\n{body}\n// v1>>"


for template in sorted(HERE.glob("*.template.mjs")):
    target = HERE / template.name.replace(".template", "")
    target.write_text(re.sub(r"/\*@lift (\w+) (\d+)\.\.(\d+)\*/", lift, template.read_text()))
    print(f"wrote {target.relative_to(REPO)}")
