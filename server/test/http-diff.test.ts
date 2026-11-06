// v1 and v2 side by side: planner/serve.py and node server/src/main.ts get the same scratch folders and the same
// requests (static paths, framing, the gate, unknown endpoints, GET /api/spend), and must give the same status,
// content type and JSON body. Routes v2 hasn't implemented yet are only compared where v1 answers before routing.
// Skipped when planner/serve.py is gone.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { utcDay } from '../../common/logic/time.ts'
import { bodyOf, mockEnv, REPO, request, SCRATCH, startServer, statusOf, tcp, type Answer, type Running } from './helpers.ts'

const V1 = path.join(REPO, 'planner/serve.py')
const skip = !fs.existsSync(V1) && 'planner/serve.py is gone'
const SCENE = 'scene-20261105-120000'

function populate(dir: string): void {
  const sd = path.join(dir, 'scenes', SCENE)
  fs.mkdirSync(sd, { recursive: true })
  for (const f of ['photo.jpg', 'depth.png', 'thumb.jpg', 'source.jpg', 'calib.json', 'scene.json']) fs.writeFileSync(path.join(sd, f), f)
  const item = path.join(dir, 'library', 'chair')
  fs.mkdirSync(path.join(item, 'raw'), { recursive: true })
  for (const f of ['model.glb', 'splat.spz', 'thumb.jpg', 'source.jpg']) fs.writeFileSync(path.join(item, f), f)
  fs.mkdirSync(path.join(dir, 'renders'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'renders', 'render-20261105-120000.jpg'), 'jpg')
  const day = utcDay(Date.now())
  fs.writeFileSync(path.join(dir, 'library', 'costs.csv'), 'date,id,engine,cost_usd,mock,input\n' + day + 'T01:00:00Z,a,sam3d,0.02,true,x\n' + day + 'T02:00:00Z,b,idol,0.1,false,"y,z"\n')
}

interface V1 {
  readonly base: string
  readonly port: number
  stop(): Promise<void>
}

async function startV1(dir: string): Promise<V1> {
  const lib = path.join(dir, 'library')
  const args = [V1, '--port', '0', '--scenes-dir', path.join(dir, 'scenes'), '--layouts-dir', path.join(dir, 'layouts'), '--renders-dir', path.join(dir, 'renders'),
    '--library-dir', lib, '--costs-file', path.join(lib, 'costs.csv'), '--calib', 'python3 fixtures/stub_calib.py', '--daily-spend-usd', '0.5', '--allowed-host', 'midstudy.example.com']
  const child: ChildProcess = spawn('python3', ['-I', ...args], { cwd: REPO, env: mockEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('v1 did not start: ' + out))
    }, 15000)
    child.stdout?.on('data', () => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/planner\//.exec(out)
      if (m?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
  })
  return {
    base: 'http://127.0.0.1:' + String(port),
    port,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve()
        })
      })
      child.kill('SIGTERM')
      await exited
    },
  }
}

let v1: V1 | null = null
let v2: Running | null = null

before(async () => {
  if (skip !== false) return
  v2 = await startServer({ name: 'diff-v2', args: ['--daily-spend-usd', '0.5', '--allowed-host', 'midstudy.example.com'], env: { MIDSTUDY_STRICT: '1' } })
  populate(v2.dir)
  const d1 = path.join(SCRATCH, 'diff-v1-' + String(process.pid))
  fs.rmSync(d1, { recursive: true, force: true })
  populate(d1)
  v1 = await startV1(d1)
})

after(async () => {
  await v1?.stop()
  await v2?.stop()
})

function shape(a: Answer): unknown {
  const ctype = (a.headers['content-type'] ?? '').replace(/\s/g, '').toLowerCase()
  return { status: a.status, ctype, body: ctype.startsWith('application/json') ? a.json : null, nosniff: a.headers['x-content-type-options'], location: a.headers.location ?? null }
}

const GETS = ['/', '/planner', '/planner/', '/planner/index.html', '/planner/index.html/', '/planner/dist', '/planner/nope.js', '/planner/styles/kit.css', '/planner/icon.svg',
  '/planner/manifest.webmanifest', '/planner?x=1', '/library/library.json', '/library/costs.csv', '/library/chair/model.glb', '/library/chair/splat.spz', '/library/chair/source.jpg',
  '/library/chair/raw/', '/Library/costs.csv', '/./library/costs.csv', '/scenes/' + SCENE + '/photo.jpg', '/scenes/' + SCENE + '/source.jpg', '/scenes/' + SCENE + '/calib.json',
  '/scenes/' + SCENE + '/', '/scenes/', '/renders/render-20261105-120000.jpg', '/renders/', '/renders/x/', '/README.md', '/.env', '/%2Eenv', '/x', '//planner/', '/api', '/api/',
  '/api/nope', '/api/spend', '/api/spend?x=1', '/%61pi/spend', '/planner/%2e%2e/README.md', '/fixtures/scenes/living-wide/truth.json', '/planner/../library/costs.csv']

