"""Every JSON object midstudy-calib writes is checked against its schema first: calib.json, lighting.json, the stdout
result and the worker's responses. One that doesn't match is a bug in midstudy-calib: it is not written, and the
command fails with the contract's error output instead (contract §4.3).

The schemas are the copies in schemas/ of contract/'s calib.schema.json, lighting.schema.json and calib-cli.schema.json
(written by scripts/gen_contract_types.py; the server checks calib's results against the same calib-cli.schema.json),
so the Nix package, which carries src/ only, validates exactly as the repo does.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from functools import cache
from importlib import resources
from typing import Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012, Schema, SchemaRegistry

FILES = ("calib.schema.json", "lighting.schema.json", "calib-cli.schema.json")
BASE = "midstudy/"  # every schema's $id is midstudy/<file>

# What can be checked: a whole file's schema, or one of calib-cli.schema.json's $defs.
type Target = Literal["calib", "lighting", "run", "ingest", "light", "align", "error", "request"]
CLI = f"{BASE}calib-cli.schema.json#/$defs/"
REFS: dict[Target, str] = {
    "calib": f"{BASE}calib.schema.json", "lighting": f"{BASE}lighting.schema.json", "run": f"{CLI}run", "ingest": f"{CLI}ingest",
    "light": f"{CLI}light", "align": f"{CLI}align", "error": f"{CLI}error", "request": f"{CLI}request",
}


class ContractViolation(Exception):
    """What midstudy-calib was about to write or answer doesn't match its schema: a bug in midstudy-calib."""


@cache
def _registry() -> SchemaRegistry:
    reg: SchemaRegistry = Registry()
    for name in FILES:
        text = resources.files("midstudy_calib").joinpath("schemas", name).read_text(encoding="utf-8")
        contents: Schema = json.loads(text)
        reg = reg.with_resource(f"{BASE}{name}", Resource[Schema].from_contents(contents, default_specification=DRAFT202012))
    return reg


@cache
def _validator(target: Target) -> Draft202012Validator:
    return Draft202012Validator({"$ref": REFS[target]}, registry=_registry())


def problems(target: Target, obj: object) -> list[str]:
    """Every way `obj` breaks the schema as "<json path>: <message>", the most relevant first; [] when it is valid."""
    # jsonschema's stub types the instance as JSON values and leaves an overload untyped; any object can be checked
    errs: list[ValidationError] = list(_validator(target).iter_errors(obj))  # pyright: ignore[reportUnknownMemberType, reportArgumentType]
    # The deepest complaint first, looking inside oneOf branches too: "confidence: 1.5 is greater than the maximum
    # of 1" says more than "... is not valid under any of the given schemas".
    leaves = sorted((leaf for e in errs for leaf in _leaves(e)), key=lambda e: -len(e.absolute_path))
    out = [_fmt(leaves[0])] if leaves else []
    return out + [m for m in map(_fmt, errs) if m not in out]


def _leaves(e: ValidationError) -> Iterator[ValidationError]:
    if e.context:
        for c in e.context:
            yield from _leaves(c)
    else:
        yield e


def _fmt(e: ValidationError) -> str:
    return f"{'/'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}"


def require(target: Target, obj: object, what: str) -> None:
    """Raise ContractViolation when `obj` (described as `what`, e.g. "calib.json") doesn't match its schema."""
    found = problems(target, obj)
    if found:
        more = f" (and {len(found) - 1} more)" if len(found) > 1 else ""
        raise ContractViolation(f"{what} doesn't match {REFS[target].removeprefix(BASE)}: {found[0][:300]}{more}")
