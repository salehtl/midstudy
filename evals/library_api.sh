#!/usr/bin/env bash
# Library API eval (contract §2.8 L8–L11, §2.9 W1–W4): planner/serve.py on a scratch library, fal mocked ($0).
# A local image server stands in for the web (MIDSTUDY_FETCH_ALLOW lets the fetcher reach it and nothing else private),
# and a canary port records any connection the fetcher should never have made.
# Usage: bash evals/library_api.sh   (or npm run eval:library). Output lands in evals/out/library-api/.
# The first server runs with --daily-spend-usd 0: mock calls count for nothing, so the mocked adds still go through.
# v2 switches (contract §0): MIDSTUDY_SERVER=legacy|next (planner/serve.py, or node server/src/main.ts with the same
# flags), MIDSTUDY_ADD=legacy|next (the --midstudy-add the server gets: uv run --project pipeline midstudy-add, or node
# pipeline/src/cli.ts); either next sets MIDSTUDY_STRICT=1. node scripts/build.mjs runs first when it exists.
# MIDSTUDY_RECORD_API=<dir> records each API call made through add/call/wait_job (contract/tools/check-recordings.mjs).
set -uo pipefail
cd "$(dirname "$0")/.."

case "${MIDSTUDY_SERVER:-legacy}" in
  legacy) SERVER_CMD=(python3 planner/serve.py) ;;
  next) SERVER_CMD=(node server/src/main.ts) ;;
  *) echo "FAIL MIDSTUDY_SERVER must be legacy or next, not ${MIDSTUDY_SERVER}"; exit 2 ;;
esac
case "${MIDSTUDY_ADD:-legacy}" in
  legacy) ADD_CMD="uv run --project pipeline midstudy-add" ;;
  next) ADD_CMD="node pipeline/src/cli.ts" ;;
  *) echo "FAIL MIDSTUDY_ADD must be legacy or next, not ${MIDSTUDY_ADD}"; exit 2 ;;
esac
STRICT=""
if [ "${MIDSTUDY_SERVER:-legacy}" = next ] || [ "${MIDSTUDY_ADD:-legacy}" = next ]; then STRICT=1; fi
echo "E7 library-api: server ${MIDSTUDY_SERVER:-legacy} (${SERVER_CMD[*]}), furniture CLI ${MIDSTUDY_ADD:-legacy} ($ADD_CMD)${STRICT:+, MIDSTUDY_STRICT=1}${MIDSTUDY_RECORD_API:+, recording /api calls to $MIDSTUDY_RECORD_API}"

OUT=evals/out/library-api
LIB="$OUT/library"
# Three free ports (server, stand-in web, canary), unless MIDSTUDY_EVAL_LIBRARY_PORT pins them to PORT, PORT+1, PORT+2.
if [ -n "${MIDSTUDY_EVAL_LIBRARY_PORT:-}" ]; then
  PORT=$MIDSTUDY_EVAL_LIBRARY_PORT; IMGPORT=$((PORT + 1)); CANARY=$((PORT + 2))
