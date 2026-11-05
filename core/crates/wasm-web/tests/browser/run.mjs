// Runs page.ts in headless Chrome ($PUPPETEER_EXECUTABLE_PATH, the harness's BROWSER_ARGS) on http://127.0.0.1 (a
// free port), serving the bundles from evals/out/k-geom/browser/ (run.sh builds them), build/wasm/web/ and
// fixtures/scenes/. Prints one PASS/FAIL line per check; exit 1 on any FAIL.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { BROWSER_ARGS, freePort } from '../../../../../evals/lib/harness.mjs'

const REPO = path.resolve(import.meta.dirname, '../../../../..')
const OUT = path.join(REPO, 'evals/out/k-geom/browser')
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.html': 'text/html' }
const route = (u) => {
  if (u === '/') return path.join(OUT, 'index.html')
  if (u.startsWith('/wasm/')) return path.join(REPO, 'build/wasm/web', path.basename(u))
  const m = u.match(/^\/scenes\/([a-z-]+)\/([a-z.]+)$/)
  if (m) return path.join(REPO, 'fixtures/scenes', m[1], m[2])
  return path.join(OUT, path.basename(u))
}
fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>')
const server = http.createServer((req, res) => {
  const f = route(new URL(req.url, 'http://x').pathname)
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
})
const port = await freePort()
await new Promise((r) => server.listen(port, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: BROWSER_ARGS })
let failed = 0
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.__results, null, { timeout: 120000 })
  const results = await page.evaluate(() => window.__results)
  console.log(`browser: ${await browser.version()}`)
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`) }
  for (const e of errors) console.log(`page error: ${e}`)
  if (errors.length) failed++
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
