// `node server/src/main.ts` as the evals start it: v1's startup refusals, the static allowlist (contract §2.1, §2.8,
// §4.4; E1's W4 spellings and evals/library_api.sh's), GET /api/spend, every route implemented, and strict mode on.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { utcDay } from '../../common/logic/time.ts'
import { api, mockEnv, REPO, request, SCRATCH, startServer, type Running } from './helpers.ts'

const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const r = spawnSync(process.execPath, ['server/src/main.ts', ...args], { cwd: REPO, env: mockEnv(env), encoding: 'utf8', timeout: 20000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

void describe('startup (v1\'s flags and refusals)', () => {
  void test('a malformed --allowed-host (a URL) is refused at startup', () => {
    const r = run(['--port', '0', '--daily-spend-usd', '0', '--allowed-host', 'https://midstudy.example.com'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--allowed-host 'https:\/\/midstudy\.example\.com' isn't a host name: give it as name or name:port/)
  })
  void test('a --costs-file that isn\'t <library-dir>/costs.csv is refused (exit 1), with or without --library-dir', () => {
    const other = path.join(SCRATCH, 'other-costs.csv')
    for (const extra of [[], ['--library-dir', path.join(SCRATCH, 'lib')]]) {
      const r = run(['--port', '0', '--daily-spend-usd', '0', '--costs-file', other, ...extra])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^midstudy planner: --costs-file .* isn't .*costs\.csv, where midstudy-add writes its costs: drop --costs-file/)
    }
  })
  void test('a negative or non-numeric cap, an empty --calib, unknown flags: argparse\'s exit 2 with usage', () => {
    for (const [args, want] of [[['--daily-spend-usd', '-1'], "--daily-spend-usd can't be negative"], [['--daily-spend-usd', 'nan'], 'must be a finite number'],
      [['--daily-spend-usd', 'x'], "argument --daily-spend-usd: invalid float value: 'x'"], [['--calib', ''], "--calib can't be empty"], [['--calib', '"open'], 'No closing quotation'],
      [['--midstudy-add', ' '], "--midstudy-add can't be empty"], [['--bogus'], 'unrecognized arguments: --bogus'], [['--port', 'x'], "argument --port: invalid int value: 'x'"],
      [['--l', 'x'], 'ambiguous option: --l could match --library-dir, --layouts-dir']] as const) {
      const r = run([...args])
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /^usage: main\.ts/)
      assert.ok(r.stderr.includes('main.ts: error: ' + want) || r.stderr.includes(want), r.stderr)
    }
  })
  void test('-h prints the help and exits 0', () => {
    const r = run(['-h'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /--daily-spend-usd DAILY_SPEND_USD/)
  })
  void test('a bad MIDSTUDY_SOCKET_TIMEOUT is refused', () => {
    const r = run(['--port', '0', '--daily-spend-usd', '0'], { MIDSTUDY_SOCKET_TIMEOUT: 'soon' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /MIDSTUDY_SOCKET_TIMEOUT/)
  })
})

let srv: Running
const SCENE = 'scene-20261105-120000'

before(async () => {
  srv = await startServer({ name: 'static', args: ['--daily-spend-usd', '0.03'], env: { MIDSTUDY_STRICT: '1' } })
  const sd = path.join(srv.scenes, SCENE)
  fs.mkdirSync(path.join(sd), { recursive: true })
  for (const f of ['photo.jpg', 'depth.png', 'thumb.jpg', 'source.jpg', 'calib.json', 'lighting.json', 'scene.json']) fs.writeFileSync(path.join(sd, f), f)
  fs.mkdirSync(path.join(srv.scenes, '.trash', 'old'), { recursive: true })
  fs.writeFileSync(path.join(srv.scenes, '.trash', 'old', 'photo.jpg'), 'x')
  const item = path.join(srv.library, 'chair')
  fs.mkdirSync(path.join(item, 'raw'), { recursive: true })
  for (const f of ['model.glb', 'splat.ply', 'splat.spz', 'thumb.jpg', 'source.jpg']) fs.writeFileSync(path.join(item, f), f)
  fs.writeFileSync(path.join(item, 'raw', 'out.json'), '{}')
  fs.mkdirSync(path.join(srv.library, '.trash', 'chair-1'), { recursive: true })
  fs.writeFileSync(path.join(srv.library, '.trash', 'chair-1', 'model.glb'), 'x')
  fs.writeFileSync(path.join(srv.library, '.lock'), '')
  fs.writeFileSync(path.join(srv.renders, 'render-20261105-120000.jpg'), 'jpg')
  fs.writeFileSync(path.join(srv.renders, '.hidden.jpg'), 'x')
  fs.mkdirSync(path.join(srv.renders, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(srv.renders, 'sub', 'x.jpg'), 'x')
  const day = utcDay(Date.now())
  fs.writeFileSync(srv.costs, 'date,id,engine,cost_usd,mock,input\n' + day + 'T01:00:00Z,a,sam3d,0.02,true,x\n' + day + 'T02:00:00Z,b,idol,0.005,true,y\n2000-01-01T00:00:00Z,c,idol,0.1,false,z\n')
})

after(async () => {
  await srv.stop()
})

const statusOf = async (p: string, method = 'GET'): Promise<number> => (await request(srv.base, method, p)).status

void describe('static: an allowlist, whatever the spelling (§2.1, §2.8, §2.9 W4, §4.4)', () => {
  void test('the planner: /planner/ (index.html), its files, a folder redirected to its slash, a file with a slash still served (v1)', async () => {
    const index = await request(srv.base, 'GET', '/planner/')
    assert.equal(index.status, 200)
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(index.headers['x-content-type-options'], 'nosniff')
    assert.equal(index.headers['cache-control'], 'no-store, must-revalidate')
    assert.ok(index.headers['last-modified'] !== undefined)
    const r = await request(srv.base, 'GET', '/planner?scene=x')
    assert.equal(r.status, 301)
    assert.equal(r.headers.location, '/planner/?scene=x')
    assert.equal((await request(srv.base, 'GET', '/')).headers.location, '/planner/')
    assert.equal(await statusOf('/planner/index.html/'), 200)
    assert.equal(await statusOf('/planner/manifest.webmanifest'), 200)
    assert.equal((await request(srv.base, 'GET', '/planner/manifest.webmanifest')).headers['content-type'], 'application/manifest+json')
    const head = await request(srv.base, 'HEAD', '/planner/index.html')
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.ok(Number(head.headers['content-length']) > 0)
  })
  void test('If-Modified-Since at or after the file\'s time → 304', async () => {
    const a = await request(srv.base, 'GET', '/planner/index.html', { headers: { 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() } })
    assert.equal(a.status, 304)
    const b = await request(srv.base, 'GET', '/planner/index.html', { headers: { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' } })
    assert.equal(b.status, 200)
  })
  void test('a scene serves photo.jpg, depth.png and thumb.jpg (and a ?v= cache buster), nothing else', async () => {
    for (const f of ['photo.jpg', 'depth.png', 'thumb.jpg']) assert.equal(await statusOf('/scenes/' + SCENE + '/' + f + '?v=1'), 200, f)
    assert.equal((await request(srv.base, 'GET', '/scenes/' + SCENE + '/depth.png')).headers['content-type'], 'image/png')
    const A = SCENE
    for (const p of [`/scenes/${A}/source.jpg`, `/scenes/${A}/calib.json`, `/scenes/${A}/lighting.json`, `/scenes/${A}/%6Cighting.json`, `/./scenes/${A}/lighting.json`, `/scenes/${A}/scene.json`,
      `/scenes/${A}/`, `/scenes/${A}`, '/scenes/', '/scenes', '/scenes/.trash/', '/scenes/.trash/old/photo.jpg', `/scenes/${A}/nothing.jpg`, `/./scenes/${A}/source.jpg`,
      `/planner/../scenes/${A}/calib.json`, `/%2e/scenes/${A}/source.jpg`, `/scenes/${A}/./source.jpg`, `/scenes/${A}/%73ource.jpg`, `/scenes/${A}/photo.jpg/../scene.json`,
      `/scenes/%2e%2e/scenes/${A}/source.jpg`, `/scenes/${A}/%2e%2e/${A}/calib.json`, `/Scenes/${A}/photo.jpg`, `/SCENES/${A}/calib.json`, `/scenes/${A}/Photo.JPG`,
      `/scenes/${A}/photo.jpg/`, `/scenes/${A}/%252e%252e/calib.json`]) {
      assert.equal(await statusOf(p), 404, p)
    }
  })
  void test('a library serves library.json and item assets; never costs.csv, .trash/, raw/, .lock or source.* (library_api.sh W4)', async () => {
    assert.equal(await statusOf('/library/library.json'), 200)
    assert.deepEqual((await request(srv.base, 'GET', '/library/library.json')).json, { version: 1, items: [] })
    for (const f of ['model.glb', 'splat.ply', 'splat.spz', 'thumb.jpg']) assert.equal(await statusOf('/library/chair/' + f), 200, f)
    const spz = await request(srv.base, 'GET', '/library/chair/splat.spz')
    assert.equal(spz.headers['content-type'], 'application/octet-stream')
    assert.equal(spz.headers['content-encoding'], undefined)
    assert.equal((await request(srv.base, 'GET', '/library/chair/model.glb')).headers['content-type'], 'model/gltf-binary')
    for (const p of ['/library/costs.csv', '/library/.trash/chair-1/model.glb', '/library/chair/raw/out.json', '/library/.lock', '/./library/costs.csv', '/planner/../library/costs.csv',
      '/%2e/library/costs.csv', '/library/./costs.csv', '/./library/chair/raw/out.json', '/./library/', '/library/', '/library/chair/source.jpg', '/library/chair/SOURCE.JPG',
      '/Library/chair/source.jpg', '/Library/costs.csv', '/LIBRARY/library.json/../costs.csv', '/library/chair/SPLAT.SPZ', '/library/chair', '/library/chair/']) {
      assert.equal(await statusOf(p), 404, p)
    }
    fs.writeFileSync(path.join(srv.library, 'library.json'), '{"version": 1, "items": [{"id": "x"}]}')
    const served = await request(srv.base, 'GET', '/library/library.json')
    assert.equal(served.text, '{"version": 1, "items": [{"id": "x"}]}')
    assert.equal(served.headers['content-type'], 'application/json; charset=utf-8')
    fs.rmSync(path.join(srv.library, 'library.json'))
  })
  void test('renders are served by name, one segment, no dot files', async () => {
    assert.equal(await statusOf('/renders/render-20261105-120000.jpg'), 200)
    for (const p of ['/renders/', '/renders/.hidden.jpg', '/renders/sub/x.jpg', '/renders/nope.jpg', '/renders']) assert.equal(await statusOf(p), 404, p)
  })
  void test('nothing else in the repository is served: the user\'s photos, scratch scenes, tracked files, .env (E1 verify round 1)', async () => {
    const rel = path.relative(REPO, srv.scenes)
    for (const p of [`/${rel}/${SCENE}/source.jpg`, `/${rel.toUpperCase()}/${SCENE}/source.jpg`, '/fixtures/photos/notes.md', '/Fixtures/photos/notes.md', '/fixtures/PHOTOS/notes.md',
      '/fixtures/Photos/private/x.jpg', '/fixtures/scenes/living-wide/truth.json', '/README.md', '/CLAUDE.md', '/package.json', '/flake.nix', '/.env', '/%2Eenv', '/contract/CONTRACT.md',
      '/evals/out/', '/AD9729E1-593E-4443-9BCD-B0519A7265F1_1_201_a', '/IMG_0007.tiff', '/Downloads/IMG_0005.jpeg', '/planner/../.env', '/planner/%2e%2e/.env', '/x%00y', '/a\\b']) {
      assert.equal(await statusOf(p), 404, p)
    }
  })
})

void describe('the API', () => {
  void test('GET /api/spend: today\'s total from costs.csv, nothing reserved, the cap (strict mode passes it)', async () => {
    const a = await request(srv.base, 'GET', '/api/spend')
    assert.equal(a.status, 200)
    assert.deepEqual(a.json, { day: utcDay(Date.now()), spent_usd: 0.025, reserved_usd: 0, cap_usd: 0.03 })
  })
  void test('the cap can\'t be changed from the page', async () => {
    assert.equal((await api(srv.base, 'PUT', '/api/spend', { cap_usd: 100 })).status, 404)
    assert.equal((await api(srv.base, 'POST', '/api/spend', { cap_usd: 100 })).status, 404)
  })
  void test('every /api route is implemented (none answers 501), and every mutation is 403 without X-Midstudy', async () => {
    for (const [m, p] of [['GET', '/api/scenes'], ['GET', '/api/scenes/jobs'], ['GET', '/api/scenes/' + SCENE], ['POST', '/api/scenes'], ['PUT', '/api/scenes/' + SCENE],
      ['PUT', '/api/scenes/x/thumb'], ['POST', '/api/scenes/x/calibrate'], ['POST', '/api/scenes/x/light'], ['POST', '/api/scenes/x/restore'], ['DELETE', '/api/scenes/x'],
      ['GET', '/api/layouts?scene=x'], ['GET', '/api/layouts/a?scene=x'], ['PUT', '/api/layouts/a?scene=x'], ['DELETE', '/api/layouts/a?scene=x'], ['POST', '/api/render'],
      ['GET', '/api/renders'], ['GET', '/api/library'], ['GET', '/api/library/jobs'], ['GET', '/api/library/jobs/l-1'], ['POST', '/api/library/items'],
      ['POST', '/api/library/items/from-url'], ['POST', '/api/library/product'], ['PATCH', '/api/library/items/x'], ['DELETE', '/api/library/items/x'],
      ['POST', '/api/library/items/x/restore'], ['PUT', '/api/library/items/x/thumb']] as const) {
      if (m === 'GET') {
        const a = await request(srv.base, m, p)
        assert.notEqual(a.status, 501, m + ' ' + p)
        continue
      }
      // the gate first: without X-Midstudy nothing reaches the route (§2.9 Forged requests); past it, the route answers
      assert.equal((await request(srv.base, m, p, { body: '{}' })).status, 403, m + ' ' + p)
      assert.notEqual((await api(srv.base, m, p, {})).status, 501, m + ' ' + p)
    }
    assert.equal((await api(srv.base, 'PUT', '/api/scenes/jobs', {})).status, 404)
    assert.equal((await api(srv.base, 'DELETE', '/api/scenes/jobs')).status, 404)
  })
})