else
  read -r PORT IMGPORT CANARY < <(python3 -c '
import socket
ss = [socket.socket() for _ in range(3)]
for s in ss: s.bind(("127.0.0.1", 0))
print(*[s.getsockname()[1] for s in ss])')
fi
BASE="http://127.0.0.1:$PORT"
rm -rf "$OUT" && mkdir -p "$LIB" "$OUT/r" "$OUT/web"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
py() { OUT="$OUT" LIB="$LIB" python3 -c '
import json, os, sys
OUT, LIB = os.environ["OUT"], os.environ["LIB"]
r = lambda n: json.load(open(f"{OUT}/r/{n}.json"))
f = lambda p: json.load(open(p))
sys.exit(0 if eval(sys.argv[1]) else 1)' "$1"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
# record METHOD PATH STATUS RESPONSE-FILE [REQUEST-JSON] [META-JSON]: with MIDSTUDY_RECORD_API=<dir>, one JSON line per
# API call, as evals/lib/harness.mjs writes them
record() {
  [ -n "${MIDSTUDY_RECORD_API:-}" ] || return 0
  mkdir -p "$MIDSTUDY_RECORD_API"
  python3 - "$MIDSTUDY_RECORD_API/library-api-$$.jsonl" "$@" <<'PY'
import json, sys
out, method, path, status, resp = sys.argv[1:6]
extra = sys.argv[6:] + ["", ""]
def load(t):
    try:
        return json.loads(t)
    except ValueError:
        return t
try:
    body = json.load(open(resp))
except (OSError, ValueError):
    body = None
request = {}
if extra[0]:
    request["body"] = load(extra[0])
if extra[1]:
    request["meta"] = load(extra[1])
rec = {"eval": "library-api", "method": method, "path": path, "status": int(status) if status.isdigit() else 0,
       "request": request, "response": {"body": body}}
open(out, "a").write(json.dumps(rec) + "\n")
PY
}
# add NAME KIND FILE META-JSON [curl args...]: raw-body upload (§2.8); saves the response, prints the status
add() {
  local n=$1 kind=$2 file=$3 meta=$4 code; shift 4
  code=$(curl -s -o "$OUT/r/$n.json" -w '%{http_code}' -X POST -H 'X-Midstudy: 1' -H "X-Midstudy-Kind: $kind" \
    -H "X-Midstudy-Filename: $(basename "$file")" -H "X-Midstudy-Meta: $(b64 "$meta")" -H 'Content-Type: application/octet-stream' \
    --data-binary "@$file" "$@" "$BASE/api/library/items")
  record POST /api/library/items "$code" "$OUT/r/$n.json" "" "$meta"
  echo "$code"
}
# call NAME METHOD PATH [JSON]: a JSON mutation or read with X-Midstudy
call() {
  local args=(-s -o "$OUT/r/$1.json" -w '%{http_code}' -X "$2" -H 'X-Midstudy: 1') code
  [ -n "${4:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "$4")
  code=$(curl "${args[@]}" "$BASE$3")
  record "$2" "$3" "$code" "$OUT/r/$1.json" "${4:-}"
  echo "$code"
}
wait_job() {  # wait_job NAME JOB-ID: polls until done/failed (60 s); saves the job as NAME, prints its status
  local s="" code=""
  for _ in $(seq 1 120); do
    code=$(curl -s -o "$OUT/r/$1.json" -w '%{http_code}' "$BASE/api/library/jobs/$2")
    s=$(python3 -c "import json; print(json.load(open('$OUT/r/$1.json')).get('status', ''))" 2>/dev/null)
    [[ "$s" =~ ^(done|failed)$ ]] && break
    sleep 0.5
  done
  record GET "/api/library/jobs/$2" "$code" "$OUT/r/$1.json"
  echo "$s"
}
jid() { python3 -c "import json; print(json.load(open('$OUT/r/$1.json')).get('job', {}).get('id', ''))" 2>/dev/null; }
sha() { shasum "$1" 2>/dev/null | cut -c1-40; }

# --- the stand-in web: an image, a page, redirects; and a canary that must never be reached ---------------------------------
IMG=fixtures/fal/sam-3-3d-objects/input.jpg
cp "$IMG" "$OUT/web/chair.jpg"
echo '<html><body><img src="chair.jpg"></body></html>' >"$OUT/web/page.html"
python3 - "$IMGPORT" "$CANARY" "$OUT/web" "$OUT/canary.log" >"$OUT/web.log" 2>&1 <<'PY' &
import sys, threading, socket
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
port, canary, root, log = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def do_GET(self):
        if self.path.startswith("/redir-private"):
            self.send_response(302); self.send_header("Location", f"http://127.0.0.1:{canary}/x"); self.end_headers(); return
        if self.path.startswith("/redir-ok"):
            self.send_response(302); self.send_header("Location", f"http://127.0.0.1:{port}/chair.jpg"); self.end_headers(); return
        if self.path.startswith("/loop"):
            self.send_response(302); self.send_header("Location", f"http://127.0.0.1:{port}/loop"); self.end_headers(); return
        super().do_GET()
def watch():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", canary)); s.listen(8)
    while True:
        c, a = s.accept(); open(log, "a").write(f"connection from {a}\n"); c.close()
threading.Thread(target=watch, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
WEB_PID=$!

SERVER_PID=""
start_server() {  # start_server [server args...]
  env -u FAL_KEY MIDSTUDY_NO_DOTENV=1 NOOK_NO_DOTENV=1 MIDSTUDY_FAL_MOCK=fixtures/fal MIDSTUDY_FETCH_ALLOW="127.0.0.1:$IMGPORT" ${MIDSTUDY_FAL_MOCK_COST:+MIDSTUDY_FAL_MOCK_COST=1} \
    ${STRICT:+MIDSTUDY_STRICT=1} "${SERVER_CMD[@]}" --port "$PORT" --library-dir "$LIB" --costs-file "$LIB/costs.csv" --scenes-dir "$OUT/scenes" \
    --layouts-dir "$OUT/layouts" --renders-dir "$OUT/renders" --midstudy-add "$ADD_CMD" "$@" >>"$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -sf "$BASE/api/library" >/dev/null && return 0; sleep 0.2; done
  return 1
}
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
trap 'stop_server; kill "$WEB_PID" 2>/dev/null' EXIT
if [ "${MIDSTUDY_ADD:-legacy}" = legacy ]; then
  uv sync -q --project pipeline || { echo "FAIL uv sync --project pipeline"; exit 1; }
fi
if [ -f scripts/build.mjs ]; then
  node scripts/build.mjs >"$OUT/build.log" 2>&1; built=$?
  check "node scripts/build.mjs builds the planner" '[ "$built" = 0 ]' "$(tail -n 3 "$OUT/build.log" | tr '\n' ' ')"
fi
start_server --daily-spend-usd 0 || { echo "FAIL ${SERVER_CMD[*]} did not answer GET /api/library (log: $OUT/server.log)"; tail -n 5 "$OUT/server.log"; exit 1; }

# --- reads ------------------------------------------------------------------------------------------------------------------------
code=$(call lib0 GET /api/library)
check "GET /api/library on an empty library: version, items [], trash []" '[ "$code" = 200 ] && py "r(\"lib0\")[\"items\"] == [] and r(\"lib0\")[\"trash\"] == []"' "$code $(cat "$OUT/r/lib0.json")"

# --- forged requests (W1) ---------------------------------------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Midstudy-Kind: model' -H 'X-Midstudy-Filename: SheenChair.glb' \
  -H "X-Midstudy-Meta: $(b64 '{"name": "Forged", "dims_cm": {"w": 60, "d": 65, "h": 85}}')" --data-binary @fixtures/models/SheenChair.glb "$BASE/api/library/items")
check "W1 an add without X-Midstudy is 403" '[ "$code" = 403 ]' "$code"
code=$(add forged2 model fixtures/models/SheenChair.glb '{"name": "Forged", "dims_cm": {"w": 60, "d": 65, "h": 85}}' -H 'Origin: http://evil.example')
check "W1 an add with a foreign Origin is 403" '[ "$code" = 403 ]' "$code"
check "W1 nothing was added" 'py "f(LIB + \"/library.json\")[\"items\"] == [] if os.path.exists(LIB + \"/library.json\") else True"'

# --- adds (L8) ------------------------------------------------------------------------------------------------------------------
code=$(add glb model fixtures/models/SheenChair.glb '{"name": "Sheen Chair", "dims_cm": {"w": 60, "d": 65, "h": 85}, "category": "chair"}')
check "a .glb upload is 202 with a job and a \$0 estimate" '[ "$code" = 202 ] && py "r(\"glb\")[\"cost_usd_estimate\"] == 0 and r(\"glb\")[\"job\"][\"kind\"] == \"add\" and r(\"glb\")[\"job\"][\"item_id\"] == \"sheen-chair\""' "$code $(head -c 300 "$OUT/r/glb.json")"
st=$(wait_job glbj "$(jid glb)")
check "the .glb job ends done with the item" '[ "$st" = done ] && py "r(\"glbj\")[\"item\"][\"id\"] == \"sheen-chair\""' "$st $(head -c 300 "$OUT/r/glbj.json")"
code=$(add obj model fixtures/models/cube-obj.zip '{"name": "Cube", "dims_cm": {"w": 40, "d": 40, "h": 40}, "mount": "wall"}')
st=$(wait_job objj "$(jid obj)")
check "an OBJ zip upload ends done, mount kept" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"objj\")[\"item\"].get(\"mount\") == \"wall\""' "$code $st $(head -c 300 "$OUT/r/objj.json")"
code=$(add photo image "$IMG" '{"name": "Phone Chair", "dims_cm": {"w": 75, "d": 80, "h": 95}, "engine": "sam3d", "prompt": "chair"}')
check "a photo upload is 202 with the engine's estimate (\$0.02)" '[ "$code" = 202 ] && py "r(\"photo\")[\"cost_usd_estimate\"] == 0.02"' "$code $(head -c 300 "$OUT/r/photo.json")"
st=$(wait_job photoj "$(jid photo)")
check "the photo job ends done, mocked at \$0" '[ "$st" = done ] && py "r(\"photoj\")[\"mock\"] is True and r(\"photoj\")[\"cost_usd\"] == 0"' "$st $(head -c 300 "$OUT/r/photoj.json")"
code=$(call url POST /api/library/items/from-url "{\"image_url\": \"http://127.0.0.1:$IMGPORT/redir-ok\", \"name\": \"Web Chair\", \"dims_cm\": {\"w\": 75, \"d\": 80, \"h\": 95}, \"engine\": \"trellis2\"}")
st=$(wait_job urlj "$(jid url)")
check "a from-URL add (through one redirect) ends done" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"url\")[\"cost_usd_estimate\"] == 0.25"' "$code $st $(head -c 300 "$OUT/r/urlj.json")"
code=$(add upsert model fixtures/models/SheenChair.glb '{"name": "Sheen Chair", "dims_cm": {"w": 62, "d": 65, "h": 85}}')
st=$(wait_job upsertj "$(jid upsert)")
check "re-adding an id replaces it and says so" '[ "$st" = done ] && grep -qi replac "$OUT/r/upsertj.json" && py "[i[\"id\"] for i in f(LIB + \"/library.json\")[\"items\"]].count(\"sheen-chair\") == 1"' "$st $(head -c 300 "$OUT/r/upsertj.json")"
call jobs GET /api/library/jobs >/dev/null
check "GET /api/library/jobs lists every job, newest first" 'py "len(r(\"jobs\")[\"jobs\"]) == 5 and r(\"jobs\")[\"jobs\"][0][\"id\"] == r(\"upsert\")[\"job\"][\"id\"]"'
check "L8 the library passes validate_library.py" 'evals/py evals/validate_library.py "$LIB/library.json" >"$OUT/validate.out" 2>&1' "$(grep FAIL "$OUT/validate.out" | head -n 3 | tr '\n' ' ')"

# --- bad adds -----------------------------------------------------------------------------------------------------------------------
check "missing dims is 400" '[ "$(add nodims model fixtures/models/SheenChair.glb "{\"name\": \"X\"}")" = 400 ] && py "len(r(\"nodims\")[\"error\"]) > 10"'
check "a non-slug id is 400" '[ "$(add badid model fixtures/models/SheenChair.glb "{\"name\": \"X\", \"id\": \"Bad Id\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 400 ]'
check "a 3D model with an image engine (idol) is 400, not quietly glb" '[ "$(add modeleng model fixtures/models/arrow.glb "{\"name\": \"X\", \"engine\": \"idol\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 400 ] && grep -qi "glb" "$OUT/r/modeleng.json"'
check "an unknown engine is 400" '[ "$(add badeng image "$IMG" "{\"name\": \"X\", \"engine\": \"foo\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 400 ]'
: >"$OUT/thing.usdz"
check "a .usdz model is 400 with convert to GLB" '[ "$(add usdz model "$OUT/thing.usdz" "{\"name\": \"X\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 400 ] && grep -qi "glb" "$OUT/r/usdz.json"'
check "no X-Midstudy-Meta is 400" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Midstudy: 1" -H "X-Midstudy-Kind: model" -H "X-Midstudy-Filename: a.glb" --data-binary @fixtures/models/arrow.glb "$BASE/api/library/items")" = 400 ]'
check "an add without Content-Length is 411" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Midstudy: 1" -H "X-Midstudy-Kind: model" -H "X-Midstudy-Filename: a.glb" -H "X-Midstudy-Meta: $(b64 "{\"name\": \"X\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" -H "Transfer-Encoding: chunked" --data-binary @fixtures/models/arrow.glb "$BASE/api/library/items")" = 411 ]'
head -c $((21 * 1024 * 1024)) /dev/zero >"$OUT/big.jpg"
check "an image over 20 MB is 413" '[ "$(add big image "$OUT/big.jpg" "{\"name\": \"X\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 413 ]'
before=$(sha "$LIB/library.json")
for evil in slip abs link exe; do
  python3 - "$OUT/evil-$evil.zip" "$evil" <<'PY'
import sys, zipfile, stat
src = zipfile.ZipFile("fixtures/models/cube-obj.zip")
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for n in src.namelist(): z.writestr(n, src.read(n))
    kind = sys.argv[2]
    if kind == "link":
        info = zipfile.ZipInfo("cube/link.png"); info.external_attr = (stat.S_IFLNK | 0o777) << 16; z.writestr(info, "/etc/passwd")
    else:
        z.writestr({"slip": "../../escaped.txt", "abs": "/tmp/midstudy-escaped.txt", "exe": "cube/run.exe"}[kind], "x")
PY
  check "L10 a zip with $evil is refused with 400" '[ "$(add "evil-$evil" model "$OUT/evil-$evil.zip" "{\"name\": \"Evil\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}")" = 400 ]' "$(cat "$OUT/r/evil-$evil.json")"
done
check "L10 nothing written by the refused zips" '[ "$(sha "$LIB/library.json")" = "$before" ] && [ ! -e "$OUT/escaped.txt" ] && [ ! -e evals/escaped.txt ] && [ ! -e /tmp/midstudy-escaped.txt ] && [ ! -d "$LIB/evil" ]'

# --- URL fetches (W3) --------------------------------------------------------------------------------------------------------------
urladd() { call "$1" POST /api/library/items/from-url "{\"image_url\": \"$2\", \"name\": \"X\", \"id\": \"x-$1\", \"dims_cm\": {\"w\": 1, \"d\": 1, \"h\": 1}}"; }
check "a web page link is 400 asking for the image's own link" '[ "$(urladd page "http://127.0.0.1:$IMGPORT/page.html")" = 400 ] && grep -qi "image" "$OUT/r/page.json"' "$(cat "$OUT/r/page.json")"
check "W3 127.0.0.1 on another port is refused" '[ "$(urladd loop4 "http://127.0.0.1:$CANARY/x")" = 400 ]' "$(cat "$OUT/r/loop4.json")"
check "W3 localhost by name is refused" '[ "$(urladd lname "http://localhost:$CANARY/x")" = 400 ]'
check "W3 an IPv4-mapped IPv6 loopback is refused" '[ "$(urladd mapped "http://[::ffff:127.0.0.1]:$CANARY/x")" = 400 ]'
check "W3 the metadata address is refused" '[ "$(urladd meta "http://169.254.169.254/latest/meta-data/")" = 400 ]'
check "W3 a tailnet address is refused" '[ "$(urladd tail "http://100.100.100.100/x.jpg")" = 400 ]'
check "W3 a redirect to a private address is refused" '[ "$(urladd redir "http://127.0.0.1:$IMGPORT/redir-private")" = 400 ]' "$(cat "$OUT/r/redir.json")"
check "W3 a redirect loop stops after 3" '[ "$(urladd loop "http://127.0.0.1:$IMGPORT/loop")" = 400 ]'
check "W3 file:// is refused" '[ "$(urladd file "file:///etc/passwd")" = 400 ]'
check "W3 the canary port was never connected to" '[ ! -s "$OUT/canary.log" ]' "$(cat "$OUT/canary.log" 2>/dev/null)"

# --- edit (L11), delete and restore (L9) ------------------------------------------------------------------------------------------
code=$(call ren PATCH /api/library/items/cube '{"name": "Wall cube", "category": "art", "mount": "floor"}')
check "PATCH name/category/mount is 200 in place" '[ "$code" = 200 ] && py "(lambda i: i[\"name\"] == \"Wall cube\" and i[\"category\"] == \"art\" and i[\"mount\"] == \"floor\")([i for i in f(LIB + \"/library.json\")[\"items\"] if i[\"id\"] == \"cube\"][0])"' "$code $(head -c 300 "$OUT/r/ren.json")"
check "PATCH default_render splat on a glb-only item is 400" '[ "$(call rbad PATCH /api/library/items/cube "{\"default_render\": \"splat\"}")" = 400 ]'
code=$(call dims PATCH /api/library/items/sheen-chair '{"dims_cm": {"w": 70, "d": 65, "h": 85}}')
st=$(wait_job dimsj "$(jid dims)")
sz=$(evals/py evals/glb_info.py "$LIB/sheen-chair/model.glb" | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(o.bounds[1].map((v,i)=>(v-o.bounds[0][i]).toFixed(3)).join(' '))")
check "L11 PATCH dims_cm is a rescale job that refits within 2% at \$0" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"dimsj\")[\"kind\"] == \"rescale\" and r(\"dimsj\")[\"cost_usd\"] == 0" && node -e "const [w,h,d]=\"$sz\".split(\" \").map(Number); process.exit(Math.abs(w-0.70)/0.70<0.02&&Math.abs(h-0.85)/0.85<0.02&&Math.abs(d-0.65)/0.65<0.02?0:1)"' "$code $st size $sz"
check "PATCH an unknown item is 404" '[ "$(call pnope PATCH /api/library/items/nope "{\"name\": \"x\"}")" = 404 ]'
before_glb=$(sha "$LIB/sheen-chair/model.glb"); before_entry=$(python3 -c "import json; print(json.dumps([i for i in json.load(open('$LIB/library.json'))['items'] if i['id']=='sheen-chair'][0], sort_keys=True))")
code=$(call del DELETE /api/library/items/sheen-chair)
check "DELETE moves the item to library/.trash/" '[ "$code" = 200 ] && [ ! -e "$LIB/sheen-chair" ] && ls -d "$LIB"/.trash/sheen-chair-* >/dev/null 2>&1 && py "\"sheen-chair\" not in [i[\"id\"] for i in f(LIB + \"/library.json\")[\"items\"]]"' "$code $(ls -a "$LIB" "$LIB/.trash" 2>&1 | tr '\n' ' ')"
call lib1 GET /api/library >/dev/null
check "GET /api/library lists it in trash" 'py "[t[\"id\"] for t in r(\"lib1\")[\"trash\"]] == [\"sheen-chair\"]"'
code=$(call res POST /api/library/items/sheen-chair/restore)
after_entry=$(python3 -c "import json; print(json.dumps([i for i in json.load(open('$LIB/library.json'))['items'] if i['id']=='sheen-chair'][0], sort_keys=True))" 2>/dev/null)
check "L9 restore brings the item back byte for byte" '[ "$code" = 200 ] && [ "$(sha "$LIB/sheen-chair/model.glb")" = "$before_glb" ] && [ "$after_entry" = "$before_entry" ]' "$code $(head -c 200 "$OUT/r/res.json")"
check "restoring an id that exists again is 409" '[ "$(call res2 POST /api/library/items/sheen-chair/restore)" = 409 ]'
check "restoring an id that was never deleted is 404" '[ "$(call res3 POST /api/library/items/nope/restore)" = 404 ]'
check "W1 DELETE without X-Midstudy is 403" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/library/items/cube")" = 403 ] && [ -d "$LIB/cube" ]'

# --- what /library/ serves (W4) ------------------------------------------------------------------------------------------------------
call del2 DELETE /api/library/items/cube >/dev/null
T=$(cd "$LIB/.trash" && ls -d cube-* | head -n 1)
mkdir -p "$LIB/web-chair/raw" && echo raw >"$LIB/web-chair/raw/out.json"
check "W4 /library/costs.csv is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/costs.csv")" = 404 ]'
check "W4 /library/.trash/... is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/.trash/$T/model.glb")" = 404 ]'
check "W4 /library/<id>/raw/... is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/web-chair/raw/out.json")" = 404 ]'
check "W4 /library/.lock is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/.lock")" = 404 ]'
for trick in "/./library/costs.csv" "/planner/../library/costs.csv" "/%2e/library/costs.csv" "/library/./costs.csv" "/./library/web-chair/raw/out.json" "/./library/"; do
  check "W4 a dot-segment path ($trick) gets the same 404" '[ "$(curl -s --path-as-is -o /dev/null -w "%{http_code}" "$BASE$trick")" = 404 ]'
