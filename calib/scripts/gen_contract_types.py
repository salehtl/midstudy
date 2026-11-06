"""calib's typed view of the contract's schemas: TypedDicts, and the schema copies the CLI validates against.

    uv run --project calib python calib/scripts/gen_contract_types.py [--check]

Reads contract/calib.schema.json, contract/lighting.schema.json and contract/calib-cli.schema.json (the stdout results
and the worker protocol, which the server checks too), and writes

- src/midstudy_calib/contract_types.py: one TypedDict per object schema (keys in `required` plain, the others
  NotRequired), Literal for const and enum, `X | None` for nullable types, list[...] for arrays, Mapping[str, object]
  for free-form objects. Schemas allow other keys where they say so (additionalProperties true); a TypedDict can't say
  that, so code that writes extra keys subclasses these types (types.py).
- src/midstudy_calib/schemas/{calib,lighting,calib-cli}.schema.json: byte copies of contract/, which validate.py loads
  at run time (the Nix package carries calib/src only).

--check writes nothing and exits 1 when a generated file differs from what is on disk (tests/test_contract_types.py).
The generator handles the subset of JSON Schema these files use; anything else is an error, not a silent `object`.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

CALIB = Path(__file__).resolve().parents[1]
REPO = CALIB.parent
PKG = CALIB / "src/midstudy_calib"
SCHEMAS = PKG / "schemas"
OUT = PKG / "contract_types.py"

type Json = dict[str, object]


@dataclass(frozen=True)
class Source:
    path: Path                      # where the schema is read from
    copy_to: Path | None            # contract/ schemas are copied into src/midstudy_calib/schemas/, for validate.py
    root: str | None                # the TypedDict for the whole document, or None (a file of $defs only)
    defs: dict[str, str | None]     # $defs name -> class or alias name; None: inlined where referenced, not emitted
    prefix: str                     # nested object properties become <prefix or parent><Property>


SOURCES = [
    Source(REPO / "contract/calib.schema.json", SCHEMAS / "calib.schema.json", "Calib", {"size": "ImageSize", "camera": "Camera"}, "Calib"),
    Source(REPO / "contract/lighting.schema.json", SCHEMAS / "lighting.schema.json", "Lighting", {"rgb": "Rgb", "unit": "UnitVector"}, "Lighting"),
    Source(REPO / "contract/calib-cli.schema.json", SCHEMAS / "calib-cli.schema.json", None,
           {"id": None, "error": "ErrorResult", "run": None, "ingest": "IngestResult", "light_done": "LightDone", "light_none": "LightNone",
            "light": "LightResult", "align": "AlignResult", "request": "WorkerRequest"}, ""),
]
PRIMITIVE = {"string": "str", "integer": "int", "number": "float", "boolean": "bool", "null": "None"}
KNOWN = {"$schema", "$id", "$ref", "$defs", "title", "description", "type", "required", "additionalProperties", "properties", "items",
         "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "const", "enum", "oneOf", "allOf"}


def _obj(v: object, where: str) -> Json:
    if not isinstance(v, dict):
        raise SystemExit(f"gen_contract_types: {where} isn't an object")
    return cast(Json, v)


def _pascal(name: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[_\-]", name) if p)


def _literal(values: list[object]) -> str:
    parts: list[str] = []
    none = False
    for v in values:
        if v is None:
            none = True
        elif isinstance(v, bool | int | str):
            parts.append(json.dumps(v) if isinstance(v, str) else repr(v))
        else:
            raise SystemExit(f"gen_contract_types: can't make a Literal of {v!r}")
    out = f"Literal[{', '.join(parts)}]" if parts else ""
    return f"{out} | None" if none and out else (out or "None")


def _comment(text: str, indent: str) -> list[str]:
    return [f"{indent}# {line}" for line in textwrap.wrap(" ".join(text.split()), 110 - len(indent))]


@dataclass
class Gen:
    docs: dict[str, Json] = field(default_factory=dict[str, Json])      # file name -> schema
    names: dict[tuple[str, str], str | None] = field(default_factory=dict[tuple[str, str], str | None])  # (file, def) -> name
    roots: dict[str, str | None] = field(default_factory=dict[str, str | None])
    blocks: list[str] = field(default_factory=list[str])
    emitted: set[str] = field(default_factory=set[str])

    def resolve(self, file: str, ref: str) -> tuple[str, Json, str | None]:
        """(file, schema, name) for a $ref seen in `file`: '#/$defs/x', 'other.schema.json' or 'other.schema.json#/$defs/x'."""
        target, _, frag = ref.partition("#")
        tfile = target or file
        if tfile not in self.docs:
            raise SystemExit(f"gen_contract_types: unknown $ref {ref!r} in {file}")
        doc = self.docs[tfile]
        if not frag:
            return tfile, doc, self.roots[tfile]
        m = re.fullmatch(r"/\$defs/([A-Za-z0-9_]+)", frag)
        if not m:
            raise SystemExit(f"gen_contract_types: unsupported $ref {ref!r} in {file}")
        defs = _obj(doc.get("$defs"), f"{tfile} $defs")
        return tfile, _obj(defs[m.group(1)], ref), self.names[(tfile, m.group(1))]

    def tx(self, file: str, s: Json, nested: str) -> str:
        """The Python type of schema `s`; `nested` names a class for an object with properties."""
        unknown = set(s) - KNOWN
        if unknown:
            raise SystemExit(f"gen_contract_types: unsupported keywords {sorted(unknown)} in {file} ({nested})")
        if "$ref" in s:
            tfile, target, name = self.resolve(file, str(s["$ref"]))
            return name if name else self.tx(tfile, target, nested)
        if "const" in s:
            return _literal([s["const"]])
        if "enum" in s:
            return _literal(cast(list[object], s["enum"]))
        if "oneOf" in s:
            subs = [self.tx(file, _obj(x, nested), nested) for x in cast(list[object], s["oneOf"])]
            nulls = [x for x in subs if x == "None"]
            return " | ".join([x for x in subs if x != "None"] + nulls[:1])
        if "allOf" in s:
            raise SystemExit(f"gen_contract_types: allOf in {file} ({nested}): map that $def to None")
        types = s.get("type")
        tl: list[object] = cast(list[object], types) if isinstance(types, list) else [types] if types is not None else []
        out: list[str] = []
        for t in tl:
            if t in PRIMITIVE:
                out.append(PRIMITIVE[cast(str, t)])
            elif t == "array":
                items = s.get("items")
                out.append(f"list[{self.tx(file, _obj(items, nested), nested + 'Item') if items is not None else 'object'}]")
            elif t == "object":
                out.append(self.typed_dict(file, s, nested) if "properties" in s else "Mapping[str, object]")
            else:
                raise SystemExit(f"gen_contract_types: unsupported type {t!r} in {file} ({nested})")
        if not out:
            if "properties" in s:  # an object schema without "type" (e.g. inside allOf)
                return self.typed_dict(file, s, nested)
            return "object"
        none = [x for x in out if x == "None"]
        return " | ".join([x for x in out if x != "None"] + none[:1])

    def typed_dict(self, file: str, s: Json, name: str) -> str:
        if name in self.emitted:
            return name
        self.emitted.add(name)
        props = _obj(s.get("properties"), f"{file} {name} properties")
        required = set(cast(list[str], s.get("required", [])))
        lines: list[str] = []
        for key, sub in props.items():
            sub_s = _obj(sub, f"{name}.{key}")
            t = self.tx(file, sub_s, name + _pascal(key))
            if not key.isidentifier():
                raise SystemExit(f"gen_contract_types: {name}.{key} isn't a Python identifier")
            if "description" in sub_s:
                lines += _comment(str(sub_s["description"]), "    ")
            lines.append(f"    {key}: {t if key in required else f'NotRequired[{t}]'}")
        # a schema's title is a name (f-contract titles the $defs), so the docstring is its description or where it is
        doc = textwrap.wrap(" ".join(str(s.get("description") or f"{name} in {file}.").split()), 112)
        if s.get("additionalProperties", True) is not False:
            doc += ["", "Open: the schema allows keys not listed here."]
        head = [f"class {name}(TypedDict):", '    """' + "\n    ".join(doc).replace("\n    \n", "\n\n") + '"""', ""]
        self.blocks.append("\n".join(head + lines))
        return name

    def alias(self, file: str, s: Json, name: str) -> None:
        t = self.tx(file, s, name)
        if t == name:  # an object $def: tx emitted the TypedDict under this name
            return
        doc = s.get("description")
        self.blocks.append("\n".join([*(_comment(str(doc), "") if doc else []), f"type {name} = {t}"]))
        self.emitted.add(name)


def generate() -> tuple[str, dict[Path, bytes]]:
    g = Gen()
    for src in SOURCES:
        doc = _obj(json.loads(src.path.read_text()), str(src.path))
        g.docs[src.path.name] = doc
        g.roots[src.path.name] = src.root
        defs = _obj(doc.get("$defs", {}), f"{src.path.name} $defs")
        missing = set(defs) - set(src.defs)
        if missing:
            raise SystemExit(f"gen_contract_types: name the $defs {sorted(missing)} of {src.path.name} in SOURCES")
        for d, name in src.defs.items():
            g.names[(src.path.name, d)] = name
    for src in SOURCES:
        doc = g.docs[src.path.name]
        defs = _obj(doc.get("$defs", {}), f"{src.path.name} $defs")
        for d, name in src.defs.items():
            if name is None:
                continue
            ds = _obj(defs[d], d)
            if ds.get("type") == "object" and "properties" in ds:
                g.typed_dict(src.path.name, ds, name)
            else:
                g.alias(src.path.name, ds, name)
        if src.root:
            g.typed_dict(src.path.name, doc, src.root)
    files = "\n".join(f"- {s.path.relative_to(REPO)}" for s in SOURCES)
    header = (f'"""Generated by calib/scripts/gen_contract_types.py from\n\n{files}\n\n'
              "Do not edit: change the schemas and run the script (tests/test_contract_types.py checks that this file is current).\n"
              '"""\n'
              # No `from __future__ import annotations`: evaluated annotations keep __required_keys__ and
              # __optional_keys__ right at run time (the tests compare them with the schemas).
              "from collections.abc import Mapping\nfrom typing import Literal, NotRequired, TypedDict\n")
    text = header + "\n\n" + "\n\n\n".join(g.blocks) + "\n"
    copies = {s.copy_to: s.path.read_bytes() for s in SOURCES if s.copy_to is not None}
    return text, copies


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="write nothing; exit 1 when a generated file is out of date")
    args = ap.parse_args()
    text, copies = generate()
    wanted = {OUT: text.encode(), **copies}
    stale = [p for p, data in wanted.items() if not p.is_file() or p.read_bytes() != data]
    if args.check:
        for p in stale:
            print(f"gen_contract_types: {p.relative_to(REPO)} is out of date: run calib/scripts/gen_contract_types.py", file=sys.stderr)
        return 1 if stale else 0
    for p in stale:
        p.write_bytes(wanted[p])
        print(f"gen_contract_types: wrote {p.relative_to(REPO)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
