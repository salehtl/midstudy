#!/usr/bin/env bash
# Pipeline eval: runs midstudy-add against recorded fal responses (MIDSTUDY_FAL_MOCK), so it costs $0.
# Checks contract/CONTRACT.md §3. Output lands in evals/out/pipeline/.
# v4: OBJ zips, --rescale, --mount, MIDSTUDY_FAL_MOCK_COST (§3.1).
# Usage: bash evals/pipeline_offline.sh   (or npm run eval:pipeline)
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/pipeline
LIB="$OUT/library"
rm -rf "$OUT" && mkdir -p "$OUT"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8').trim().split('\n').pop()); process.stdout.write(String($1))"; }
lastline() { tail -n 1 "$1" 2>/dev/null; }

[ -f pipeline/pyproject.toml ] || { echo "FAIL pipeline/pyproject.toml not found (pipeline not built yet)"; exit 1; }
for slug in sam-3-3d-objects trellis-2; do
  [ -f "fixtures/fal/$slug/response.json" ] || { echo "FAIL fixtures/fal/$slug/response.json missing (run the Phase 0 capture)"; exit 1; }
done
IMG=$(ls fixtures/fal/sam-3-3d-objects/input.* 2>/dev/null | head -n 1)
[ -n "$IMG" ] || { echo "FAIL no fixtures/fal/sam-3-3d-objects/input.* image"; exit 1; }

# Sync once with network, then run every CLI call offline with proxies pointed at a dead port:
# any network request the CLI makes fails loudly instead of silently costing money (L6).
uv sync -q --project pipeline || { echo "FAIL uv sync --project pipeline"; exit 1; }
add() {
  env -u FAL_KEY MIDSTUDY_NO_DOTENV=1 NOOK_NO_DOTENV=1 MIDSTUDY_FAL_MOCK=fixtures/fal \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= \
    uv run -q --offline --project pipeline midstudy-add "$@"
}
run() { local name=$1; shift; add "$@" >"$OUT/$name.out" 2>"$OUT/$name.err"; }

# --- engines (mocked) -------------------------------------------------------
if run sam "$IMG" --engine sam3d --prompt chair --name "Mock SAM Chair" --id mock-sam --dims 75x80x95 --library "$LIB"; then
  ok "sam3d run succeeds"
  check "sam3d summary: id/engine/mock/cost" '[ "$(lastline $OUT/sam.out | json "o.id+\"|\"+o.engine+\"|\"+o.mock+\"|\"+o.cost_usd")" = "mock-sam|sam3d|true|0" ]' "$(lastline $OUT/sam.out)"
  check "sam3d writes model.glb, splat.ply, thumb.jpg" '[ -f $LIB/mock-sam/model.glb ] && [ -f $LIB/mock-sam/splat.ply ] && [ -f $LIB/mock-sam/thumb.jpg ]'
else
  bad "sam3d run succeeds — $(tail -n 3 "$OUT/sam.err" | tr '\n' ' ')"
fi

# verify round 1: the photo an engine uploads to fal carries no camera metadata (EXIF, GPS, XMP, comments) and is
# upright; source.<ext> keeps the upload as given (never served). A JPEG with GPS + orientation 6, and a PNG with eXIf/tEXt.
evals/py evals/lib/metadata.py make --kind gps-jpeg --orientation 6 --from "$IMG" --out "$OUT/gps.jpg" >"$OUT/gps-make.json" 2>&1
evals/py evals/lib/metadata.py make --kind gps-png --from "$IMG" --out "$OUT/gps.png" >/dev/null 2>&1
if run gpsjpg "$OUT/gps.jpg" --engine sam3d --name "GPS Chair" --id gps-chair --dims 75x80x95 --library "$LIB" && run gpspng "$OUT/gps.png" --engine trellis2 --name "GPS Png" --id gps-png --dims 75x80x95 --library "$LIB"; then
  evals/py evals/lib/metadata.py inspect "$LIB/gps-chair/raw/engine-input.jpg" >"$OUT/gps-sent.json" 2>&1
  evals/py evals/lib/metadata.py inspect "$LIB/gps-png/raw/engine-input.jpg" >"$OUT/gps-png-sent.json" 2>&1
  check "a GPS-tagged JPEG (orientation 6): the engine input has no metadata, is upright, and is what was uploaded" 'node -e "
