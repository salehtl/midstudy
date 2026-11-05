// Runs bench.ts in headless Chrome ($PUPPETEER_EXECUTABLE_PATH with the harness's BROWSER_ARGS, never a browser
// someone browses with) on http://127.0.0.1 (a free port), once per build under test, rounds interleaved so an A/B
// sees the same machine load. A build is a directory holding core/js/web.ts and build/wasm/web/ (the repository
// itself, or a snapshot of an earlier one). Result: the median over rounds of each task's median, in ms.
//
//   nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/browser/bench-run.mjs \
//       [--rounds 3] [--build label=dir ...] [--out evals/out/kh/browser-bench.json]
//
// Without --build it measures the repository (label "now"). Bundles go to evals/out/kh/browser/<label>/ (esbuild from
// node_modules).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { BROWSER_ARGS, freePort } from '../../../../../evals/lib/harness.mjs'

const REPO = path.resolve(import.meta.dirname, '../../../../..')
const argv = process.argv.slice(2)
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const ROUNDS = Number(opt('--rounds', 3))
const OUT = path.resolve(REPO, opt('--out', 'evals/out/kh/browser-bench.json'))
const builds = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--build') continue
  const [label, dir] = (argv[i + 1] ?? '').split('=')
  if (label && dir) builds.push({ label, dir: path.resolve(REPO, dir) })
}
if (!builds.length) builds.push({ label: 'now', dir: REPO })

const BUNDLES = path.join(REPO, 'evals/out/kh/browser')
const page = fs.readFileSync(path.join(import.meta.dirname, 'bench.ts'), 'utf8')
for (const b of builds) {
  const face = path.join(b.dir, 'core/js/web.ts')
  const wasm = path.join(b.dir, 'build/wasm/web/midstudy_wasm_web_bg.wasm')
  if (!fs.existsSync(face) || !fs.existsSync(wasm)) { console.error(`bench-run: ${b.label}: no ${face} or ${wasm}`); process.exit(2) }
  b.wasm = wasm
  b.out = path.join(BUNDLES, b.label)
  fs.mkdirSync(b.out, { recursive: true })
  // The page lives next to this file (its ../v1/ imports resolve there); only the face's path changes per build.
  const entry = path.join(import.meta.dirname, `.bench-${b.label}-${process.pid}.ts`)
  fs.writeFileSync(entry, page.replace("'__FACE__'", JSON.stringify(face)))
  try {
    const r = spawnSync(path.join(REPO, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', '--target=es2022', `--outfile=${path.join(b.out, 'page.js')}`, '--log-level=warning'], { cwd: REPO, encoding: 'utf8' })
    if (r.status !== 0) { console.error(`bench-run: esbuild failed for ${b.label}:\n${r.stderr}`); process.exit(1) }
  } finally {
    fs.rmSync(entry, { force: true })
  }
  fs.writeFileSync(path.join(b.out, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="page.js"></script>')
}

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.html': 'text/html' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname
  let f = null
  const m = u.match(/^\/b\/([a-z0-9-]+)\/(.*)$/)
  const b = m && builds.find((x) => x.label === m[1])
  if (b) f = m[2] === 'wasm/midstudy_wasm_web_bg.wasm' ? b.wasm : path.join(b.out, path.basename(m[2] || 'index.html'))
  const s = u.match(/^\/scenes\/([a-z-]+)\/([a-z.]+)$/)
  if (s) f = path.join(REPO, 'fixtures/scenes', s[1], s[2])
  if (!f || !fs.existsSync(f)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
})
const port = await freePort()
await new Promise((r) => server.listen(port, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: BROWSER_ARGS })
const samples = new Map()
let version = ''
try {
  version = await browser.version()
  for (let r = 0; r < ROUNDS; r++) {
    for (const b of builds) {
      const ctx = await browser.newContext()
      const p = await ctx.newPage()
      const errors = []
      p.on('pageerror', (e) => errors.push(String(e)))
      await p.goto(`http://127.0.0.1:${port}/b/${b.label}/`)
      await p.waitForFunction(() => window.__bench, null, { timeout: 600000 })
      const res = await p.evaluate(() => window.__bench)
      await ctx.close()
      if (res.error || errors.length) { console.error(`bench-run: ${b.label}: ${res.error ?? ''} ${errors.join('; ')}`); process.exitCode = 1 }
      for (const row of res.rows) {
        const key = `${row.task}\t${row.impl}`
        if (!samples.has(key)) samples.set(key, {})
        ;(samples.get(key)[b.label] ??= []).push(row.ms)
      }
    }
  }
} finally {
  await browser.close()
  server.close()
}
const med = (xs) => { const s = [...(xs ?? [])].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const rows = []
console.log(`${'task'.padEnd(36)} ${'impl'.padEnd(28)} ${builds.map((b) => b.label.padStart(10)).join(' ')}`)
for (const [key, byBuild] of samples) {
  const [task, impl] = key.split('\t')
  const ms = Object.fromEntries(builds.map((b) => [b.label, med(byBuild[b.label])]))
  rows.push({ task, impl, ms })
  console.log(`${task.padEnd(36)} ${impl.padEnd(28)} ${builds.map((b) => (ms[b.label] === null ? '-' : ms[b.label].toFixed(2)).padStart(10)).join(' ')}`)
}
const meta = { date: new Date().toISOString(), browser: version, load: os.loadavg(), cpus: os.cpus().length, rounds: ROUNDS, builds: builds.map((b) => ({ label: b.label, dir: path.relative(REPO, b.dir) || '.', wasm_bytes: fs.statSync(b.wasm).size })) }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ meta, rows }, null, 1))
console.log(`${version}; load ${meta.load.map((v) => v.toFixed(1)).join(' ')}; written to ${path.relative(REPO, OUT)}`)
