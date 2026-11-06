#!/usr/bin/env bash
# Pipeline eval: runs midstudy-add against recorded fal responses (MIDSTUDY_FAL_MOCK), so it costs $0.
# Checks contract/CONTRACT.md §3. Output lands in evals/out/pipeline/.
# v4: OBJ zips, --rescale, --mount, MIDSTUDY_FAL_MOCK_COST (§3.1).
# Usage: bash evals/pipeline_offline.sh   (or npm run eval:pipeline)
# The CLI is node pipeline/src/cli.ts in strict mode (MIDSTUDY_STRICT=1, contract §0), with NODE_USE_ENV_PROXY=1 so
# Node honours the dead proxies below.
set -uo pipefail
cd "$(dirname "$0")/.."

ADD_CMD=(node pipeline/src/cli.ts)
echo "E8 pipeline: no server, furniture CLI ${ADD_CMD[*]}, MIDSTUDY_STRICT=1"

OUT=evals/out/pipeline
LIB="$OUT/library"
rm -rf "$OUT" && mkdir -p "$OUT"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8').trim().split('\n').pop()); process.stdout.write(String($1))"; }
lastline() { tail -n 1 "$1" 2>/dev/null; }

[ -f pipeline/src/cli.ts ] || { echo "FAIL pipeline/src/cli.ts not found"; exit 1; }
for slug in sam-3-3d-objects trellis-2; do
  [ -f "fixtures/fal/$slug/response.json" ] || { echo "FAIL fixtures/fal/$slug/response.json missing (run the Phase 0 capture)"; exit 1; }
done
IMG=$(ls fixtures/fal/sam-3-3d-objects/input.* 2>/dev/null | head -n 1)
[ -n "$IMG" ] || { echo "FAIL no fixtures/fal/sam-3-3d-objects/input.* image"; exit 1; }

