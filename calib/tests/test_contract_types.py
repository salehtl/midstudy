"""contract_types.py and the schema copies are current (calib/scripts/gen_contract_types.py --check), the TypedDicts
say what the schemas say, and the validation the CLI relies on catches what the types can't."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import cast, is_typeddict

import pytest
from synthetic import REPO, jget, jlist, load_json

from midstudy_calib import contract_types as ct
from midstudy_calib import validate

CALIB = REPO / "calib"
SCHEMAS = CALIB / "src/midstudy_calib/schemas"


def test_generated_files_are_current() -> None:
    p = subprocess.run([sys.executable, str(CALIB / "scripts/gen_contract_types.py"), "--check"], capture_output=True, text=True, check=False)
    assert p.returncode == 0, p.stderr


@pytest.mark.parametrize("name", ["calib.schema.json", "lighting.schema.json"])
def test_schema_copies_are_the_contract(name: str) -> None:
    assert (SCHEMAS / name).read_bytes() == (REPO / "contract" / name).read_bytes()


def _keys(node: object) -> tuple[set[str], set[str]]:
    """(required, all) property names of an object schema."""
    assert isinstance(node, dict)
    d = cast(dict[str, object], node)
    props = d["properties"]
    assert isinstance(props, dict)
    req: list[object] = jlist(d, "required") if "required" in d else []
    return {str(k) for k in req}, {str(k) for k in cast(dict[str, object], props)}


@pytest.mark.parametrize(("cls", "file", "path"), [
    (ct.Calib, "contract/calib.schema.json", ()),
    (ct.Camera, "contract/calib.schema.json", ("$defs", "camera")),
    (ct.ImageSize, "contract/calib.schema.json", ("$defs", "size")),
    (ct.CalibFloor, "contract/calib.schema.json", ("properties", "floor")),
    (ct.CalibExif, "contract/calib.schema.json", ("properties", "exif", "oneOf", "1")),
    (ct.CalibDepth, "contract/calib.schema.json", ("properties", "depth", "oneOf", "1")),
    (ct.Lighting, "contract/lighting.schema.json", ()),
    (ct.LightingKey, "contract/lighting.schema.json", ("properties", "key")),
    (ct.LightingWhiteBalance, "contract/lighting.schema.json", ("properties", "white_balance")),
    (ct.ErrorResult, "contract/calib-cli.schema.json", ("$defs", "error")),
    (ct.IngestResult, "contract/calib-cli.schema.json", ("$defs", "ingest")),
    (ct.LightDone, "contract/calib-cli.schema.json", ("$defs", "light_done")),
    (ct.AlignResult, "contract/calib-cli.schema.json", ("$defs", "align")),
    (ct.WorkerRequest, "contract/calib-cli.schema.json", ("$defs", "request")),
])
def test_typed_dicts_have_the_schemas_keys(cls: type, file: str, path: tuple[str, ...]) -> None:
    schema = load_json(REPO / file)
    node: object = schema
    for k in path:
        node = jget(node, int(k)) if k.isdigit() else jget(node, k)
    required, every = _keys(node)
    assert is_typeddict(cls)
    req_keys = cast(frozenset[str], getattr(cls, "__required_keys__"))  # noqa: B009 - TypedDict's runtime attributes
    opt_keys = cast(frozenset[str], getattr(cls, "__optional_keys__"))  # noqa: B009
    assert set(req_keys) == required
    assert set(req_keys) | set(opt_keys) == every


@pytest.mark.parametrize("sid", ["living-wide", "steep-roll", "portrait", "living-cool", "living-warm"])
def test_golden_files_validate(sid: str) -> None:
    d = REPO / "fixtures/scenes" / sid
    assert validate.problems("calib", load_json(d / "calib.json")) == []
    assert validate.problems("lighting", load_json(d / "lighting.json")) == []


def test_validation_catches_what_the_types_cannot(tmp_path: Path) -> None:
    loaded = load_json(REPO / "fixtures/scenes/living-wide/calib.json")
    assert isinstance(loaded, dict)
    calib = cast(dict[str, object], loaded)
    bad = dict(calib)
    bad["camera"] = {"fov_y_deg": 130, "height_m": 1.4, "pitch_deg": -10, "roll_deg": 0}
    found = validate.problems("calib", bad)
    assert found and found[0].startswith("camera/fov_y_deg: 130 is greater than the maximum of 110"), found
    with pytest.raises(validate.ContractViolation, match=r"calib\.json doesn't match calib\.schema\.json: camera/fov_y_deg"):
        validate.require("calib", bad, "calib.json")
    # the stdout line of run/fit needs ok; one-shot results never carry an id, worker responses may
    assert validate.problems("run", calib) == ["(root): 'ok' is a required property"]
    assert validate.problems("run", {**calib, "ok": True, "id": "c-1"}) == []
    light = {"ok": True, "lighting": True, "cct_k": 5000, "confidence": 1.5, "elapsed_s": 1}
    assert validate.problems("light", light)[0] == "confidence: 1.5 is greater than the maximum of 1"
    assert validate.problems("error", {"ok": False, "error": ""}) == ["error: '' should be non-empty"]
    assert validate.problems("request", {"id": "a", "cmd": "fit", "args": ["x"], "extra": 1})