const m=JSON.parse(require(\"fs\").readFileSync(\"$OUT/gps-make.json\",\"utf8\").trim().split(\"\\n\").pop()), s=JSON.parse(require(\"fs\").readFileSync(\"$OUT/gps-sent.json\",\"utf8\").trim().split(\"\\n\").pop());
process.exit(s.clean && s.w===m.h && s.h===m.w ? 0 : 1)" && grep -q "uploads/engine-input.jpg" "$LIB/gps-chair/raw/request.json" && cmp -s "$OUT/gps.jpg" "$LIB/gps-chair/source.jpg"' "$(tail -n 1 "$OUT/gps-sent.json" | head -c 300)"
  check "a PNG with eXIf and tEXt: the engine input has none of it" 'grep -q "\"clean\": true" "$OUT/gps-png-sent.json"' "$(tail -n 1 "$OUT/gps-png-sent.json" | head -c 300)"
else
  bad "midstudy-add runs on photos with GPS — $(tail -n 2 "$OUT/gpsjpg.err" "$OUT/gpspng.err" 2>/dev/null | tr '\n' ' ')"
fi

# verify round 2: a user's own GLB can embed a geotagged photo as a texture; model.glb is served, so its textures lose
# their EXIF/GPS (APP1-15, COM, JFXX; PNG eXIf/tEXt), the image data kept as it is. source.glb keeps the upload.
evals/py evals/lib/metadata.py make --kind gps-glb --out "$OUT/gps-texture.glb" >"$OUT/gps-glb-make.json" 2>&1
if run gpsglb "$OUT/gps-texture.glb" --engine glb --name "GPS Texture" --id gps-texture --dims 50x50x50 --library "$LIB"; then
  evals/py evals/lib/metadata.py inspect "$LIB/gps-texture/model.glb" >"$OUT/gps-glb-served.json" 2>&1
  check "a GLB whose texture is a JPEG with EXIF/GPS: model.glb's texture carries none of it (and still decodes)" 'grep -q "\"canary\": true" "$OUT/gps-glb-make.json" && node -e "
const s=JSON.parse(require(\"fs\").readFileSync(\"$OUT/gps-glb-served.json\",\"utf8\").trim().split(\"\\n\").pop());
process.exit(s.clean && s.glb_images.length===1 && s.glb_images[0].w===64 && !s.glb_images[0].error ? 0 : 1)" && cmp -s "$OUT/gps-texture.glb" "$LIB/gps-texture/source.glb"' "$(tail -n 1 "$OUT/gps-glb-served.json" | head -c 300)"
  check "…and the item still validates (bounds, dims)" 'evals/py evals/validate_library.py "$LIB/library.json" 2>&1 | grep -q "ok   gps-texture"'
else
  bad "midstudy-add runs on a GLB with a GPS texture — $(tail -n 2 "$OUT/gpsglb.err" | tr '\n' ' ')"
fi

if run trellis "$IMG" --engine trellis2 --name "Mock Trellis Chair" --id mock-trellis --dims "75 × 60.5 × 80" --library "$LIB"; then
  ok "trellis2 run succeeds (dims with spaces, ×, decimals)"
  check "trellis2 writes model.glb and no splat" '[ -f $LIB/mock-trellis/model.glb ] && [ ! -f $LIB/mock-trellis/splat.ply ]'
else
  bad "trellis2 run succeeds — $(tail -n 3 "$OUT/trellis.err" | tr '\n' ' ')"
fi

# --- glb engine: textures (L5), yaw (L7), upsert (L3) ------------------------
if run sheen fixtures/models/SheenChair.glb --engine glb --name "Sheen" --id sheen --dims 60x65x85 --category chair --library "$LIB"; then
  ok "glb run succeeds"
  imgs=$(evals/py evals/glb_info.py "$LIB/sheen/model.glb" | json "o.images")
  check "glb textures survive normalization" '[ "$imgs" = "7" ]' "images=$imgs (source has 7)"
else
  bad "glb run succeeds — $(tail -n 3 "$OUT/sheen.err" | tr '\n' ' ')"
fi

run arrow0 fixtures/models/arrow.glb --engine glb --name "Arrow 0" --id arrow-0 --dims 100x40x30 --library "$LIB" \
  && run arrow90 fixtures/models/arrow.glb --engine glb --name "Arrow 90" --id arrow-90 --dims 40x100x30 --yaw 90 --library "$LIB"
if [ $? -eq 0 ]; then
  c0=$(evals/py evals/glb_info.py "$LIB/arrow-0/model.glb" | json "o.centroid.map(v=>v.toFixed(3)).join(' ')")
  c90=$(evals/py evals/glb_info.py "$LIB/arrow-90/model.glb" | json "o.centroid.map(v=>v.toFixed(3)).join(' ')")
  check "yaw 0 keeps the arrow tip toward +X" 'node -e "const [x,,z]=\"$c0\".split(\" \").map(Number); process.exit(x>0.05&&Math.abs(z)<0.02?0:1)"' "centroid $c0"
  check "yaw 90 turns +X into -Z" 'node -e "const [x,,z]=\"$c90\".split(\" \").map(Number); process.exit(z<-0.05&&Math.abs(x)<0.02?0:1)"' "centroid $c90"
else
  bad "arrow glb runs succeed — $(tail -n 2 "$OUT/arrow0.err" "$OUT/arrow90.err" | tr '\n' ' ')"
fi

if run sheen2 fixtures/models/SheenChair.glb --engine glb --name "Sheen" --id sheen --dims 62x65x85 --library "$LIB"; then
  n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LIB/library.json','utf8')).items.filter(i=>i.id==='sheen').length)")
  check "upsert leaves exactly one entry" '[ "$n" = "1" ]' "count=$n"
  check "upsert is reported" 'grep -qi "replac" "$OUT/sheen2.out" "$OUT/sheen2.err"'
  w=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LIB/library.json','utf8')).items.find(i=>i.id==='sheen').dims_cm.w)")
  check "upsert stores the new dims" '[ "$w" = "62" ]' "w=$w"
else
  bad "glb re-run (upsert) succeeds — $(tail -n 3 "$OUT/sheen2.err" | tr '\n' ' ')"
fi

# --- bad input (L4): non-zero exit, one actionable line, no traceback, library untouched --------
sum_before=$(shasum "$LIB/library.json" 2>/dev/null)
rows_before=$(wc -l <"$LIB/costs.csv" 2>/dev/null)
: >"$OUT/model.usdz"
bad_case() {
  local name=$1; shift
  if run "$name" "$@"; then bad "$name is rejected"; return; fi
  if grep -q "Traceback" "$OUT/$name.err"; then bad "$name: no traceback — $(tail -n 1 "$OUT/$name.err")"; return; fi
  if [ -z "$(tail -n 1 "$OUT/$name.err")" ]; then bad "$name: explains itself on stderr"; return; fi
  ok "$name is rejected: $(tail -n 1 "$OUT/$name.err")"
}
bad_case no-dims        "$IMG" --name "X" --library "$LIB"
bad_case bad-dims       "$IMG" --name "X" --dims 75by80 --library "$LIB"
bad_case zero-dims      "$IMG" --name "X" --dims 0x80x90 --library "$LIB"
bad_case bad-engine     "$IMG" --name "X" --dims 75x80x95 --engine foo --library "$LIB"
bad_case missing-file   "$OUT/nope.jpg" --name "X" --dims 75x80x95 --library "$LIB"
bad_case usdz           "$OUT/model.usdz" --engine glb --name "X" --dims 75x80x95 --library "$LIB"
# Outside mock mode with no key: must fail before any network call.
if env -u FAL_KEY -u MIDSTUDY_FAL_MOCK MIDSTUDY_NO_DOTENV=1 NOOK_NO_DOTENV=1 HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
    uv run -q --offline --project pipeline midstudy-add "$IMG" --name "X" --dims 75x80x95 --library "$LIB" >"$OUT/no-key.out" 2>"$OUT/no-key.err"; then
  bad "missing FAL_KEY is rejected"
else
  check "missing FAL_KEY is rejected with a FAL_KEY hint" 'tail -n 1 "$OUT/no-key.err" | grep -q FAL_KEY && ! grep -q Traceback "$OUT/no-key.err"' "$(tail -n 1 "$OUT/no-key.err")"
fi
check "bad input leaves library.json untouched" '[ "$(shasum "$LIB/library.json" 2>/dev/null)" = "$sum_before" ]'
check "bad input adds no cost rows" '[ "$(wc -l <"$LIB/costs.csv" 2>/dev/null)" = "$rows_before" ]'

# --- v4 (§3.1): OBJ zips, --rescale, --mount, mock cost -----------------------------------------------------------
if run cube fixtures/models/cube-obj.zip --engine glb --name "Cube" --id cube --dims 50x50x50 --mount wall --library "$LIB"; then
  ok "an OBJ zip (.obj + .mtl + texture) is accepted by --engine glb"
  imgs=$(evals/py evals/glb_info.py "$LIB/cube/model.glb" | json "o.images")
  check "the OBJ's texture survives into the GLB" '[ "$imgs" -ge 1 ]' "images=$imgs"
  check "--mount wall is stored on the item" '[ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"$LIB/library.json\",\"utf8\")).items.find(i=>i.id===\"cube\").mount)")" = wall ]'
else
  bad "an OBJ zip is accepted by --engine glb — $(tail -n 2 "$OUT/cube.err" | tr '\n' ' ')"
fi
for evil in slip abs exe; do
  python3 - "$OUT/evil-$evil.zip" "$evil" <<'PY'
import sys, zipfile
src = zipfile.ZipFile("fixtures/models/cube-obj.zip")
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for n in src.namelist(): z.writestr(n, src.read(n))
    z.writestr({"slip": "../../escaped.txt", "abs": "/tmp/midstudy-escaped.txt", "exe": "cube/run.exe"}[sys.argv[2]], "x")
PY
  bad_case "zip-$evil" "$OUT/evil-$evil.zip" --engine glb --name "Evil" --id "evil-$evil" --dims 50x50x50 --library "$LIB"
done
check "a zip never writes outside the library" '[ ! -e "$OUT/../escaped.txt" ] && [ ! -e evals/escaped.txt ] && [ ! -e /tmp/midstudy-escaped.txt ]'

rows_before=$(wc -l <"$LIB/costs.csv")
if run rescale --rescale sheen --dims 70x65x85 --library "$LIB"; then
  ok "--rescale refits an existing item"
  sz=$(evals/py evals/glb_info.py "$LIB/sheen/model.glb" | json "o.bounds[1].map((v,i)=>(v-o.bounds[0][i]).toFixed(3)).join(' ')")
  check "--rescale dims within 2% per axis" 'node -e "const [w,h,d]=\"$sz\".split(\" \").map(Number); process.exit(Math.abs(w-0.70)/0.70<0.02&&Math.abs(h-0.85)/0.85<0.02&&Math.abs(d-0.65)/0.65<0.02?0:1)"' "size $sz"
  check "--rescale summary says \$0 and adds no cost row" '[ "$(lastline $OUT/rescale.out | json "o.cost_usd")" = 0 ] && [ "$(wc -l <"$LIB/costs.csv")" = "$rows_before" ]'
  check "--rescale keeps the textures" '[ "$(evals/py evals/glb_info.py "$LIB/sheen/model.glb" | json "o.images")" = 7 ]'
else
  bad "--rescale refits an existing item — $(tail -n 2 "$OUT/rescale.err" | tr '\n' ' ')"
fi
run rescale-yaw --rescale arrow-0 --yaw 90 --library "$LIB" && {
  c=$(evals/py evals/glb_info.py "$LIB/arrow-0/model.glb" | json "o.centroid.map(v=>v.toFixed(3)).join(' ')")
  check "--rescale --yaw 90 is relative: the arrow now points -Z" 'node -e "const [x,,z]=\"$c\".split(\" \").map(Number); process.exit(z<-0.05&&Math.abs(x)<0.02?0:1)"' "centroid $c"
} || bad "--rescale --yaw — $(tail -n 1 "$OUT/rescale-yaw.err")"
bad_case rescale-unknown --rescale no-such-item --library "$LIB"
if MIDSTUDY_FAL_MOCK_COST=1 run paidmock "$IMG" --engine sam3d --name "Paid Mock" --id paid-mock --dims 75x80x95 --library "$LIB"; then
  check "MIDSTUDY_FAL_MOCK_COST=1 records the engine's real price on a mock run" '[ "$(lastline $OUT/paidmock.out | json "o.cost_usd")" = 0.02 ] && tail -n 1 "$LIB/costs.csv" | grep -q "paid-mock,sam3d,0.02,true"' "$(tail -n 1 "$LIB/costs.csv")"
else
  bad "MIDSTUDY_FAL_MOCK_COST=1 mock run — $(tail -n 1 "$OUT/paidmock.err")"
fi

# --- sam3d "no masks" (live 2026-11-05): retry with a lower threshold, then with a mask of the piece -------------------
if MIDSTUDY_FAL_MOCK_NO_MASKS=1 run nomask1 "$IMG" --engine sam3d --name "Retry One" --id retry-one --dims 75x80x95 --library "$LIB"; then
  check "no masks once: tried again with detection_threshold 0.2, and succeeded" 'grep -q "\"detection_threshold\": 0.2" $OUT/nomask1.out && ! grep -q mask_urls $OUT/nomask1.out'
else
  bad "no masks once: the retry succeeds — $(tail -n 1 "$OUT/nomask1.err")"
fi
if MIDSTUDY_FAL_MOCK_NO_MASKS=2 run nomask2 "$IMG" --engine sam3d --name "Retry Two" --id retry-two --dims 75x80x95 --library "$LIB"; then
  check "no masks twice: tried again with a mask of the piece (mask_urls), and succeeded" 'grep -q "mask_urls" $OUT/nomask2.out && [ -f $LIB/retry-two/raw/mask.png ]' "$(grep 'mask of' $OUT/nomask2.out)"
else
  bad "no masks twice: the mask retry succeeds — $(tail -n 1 "$OUT/nomask2.err")"
fi
if MIDSTUDY_FAL_MOCK_NO_MASKS=3 run nomask3 "$IMG" --engine sam3d --name "Retry Three" --id retry-three --dims 75x80x95 --library "$LIB"; then
  bad "no masks three times is refused"
else
  check "no masks three times: one plain line, no fal JSON, nothing added" 'tail -n 1 $OUT/nomask3.err | grep -q "SAM 3D found no" && ! grep -q "loc" $OUT/nomask3.err && [ ! -d $LIB/retry-three ]' "$(tail -n 1 $OUT/nomask3.err)"
fi

# --- rug engine (2026-11-05): a top-down rug picture on a white margin -> a flat slab, no model call, $0 ---------
RUG="$OUT/rug-picture.jpg"
evals/py -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (800, 800), (255, 255, 255))
d = ImageDraw.Draw(im)
d.rectangle([250, 150, 549, 649], fill=(150, 90, 40))
for y in range(170, 640, 40):
    d.rectangle([270, y, 529, y + 15], fill=(230, 220, 200))
im.save('$RUG', quality=92)
"
if run rug "$RUG" --engine rug --name "Flat Rug" --id flat-rug --dims 160x230x1 --category rug --library "$LIB"; then
  ok "rug run succeeds"
  check "rug summary: engine rug, \$0, no splat" '[ "$(lastline $OUT/rug.out | json "o.engine+\"|\"+o.cost_usd+\"|\"+o.paths.splat")" = "rug|0|null" ]' "$(lastline $OUT/rug.out)"
  check "rug crops the white margin to the rug (300 x 500 px)" 'grep -q "cropped the picture.s plain margin to 300 x 500 px" $OUT/rug.out' "$(grep note $OUT/rug.out | tr '\n' ' ')"
  b=$(evals/py evals/glb_info.py "$LIB/flat-rug/model.glb" | json "o.bounds.flat().map(v=>v.toFixed(3)).join(' ')")
  check "rug is a 160 x 230 x 1 cm slab on the floor, centered" '[ "$b" = "-0.800 0.000 -1.150 0.800 0.010 1.150" ]' "bounds $b"
  check "rug has its picture as a texture, and a thumbnail" '[ "$(evals/py evals/glb_info.py "$LIB/flat-rug/model.glb" | json "o.images")" = 1 ] && [ -f $LIB/flat-rug/thumb.jpg ]'
  check "rug library entry: engine rug, glb only, prompt null" 'node -e "
    const it = JSON.parse(require(\"fs\").readFileSync(\"$LIB/library.json\", \"utf8\")).items.find(i => i.id === \"flat-rug\")
    process.exit(it && it.source.engine === \"rug\" && it.source.prompt === null && it.assets.splat === null && it.default_render === \"glb\" ? 0 : 1)"'
else
  bad "rug run succeeds — $(tail -n 3 "$OUT/rug.err" | tr '\n' ' ')"
fi
if run rug-wide "$RUG" --engine rug --name "Wide Rug" --id wide-rug --dims 230x160x1 --library "$LIB"; then
  check "a portrait picture for a wide rug is turned a quarter" 'grep -q "turned the picture a quarter" $OUT/rug-wide.out' "$(grep note $OUT/rug-wide.out | tr '\n' ' ')"
else
  bad "rug run, wide — $(tail -n 3 "$OUT/rug-wide.err" | tr '\n' ' ')"
fi
bad_case rug-model fixtures/models/arrow.glb --engine rug --name "Not A Rug" --dims 100x100x1 --library "$LIB"

# --- costs + contract validation (L2) ----------------------------------------
check "costs.csv has a header and one row per successful run" '[ "$(tail -n +2 "$LIB/costs.csv" 2>/dev/null | grep -c .)" -ge 6 ]' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
check "costs.csv columns are date,id,engine,cost_usd,mock,input" '[ "$(head -n 1 "$LIB/costs.csv" 2>/dev/null)" = "date,id,engine,cost_usd,mock,input" ]'
check "mock runs record \$0 and mock=true" 'node -e "
  const rows = require(\"fs\").readFileSync(\"$LIB/costs.csv\", \"utf8\").trim().split(\"\n\").slice(1).map(r => r.split(\",\"))
  process.exit(rows.length && rows.every(r => r[4] === \"true\" && (Number(r[3]) === 0 || r[1] === \"paid-mock\")) ? 0 : 1)"' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
if evals/py evals/validate_library.py "$LIB/library.json" >"$OUT/validate.out" 2>&1; then
  ok "library passes evals/validate_library.py"
else
  bad "library passes evals/validate_library.py — $(grep FAIL "$OUT/validate.out" | tr '\n' ' ')"
fi

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