void test('static and API GETs: v2 answers as v1', { skip }, async () => {
  if (v1 === null || v2 === null) return
  const problems: string[] = []
  for (const p of GETS) {
    for (const method of ['GET', 'HEAD']) {
      const a1 = shape(await request(v1.base, method, p))
      const a2 = shape(await request(v2.base, method, p))
      try {
        assert.deepStrictEqual(a2, a1)
      } catch {
        problems.push(method + ' ' + p + ': v2 ' + JSON.stringify(a2) + ', v1 ' + JSON.stringify(a1))
      }
    }
  }
  assert.deepEqual(problems, [])
})

const MUTATIONS: readonly (readonly [string, string])[] = [['POST', '/api/scenes'], ['PUT', '/api/scenes/' + SCENE], ['DELETE', '/api/scenes/' + SCENE], ['POST', '/api/render'],
  ['PUT', '/api/layouts/a?scene=' + SCENE], ['PATCH', '/api/library/items/chair'], ['POST', '/api/library/items/from-url'], ['POST', '/api/library/product'], ['PUT', '/planner/x'],
  ['POST', '/planner/x'], ['DELETE', '/x'], ['PATCH', '/api/nope'], ['POST', '/api/nope'], ['PUT', '/api/nope'], ['DELETE', '/api/scenes/jobs'], ['PUT', '/api/scenes/jobs']]

void test('the gate and the fallbacks: v2 answers as v1 (forged, foreign Origin, foreign Host, unknown routes)', { skip }, async () => {
  if (v1 === null || v2 === null) return
  const problems: string[] = []
  const variants: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['no X-Midstudy', {}],
    ['foreign Origin', { 'X-Midstudy': '1', Origin: 'http://evil.example' }],
    ['X-Midstudy: 2', { 'X-Midstudy': '2' }],
    ['foreign Host', { 'X-Midstudy': '1', Host: 'evil.example' }],
    ['allowed Host, its Origin', { 'X-Midstudy': '1', Host: 'midstudy.example.com', Origin: 'http://midstudy.example.com' }],
  ]
  for (const [m, p] of MUTATIONS) {
    for (const [label, headers] of variants) {
      const a1 = shape(await request(v1.base, m, p, { headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }))
      const a2 = shape(await request(v2.base, m, p, { headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }))
      const routed = label.startsWith('allowed') && !p.includes('nope') && !p.endsWith('/jobs') && p.startsWith('/api')
      if (routed) continue // past the gate: v2's stub answers 501 where v1 runs the route
      try {
        assert.deepStrictEqual(a2, a1)
      } catch {
        problems.push(m + ' ' + p + ' (' + label + '): v2 ' + JSON.stringify(a2) + ', v1 ' + JSON.stringify(a1))
      }
    }
  }
  assert.deepEqual(problems, [])
})

void test('framing: v2 answers as v1 (Content-Length, Host)', { skip }, async () => {
  if (v1 === null || v2 === null) return
  const cases: readonly string[] = [
    'POST /api/scenes HTTP/1.1\r\nHost: H\r\nX-Midstudy: 1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx',
    // v1 reads the first length's body before its 403 (here at once; without a body it waited the 30 s socket timeout, v2 answers at once)
    'POST /api/scenes HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nxx',
    'POST /api/scenes HTTP/1.1\r\nHost: H\r\nX-Midstudy: 1\r\nContent-Length: \xb2\r\n\r\n',
    'POST /api/scenes HTTP/1.1\r\nHost: H\r\nX-Midstudy: 1\r\nContent-Length: +5\r\n\r\n',
    'POST /api/scenes HTTP/1.1\r\nHost: H\r\nX-Midstudy: 1\r\nContent-Length: 1234567890123456\r\n\r\n',
    'GET /api/spend HTTP/1.1\r\nHost: 127.0.0.1:80@evil.example\r\n\r\n',
    'GET /api/spend HTTP/1.1\r\nHost: [::1]evil.example\r\n\r\n',
    'GET /api/spend HTTP/1.1\r\nHost: localhost:9.evil.example\r\n\r\n',
    'GET /api/spend HTTP/1.0\r\n\r\n',
    'GET /api/spend HTTP/1.1\r\n\r\n',
    'GET /api/spend HTTP/1.1\r\nHost: localhost:9\r\n\r\n',
    'GET /library/costs.csv HTTP/1.1\r\nHost: evil.example\r\n\r\n',
  ]
  const problems: string[] = []
  for (const c of cases) {
    const ask = async (port: number): Promise<unknown> => {
      const t = await tcp(port, c.replace('Host: H', 'Host: 127.0.0.1:' + String(port)), { waitMs: 3000, untilClose: false })
      let body: unknown = null
      try {
        body = JSON.parse(bodyOf(t.text))
      } catch {
        body = null
      }
      return { status: statusOf(t.text), body }
    }
    const a1 = await ask(v1.port)
    const a2 = await ask(v2.port)
    try {
      assert.deepStrictEqual(a2, a1)
    } catch {
      problems.push(JSON.stringify(c.split('\r\n').slice(0, 4)) + ': v2 ' + JSON.stringify(a2) + ', v1 ' + JSON.stringify(a1))
    }
  }
  assert.deepEqual(problems, [])
})