done
check "assets are served with nosniff" 'curl -s -D - -o /dev/null "$BASE/library/sheen-chair/model.glb" | grep -qi "x-content-type-options: nosniff"'
# verify round 1: a furniture photo's source.<ext> is the upload as given (EXIF, GPS): never served, any spelling
check "a photo item's source.jpg is 404 (it keeps the upload's metadata), its thumb.jpg is served" '[ -f "$LIB/phone-chair/source.jpg" ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/phone-chair/source.jpg")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/phone-chair/SOURCE.JPG")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/Library/phone-chair/source.jpg")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/phone-chair/thumb.jpg")" = 200 ]'
check "the upper-case /Library/costs.csv is 404 too (APFS is case-insensitive)" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/Library/costs.csv")" = 404 ]'
# verify round 1: what goes to fal for a photo add carries no EXIF/GPS, and is upright
evals/py evals/lib/metadata.py make --kind gps-jpeg --orientation 6 --from "$IMG" --out "$OUT/gps-chair.jpg" >"$OUT/gps-make.json" 2>&1
code=$(add gpsphoto image "$OUT/gps-chair.jpg" '{"name": "GPS Chair", "dims_cm": {"w": 75, "d": 80, "h": 95}, "engine": "sam3d"}')
st=$(wait_job gpsj "$(jid gpsphoto)")
evals/py evals/lib/metadata.py inspect "$LIB/gps-chair/raw/engine-input.jpg" >"$OUT/gps-sent.json" 2>&1
check "a photo with EXIF/GPS (orientation 6): what the engine uploads (raw/engine-input.jpg) has no metadata and is turned upright" '[ "$code" = 202 ] && [ "$st" = done ] && python3 -c "
import json,sys; m=json.loads(open(\"$OUT/gps-make.json\").read().strip().splitlines()[-1]); s=json.loads(open(\"$OUT/gps-sent.json\").read().strip().splitlines()[-1])
sys.exit(0 if s[\"clean\"] and (s[\"w\"], s[\"h\"]) == (m[\"h\"], m[\"w\"]) else 1)" && grep -q "engine-input.jpg" "$LIB/gps-chair/raw/request.json"' "$code $st $(tail -n 1 "$OUT/gps-sent.json" | head -c 300)"
check "library.json is still served" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/library.json")" = 200 ]'
# verify round 2: a GLB upload whose texture is a geotagged JPEG: the served model.glb carries no EXIF/GPS
evals/py evals/lib/metadata.py make --kind gps-glb --out "$OUT/gps-texture.glb" >/dev/null 2>&1
code=$(add gpsglb model "$OUT/gps-texture.glb" '{"name": "Glb Tex", "dims_cm": {"w": 50, "d": 50, "h": 50}, "engine": "glb"}')
st=$(wait_job gpsglbj "$(jid gpsglb)")
curl -s "$BASE/library/glb-tex/model.glb" -o "$OUT/glb-tex-served.glb"
evals/py evals/lib/metadata.py inspect "$OUT/glb-tex-served.glb" >"$OUT/glb-tex-served.json" 2>&1
check "a GLB with a GPS-tagged JPEG texture: /library/<id>/model.glb is served without the EXIF/GPS" '[ "$code" = 202 ] && [ "$st" = done ] && grep -q "\"clean\": true" "$OUT/glb-tex-served.json" && grep -q "\"glb_images\": \[{" "$OUT/glb-tex-served.json"' "$code $st $(tail -n 1 "$OUT/glb-tex-served.json" | head -c 300)"

# --- v1.1 (§2.8, §3.2, §4.5 Shows as): Idol is the default image engine; splat.spz is served as stored ------------------
code=$(add idolphoto image "$IMG" '{"name": "Idol Chair", "dims_cm": {"w": 80, "d": 90, "h": 95}, "prompt": "chair"}')
st=$(wait_job idolj "$(jid idolphoto)")
check "a photo upload with no engine is Idol: \$0.10 estimate, ends done with splat.ply, splat.spz and a stand-in GLB" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"idolphoto\")[\"cost_usd_estimate\"] == 0.1 and r(\"idolj\")[\"engine\"] == \"idol\" and r(\"idolj\")[\"item\"][\"assets\"][\"spz\"] == \"idol-chair/splat.spz\" and r(\"idolj\")[\"item\"][\"default_render\"] == \"splat\" and r(\"idolj\")[\"item\"][\"source\"][\"prompt\"] is None"' "$code $st $(head -c 400 "$OUT/r/idolj.json")"
check "…and the server never passed --prompt to an Idol add" '! grep -q "prompt" "$LIB/idol-chair/raw/request.json"'
curl -s -D "$OUT/spz.h" -o "$OUT/spz.bin" "$BASE/library/idol-chair/splat.spz"
check "/library/<id>/splat.spz is served as application/octet-stream, byte for byte as stored (no Content-Encoding)" 'grep -qi "^content-type: application/octet-stream" "$OUT/spz.h" && ! grep -qi "^content-encoding" "$OUT/spz.h" && grep -qi "^x-content-type-options: nosniff" "$OUT/spz.h" && cmp -s "$OUT/spz.bin" "$LIB/idol-chair/splat.spz"' "$(tr -d '\r' <"$OUT/spz.h" | tr '\n' ' ' | head -c 300)"
check "W4 an Idol item's source.jpg and raw/ stay 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/idol-chair/source.jpg")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/idol-chair/raw/response.json")" = 404 ] && [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/library/idol-chair/SPLAT.SPZ")" = 404 ]'
code=$(call idolglb PATCH /api/library/items/idol-chair '{"default_render": "glb"}')
check "PATCH default_render glb on an Idol item is 400 (its model.glb is a stand-in box)" '[ "$code" = 400 ]' "$code $(cat "$OUT/r/idolglb.json")"
c1=$(call samglb PATCH /api/library/items/phone-chair '{"default_render": "glb"}')
c2=$(call samsplat PATCH /api/library/items/phone-chair '{"default_render": "splat"}')
check "Shows as: PATCH default_render glb, then splat, on a SAM 3D item is 200 both times" '[ "$c1" = 200 ] && [ "$c2" = 200 ] && py "r(\"samglb\")[\"default_render\"] == \"glb\" and r(\"samsplat\")[\"default_render\"] == \"splat\""' "$c1 $c2 $(head -c 160 "$OUT/r/samglb.json")"
code=$(add badeng2 image "$IMG" '{"name": "X", "engine": "nope", "dims_cm": {"w": 1, "d": 1, "h": 1}}')
check "an unknown image engine is 400 and names idol among the choices" '[ "$code" = 400 ] && grep -q idol "$OUT/r/badeng2.json"' "$code $(cat "$OUT/r/badeng2.json")"
evals/py evals/validate_library.py "$LIB/library.json" >"$OUT/validate2.out" 2>&1
check "v1.1 items pass validate_library.py (stand-in box, per-axis splat, splat.spz)" '! grep -q FAIL "$OUT/validate2.out" && grep -q "^ok   idol-chair" "$OUT/validate2.out"' "$(grep FAIL "$OUT/validate2.out" | head -n 3 | tr '\n' ' ')"

# --- argv safety: a name starting with "-" still works ---------------------------------------------------------------------
code=$(add dash model fixtures/models/arrow.glb '{"name": "-Shelf", "id": "dash-shelf", "dims_cm": {"w": 40, "d": 20, "h": 10}}')
st=$(wait_job dashj "$(jid dash)")
check "a name starting with - is passed safely to midstudy-add" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"dashj\")[\"item\"][\"name\"] == \"-Shelf\""' "$code $st $(head -c 300 "$OUT/r/dashj.json")"

# --- spend cap (W2) ---------------------------------------------------------------------------------------------------------------------
stop_server
# Still mocked, no key, no .env: MIDSTUDY_FAL_MOCK_COST=1 only makes mock runs count at their price, so a
# $0.03 cap can be tested for $0.
MIDSTUDY_FAL_MOCK_COST=1 start_server --daily-spend-usd 0.03 || bad "server restarts with --daily-spend-usd"
call sp0 GET /api/spend >/dev/null
spent0=$(python3 -c "import json; print(json.load(open('$OUT/r/sp0.json')).get('spent_usd'))" 2>/dev/null)
check "GET /api/spend shows the day, cap and spend" 'py "r(\"sp0\")[\"cap_usd\"] == 0.03 and r(\"sp0\")[\"reserved_usd\"] == 0 and len(r(\"sp0\")[\"day\"]) == 10"' "$(cat "$OUT/r/sp0.json")"
code=$(add paid1 image "$IMG" '{"name": "Paid One", "dims_cm": {"w": 75, "d": 80, "h": 95}, "engine": "sam3d"}')
st=$(wait_job paid1j "$(jid paid1)")
check "W2 the first \$0.02 add under a \$0.03 cap goes through" '[ "$code" = 202 ] && [ "$st" = done ] && py "r(\"paid1j\")[\"cost_usd\"] == 0.02"' "$code $st $(head -c 300 "$OUT/r/paid1j.json")"
rows=$(wc -l <"$LIB/costs.csv")
code=$(add paid2 image "$IMG" '{"name": "Paid Two", "dims_cm": {"w": 75, "d": 80, "h": 95}, "engine": "sam3d"}')
check "W2 the second is refused with 402, no call, no row" '[ "$code" = 402 ] && py "\"spent_usd\" in r(\"paid2\") and r(\"paid2\")[\"cap_usd\"] == 0.03" && [ "$(wc -l <"$LIB/costs.csv")" = "$rows" ]' "$code $(cat "$OUT/r/paid2.json")"
python3 -c "
import base64; d = open('$IMG','rb').read()
open('$OUT/render.json','w').write('{\"image\": \"data:image/jpeg;base64,' + base64.b64encode(d).decode() + '\"}')"
code=$(curl -s -o "$OUT/r/render.json" -w '%{http_code}' -X POST -H 'X-Midstudy: 1' -H 'Content-Type: application/json' --data-binary "@$OUT/render.json" "$BASE/api/render")
check "W2 /api/render counts against the same cap (402)" '[ "$code" = 402 ]' "$code $(head -c 200 "$OUT/r/render.json")"
call sp1 GET /api/spend >/dev/null
check "GET /api/spend shows today's \$0.02 and nothing reserved" 'py "abs(r(\"sp1\")[\"spent_usd\"] - ($spent0 + 0.02)) < 1e-9 and r(\"sp1\")[\"reserved_usd\"] == 0"' "$(cat "$OUT/r/sp1.json")"
check "cost rows use their own lock file, next to costs.csv" '[ -e "$LIB/costs.csv.lock" ]'
check "the cap can't be changed from the page" '[ "$(call capset PUT /api/spend "{\"cap_usd\": 100}")" != 200 ] && py "True" && call sp2 GET /api/spend >/dev/null && py "r(\"sp2\")[\"cap_usd\"] == 0.03"'

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