# Every CLI call runs with proxies pointed at a dead port: any network request the CLI makes fails loudly instead of
# silently costing money (L6).
# FAL_MOCK_DIR: another mock folder for one call (the splat cover check below)
add() {
  env -u FAL_KEY MIDSTUDY_NO_DOTENV=1 NOOK_NO_DOTENV=1 MIDSTUDY_FAL_MOCK="${FAL_MOCK_DIR:-fixtures/fal}" MIDSTUDY_STRICT=1 NODE_USE_ENV_PROXY=1 \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= \
    "${ADD_CMD[@]}" "$@"
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
    MIDSTUDY_STRICT=1 NODE_USE_ENV_PROXY=1 "${ADD_CMD[@]}" "$IMG" --name "X" --dims 75x80x95 --library "$LIB" >"$OUT/no-key.out" 2>"$OUT/no-key.err"; then
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

# --- v1.1 idol engine (2026-11-05, written before the code; contract §1, §3.2, §3.4): the default engine, a stand-in
# box, a per-axis splat fit and splat.spz. Mock: fixtures/fal/speridlabs-idol (the Morris chair, 262,144 splats). -----
splat_facts() {  # one JSON line about a splat.ply and its splat.spz: counts, extent (idol percentiles), back-top, sizes
  evals/py -c "
import gzip, json, struct, sys, numpy as np
from pathlib import Path
ply, spz = Path(sys.argv[1]), Path(sys.argv[2])
raw = ply.read_bytes(); end = raw.index(b'end_header\n') + 11
names = [l.split()[2] for l in raw[:end].decode().split('\n') if l.startswith('property')]
types = [l.split()[1] for l in raw[:end].decode().split('\n') if l.startswith('property')]
d = np.frombuffer(raw, dtype=[(n, '<f4' if t == 'float' else '<f8') for n, t in zip(names, types)], offset=end)
xyz = np.stack([d['x'], d['y'], d['z']], 1).astype(float)
lo, hi = np.percentile(xyz, 0.1, 0), np.percentile(xyz, 99.9, 0)
top = xyz[:, 1] >= np.percentile(xyz[:, 1], 90)
out = {'ply_count': len(d), 'props': names, 'extent': (hi - lo).round(4).tolist(), 'lo_y': round(float(lo[1]), 4),
       'center_xz': [round(float((lo[0] + hi[0]) / 2), 4), round(float((lo[2] + hi[2]) / 2), 4)],
       'top10_mean_z': round(float(xyz[top, 2].mean()), 4), 'ply_bytes': ply.stat().st_size}
if spz.is_file():
    b = spz.read_bytes(); u = gzip.decompress(b)
    m, v, n, sh, fb, fl, _ = struct.unpack_from('<IIIBBBB', u, 0)
    out.update({'spz_bytes': len(b), 'spz_magic': hex(m), 'spz_version': v, 'spz_count': n, 'spz_sh': sh, 'spz_frac': fb})
print(json.dumps(out))
" "$1" "$2"
}
if run idol "$IMG" --name "Mock Idol Chair" --id mock-idol --dims 80x90x95 --library "$LIB"; then
  ok "an image add with no --engine runs (idol is the default)"
  check "idol summary: engine idol, mock, \$0, paths.spz" '[ "$(lastline $OUT/idol.out | json "o.engine+\"|\"+o.mock+\"|\"+o.cost_usd+\"|\"+(o.paths.spz||\"\").endsWith(\"mock-idol/splat.spz\")")" = "idol|true|0|true" ]' "$(lastline $OUT/idol.out | head -c 400)"
  check "idol writes model.glb (stand-in), splat.ply, splat.spz and thumb.jpg" '[ -f $LIB/mock-idol/model.glb ] && [ -f $LIB/mock-idol/splat.ply ] && [ -f $LIB/mock-idol/splat.spz ] && [ -f $LIB/mock-idol/thumb.jpg ]'
  check "idol called speridlabs/idol with image_type real and 262,144 Gaussians, on the metadata-free upload" 'node -e "
    const r = JSON.parse(require(\"fs\").readFileSync(\"$LIB/mock-idol/raw/request.json\", \"utf8\"))
    process.exit(r.image_type === \"real\" && r.num_gaussians === 262144 && /uploads\/engine-input\.jpg$/.test(r.image_url) && !(\"prompt\" in r) ? 0 : 1)"' "$(tr -d '\n' <"$LIB/mock-idol/raw/request.json" 2>/dev/null | head -c 300)"
  check "the log names the endpoint" 'grep -q "calling speridlabs/idol (mock)" $OUT/idol.out' "$(grep calling $OUT/idol.out | head -c 200)"
  b=$(evals/py evals/glb_info.py "$LIB/mock-idol/model.glb" | json "o.bounds.flat().map(v=>v.toFixed(3)).join(' ')+' '+o.images+' '+o.materials")
  check "the stand-in model.glb is an untextured box exactly at 80 x 95 x 90 cm, centered on the floor" '[ "$b" = "-0.400 0.000 -0.450 0.400 0.950 0.450 0 1" ]' "bounds images materials: $b"
  f=$(splat_facts "$LIB/mock-idol/splat.ply" "$LIB/mock-idol/splat.spz")
  echo "     splat facts: $f" | head -c 600; echo
  check "splat.ply keeps all 262,144 splats, without nx/ny/nz" 'node -e "const f=$f; process.exit(f.ply_count===262144 && !f.props.includes(\"nx\") && f.props.includes(\"f_dc_0\") ? 0 : 1)"'
  check "splat.ply is fitted per axis: its p0.1-p99.9 extent is 80 x 95 x 90 cm within 2 %, on the floor, centered" 'node -e "
    const f=$f, want=[0.8,0.95,0.9]
    process.exit(f.extent.every((v,i)=>Math.abs(v-want[i])/want[i]<=0.02) && Math.abs(f.lo_y)<=0.01 && f.center_xz.every(c=>Math.abs(c)<=0.01) ? 0 : 1)"' "extent ${f}"
  check "the idol splat stands upright with its front to +Z (NOTES.md frame): the top 10 % (the backrest) sits in the back half" 'node -e "const f=$f; process.exit(f.top10_mean_z < -0.1*0.9 ? 0 : 1)"' "top10_mean_z from $f"
  check "splat.spz: gzipped SPZ v2 (NGSP), SH 0, 12 fractional bits, all 262,144 splats, at most 6 MB" 'node -e "
    const f=$f; process.exit(f.spz_magic===\"0x5053474e\" && f.spz_version===2 && f.spz_sh===0 && f.spz_frac===12 && f.spz_count===262144 && f.spz_bytes<=6*1024*1024 ? 0 : 1)"' "$f"
  check "idol library entry: engine idol, default_render splat, assets.spz, prompt null" 'node -e "
    const it = JSON.parse(require(\"fs\").readFileSync(\"$LIB/library.json\", \"utf8\")).items.find(i => i.id === \"mock-idol\")
    process.exit(it && it.source.engine === \"idol\" && it.default_render === \"splat\" && it.assets.spz === \"mock-idol/splat.spz\" && it.assets.splat === \"mock-idol/splat.ply\" && it.source.prompt === null ? 0 : 1)"'
  check "a local input is recorded by its name only, no folder path (library.json and costs.csv are tracked, library.json is served)" 'node -e "
    const it = JSON.parse(require(\"fs\").readFileSync(\"$LIB/library.json\", \"utf8\")).items.find(i => i.id === \"mock-idol\")
    process.exit(it && it.source.input === require(\"path\").basename(\"$IMG\") ? 0 : 1)" && ! grep -q "/Users/\|$(pwd)" "$LIB/costs.csv"' "$(grep -o '\"input\": *\"[^\"]*\"' "$LIB/library.json" | sort -u | tr '\n' ' ')"
  check "sam3d adds write splat.spz too (count = its splat.ply's, under the cap)" '[ -f $LIB/mock-sam/splat.spz ] && node -e "const f=$(splat_facts "$LIB/mock-sam/splat.ply" "$LIB/mock-sam/splat.spz"); process.exit(f.spz_count===Math.min(f.ply_count,262144) && f.spz_version===2 ? 0 : 1)"'
  if run idol-rescale --rescale mock-idol --dims 70x85x100 --library "$LIB"; then
    f2=$(splat_facts "$LIB/mock-idol/splat.ply" "$LIB/mock-idol/splat.spz")
    b2=$(evals/py evals/glb_info.py "$LIB/mock-idol/model.glb" | json "o.bounds.flat().map(v=>v.toFixed(3)).join(' ')")
    check "--rescale an idol item refits the stand-in box, splat.ply and splat.spz per axis (70 x 100 x 85 cm), \$0" 'node -e "
      const f=$f2, want=[0.7,1.0,0.85]
      process.exit(f.extent.every((v,i)=>Math.abs(v-want[i])/want[i]<=0.02) && f.spz_count===262144 ? 0 : 1)" && [ "$b2" = "-0.350 0.000 -0.425 0.350 1.000 0.425" ] && [ "$(lastline $OUT/idol-rescale.out | json "o.cost_usd")" = 0 ]' "box $b2; $f2"
  else
    bad "--rescale an idol item — $(tail -n 2 "$OUT/idol-rescale.err" | tr '\n' ' ')"
  fi
else
  bad "an image add with no --engine runs (idol is the default) — $(tail -n 3 "$OUT/idol.err" | tr '\n' ' ')"
fi
if run idol-prompt "$IMG" --engine idol --prompt chair --name "Idol Prompt" --id idol-prompt --dims 60x60x80 --library "$LIB"; then
  check "--prompt with idol is ignored with a note" 'grep -q "prompt only applies to sam3d" $OUT/idol-prompt.out'
else
  bad "idol with --prompt — $(tail -n 1 "$OUT/idol-prompt.err")"
fi
if MIDSTUDY_FAL_MOCK_COST=1 run idol-paid "$IMG" --engine idol --name "Idol Paid Mock" --id idol-paid --dims 60x60x80 --library "$LIB"; then
  check "MIDSTUDY_FAL_MOCK_COST=1 records idol at \$0.10" '[ "$(lastline $OUT/idol-paid.out | json "o.cost_usd")" = 0.1 ] && tail -n 1 "$LIB/costs.csv" | grep -q "idol-paid,idol,0.1,true"' "$(tail -n 1 "$LIB/costs.csv")"
else
  bad "MIDSTUDY_FAL_MOCK_COST=1 idol run — $(tail -n 1 "$OUT/idol-paid.err")"
fi
bad_case idol-model fixtures/models/arrow.glb --engine idol --name "Not A Photo" --dims 100x100x100 --library "$LIB"
# Above 262,144 splats, splat.spz keeps the ones that cover the most (opacity x area), not the most opaque: a live
# SAM 3D splat (878k) kept by opacity alone shrank to 77-94 % of its extent and looked see-through (verify v1.1).
# Here a mocked SAM 3D answers 300k small opaque splats inside 0.3 m and 100k big half-opaque ones on a 1 m shell,
# through a real add. Fitted per axis, the shell is still the outside: splat.spz must keep it (its p99 radius about
# the center equals all the splats').
COVER_MOCK="$OUT/fal-cover"
rm -rf "$COVER_MOCK" && mkdir -p "$COVER_MOCK" && cp -R fixtures/fal/sam-3-3d-objects "$COVER_MOCK/"
COVER_PLY=$(ls "$COVER_MOCK"/sam-3-3d-objects/files/*.ply | head -n 1)
evals/py -c "
import numpy as np, sys
rng = np.random.default_rng(1)
names = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3']
n_in, n_out = 300000, 100000
d = np.zeros(n_in + n_out, dtype=[(k, '<f4') for k in names])
p = rng.normal(size=(n_in + n_out, 3)); p /= np.linalg.norm(p, axis=1, keepdims=True)
p[:n_in] *= rng.uniform(0, 0.3, (n_in, 1))
for i, k in enumerate('xyz'): d[k] = p[:, i]
d['opacity'][:n_in], d['opacity'][n_in:] = 8.0, 0.0
for k in ('scale_0', 'scale_1', 'scale_2'): d[k][:n_in], d[k][n_in:] = np.log(0.002), np.log(0.03)
d['rot_0'] = 1.0
head = 'ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\n' % len(d) + ''.join('property float %s\\n' % k for k in names) + 'end_header\\n'
open(sys.argv[1], 'wb').write(head.encode() + d.tobytes())
" "$COVER_PLY"
if FAL_MOCK_DIR="$COVER_MOCK" run cover "$IMG" --engine sam3d --name "Cover Shell" --id cover-shell --dims 100x100x100 --library "$LIB"; then
  cover=$(evals/py -c "
import gzip, json, struct, sys, numpy as np
raw = open(sys.argv[1], 'rb').read(); end = raw.index(b'end_header\\n') + 11
props = [l.split() for l in raw[:end].decode().split('\\n') if l.startswith('property')]
d = np.frombuffer(raw, dtype=[(l[2], '<f4' if l[1] == 'float' else '<f8') for l in props], offset=end)
ply = np.stack([d['x'], d['y'], d['z']], 1).astype(float)
u = gzip.decompress(open(sys.argv[2], 'rb').read())
_, _, n, _, frac, _, _ = struct.unpack_from('<IIIBBBB', u, 0)
b = np.frombuffer(u, dtype=np.uint8, count=n * 9, offset=16).reshape(n, 3, 3).astype(np.int32)
q = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16); q = np.where(q >= 1 << 23, q - (1 << 24), q)
spz = q / float(1 << frac)
c = (np.percentile(ply, 1, 0) + np.percentile(ply, 99, 0)) / 2
r = lambda a: float(np.percentile(np.linalg.norm(a - c, axis=1), 99))
print(json.dumps({'count': int(n), 'ply_count': len(ply), 'ratio': round(r(spz) / r(ply), 4)}))
" "$LIB/cover-shell/splat.ply" "$LIB/cover-shell/splat.spz" 2>&1 | tail -n 1)
  check "splat.spz above 262,144 splats keeps the ones that cover the most: a 1 m shell of big half-opaque splats survives (through the CLI)" 'node -e "const c=$cover; process.exit(c.count===262144 && c.ply_count===400000 && c.ratio>0.95 ? 0 : 1)"' "$cover"
else
  bad "a sam3d add of a 400,000-splat shell (the cover check) — $(tail -n 2 "$OUT/cover.err" | tr '\n' ' ')"
fi

# --- costs + contract validation (L2) ----------------------------------------
check "costs.csv has a header and one row per successful run" '[ "$(tail -n +2 "$LIB/costs.csv" 2>/dev/null | grep -c .)" -ge 6 ]' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
check "costs.csv columns are date,id,engine,cost_usd,mock,input" '[ "$(head -n 1 "$LIB/costs.csv" 2>/dev/null)" = "date,id,engine,cost_usd,mock,input" ]'
check "mock runs record \$0 and mock=true" 'node -e "
  const rows = require(\"fs\").readFileSync(\"$LIB/costs.csv\", \"utf8\").trim().split(\"\n\").slice(1).map(r => r.split(\",\"))
  process.exit(rows.length && rows.every(r => r[4] === \"true\" && (Number(r[3]) === 0 || r[1] === \"paid-mock\" || r[1] === \"idol-paid\")) ? 0 : 1)"' "$(cat "$LIB/costs.csv" 2>/dev/null | tr '\n' ' ')"
if evals/py evals/validate_library.py "$LIB/library.json" >"$OUT/validate.out" 2>&1; then
  ok "library passes evals/validate_library.py"
else
  bad "library passes evals/validate_library.py — $(grep FAIL "$OUT/validate.out" | tr '\n' ' ')"
fi

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
