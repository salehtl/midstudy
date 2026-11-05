// A local stand-in for shops on the web, on one port, for the product page evals (contract §2.11). serve.py reaches it
// through MIDSTUDY_FETCH_ALLOW=127.0.0.1:<port> (the one private address it may fetch; everything else stays refused).
//
//   syntheticPages()              → { routes, cases, refused, dir }   from fixtures/product-pages/manifest.json
//   snapshotPages(golden)         → { routes, dir }                   the golden set's saved pages in fixtures/pages/<id>/
//   startPagesServer({routes,dir}) → { base, port, hits, stop() }    hits: [{method, path, query, headers}] in order
//
// A route: { path | prefix, query?: {k: v}, status = 200, type?, file? (relative to dir) | body? | generate?, location?, headers? }.
// Generators: jpeg, hops (/hops/{n}), line (/line/{n}), slow, trickle, huge, gzip, gzip-bomb, digits, deep (see manifest.json's notes).
// Shops' real pages (fixtures/pages/) are git-ignored and never committed; fixtures/product-pages/ is made up.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const REPO = path.resolve(import.meta.dirname, '../..')
const SYNTH = path.join(REPO, 'fixtures/product-pages')
const SNAP = path.join(REPO, 'fixtures/pages')

export function syntheticPages() {
  const m = JSON.parse(fs.readFileSync(path.join(SYNTH, 'manifest.json'), 'utf8'))
  return { routes: m.routes, cases: m.cases, refused: m.refused_urls, dir: SYNTH }
}

// Routes that replay the golden set's snapshots: the page at its real path, plus the feeds saved next to it
// (shopify.js → <path>.js, shopify.json → <path>.json, store.json → the WooCommerce Store API for its slug).
export function snapshotPages(golden) {
  const routes = []
  for (const g of golden.pages) {
    const d = path.join(SNAP, g.id)
    if (!fs.existsSync(path.join(d, 'page.html'))) continue
    const u = new URL(g.url)
    const p = u.pathname
    routes.push({ path: p, file: `${g.id}/page.html`, status: g.snapshot_status || 200 })
    const bare = p.replace(/\/$/, '')
    if (fs.existsSync(path.join(d, 'shopify.js'))) routes.push({ path: `${bare}.js`, file: `${g.id}/shopify.js`, type: 'text/javascript; charset=utf-8' })
    if (fs.existsSync(path.join(d, 'shopify.json'))) routes.push({ path: `${bare}.json`, file: `${g.id}/shopify.json`, type: 'application/json; charset=utf-8' })
    if (fs.existsSync(path.join(d, 'store.json'))) {
      const slug = bare.split('/').filter(Boolean).pop()
      routes.push({ path: '/wp-json/wc/store/v1/products', query: { slug }, file: `${g.id}/store.json`, type: 'application/json; charset=utf-8' })
    }
  }
  return { routes, dir: SNAP }
}

const DESK_HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>Oak Writing Desk</title>' +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Oak Writing Desk",' +
  '"image":"https://cdn.nordwood.example/img/oak-desk-front.jpg","width":{"@type":"QuantitativeValue","value":120,"unitCode":"CMT"},' +
  '"depth":{"@type":"QuantitativeValue","value":60,"unitCode":"CMT"},"height":{"@type":"QuantitativeValue","value":75,"unitCode":"CMT"}}</script></head><body>'
const TINY_JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')

function typeFor(file) {
  const ext = path.extname(file).toLowerCase()
  return { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[ext] || 'application/octet-stream'
}

function match(routes, url) {
  for (const r of routes) {
    if (r.prefix) { if (url.pathname.startsWith(r.prefix)) return r; continue }
    if (r.path.includes('{n}')) {
      const re = new RegExp(`^${r.path.replace('{n}', '(\\d+)')}$`)
      const m = url.pathname.match(re)
      if (m) return { ...r, n: Number(m[1]) }
      continue
    }
    if (r.path !== url.pathname) continue
    if (r.query && !Object.entries(r.query).every(([k, v]) => url.searchParams.get(k) === v)) continue
    return r
  }
  return null
}

export async function startPagesServer({ routes, dir }) {
  const hits = []
  const timers = new Set()
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn() }, ms); timers.add(t); return t }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    hits.push({ method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers } })
    res.on('error', () => {})
    const r = match(routes, url)
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>no such page</body></html>'); return }
    const head = { ...(r.headers || {}) }
    if (r.location) head.Location = r.location
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'content-length': body.length, ...head }); res.end(body) }
    if (r.generate === 'jpeg') return send(200, 'image/jpeg', TINY_JPEG)
    if (r.generate === 'line') {
      // one size line on a minimal product page: /line/{n} shows route.lines[n] ({text, title?})
      const ln = (r.lines || [])[r.n]
      if (!ln) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body>no such line</body></html>') }
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      const title = ln.title || `Test piece ${r.n}`
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<meta property="og:title" content="${esc(title)}"><meta property="og:image" content="/media/line-${r.n}.jpg"></head>` +
        `<body><h1>${esc(title)}</h1><p>${esc(ln.text)}</p></body></html>`))
    }
    if (r.generate === 'digits') {
      // CPU, not network: a 12,000-digit run and 20,000 escaped quotes in an unterminated script string
      return send(200, 'text/html; charset=utf-8', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Digits Chair</title>' +
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Digits Chair","image":"/media/digits-chair.jpg","size":"W 50 x D 50 x H 80 cm"}</script>' +
        '<script>var s = "' + '\\"'.repeat(20000) + '</script></head><body><h1>Digits Chair</h1><p>' + '1'.repeat(12000) + '</p></body></html>'))
    }
    if (r.generate === 'deep') return send(200, 'application/json', Buffer.from('['.repeat(200000) + ']'.repeat(200000)))
    if (r.generate === 'hops') {
      if (r.n > 0) { res.writeHead(302, { Location: `/hops/${r.n - 1}`, 'content-length': 0 }); return res.end() }
      return send(200, 'text/html; charset=utf-8', Buffer.from(DESK_HEAD + '</body></html>'))
    }
    if (r.generate === 'slow') { later(() => { if (!res.writableEnded) send(200, 'text/html; charset=utf-8', Buffer.from(DESK_HEAD + '</body></html>')) }, 25000); return }
    if (r.generate === 'trickle') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.write(DESK_HEAD)
      let i = 0
      const tick = () => { if (res.writableEnded || res.destroyed || i++ > 60) { if (!res.writableEnded) res.end(); return } res.write(' '); later(tick, 1000) }
      later(tick, 1000)
      return
    }
    if (r.generate === 'huge') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.write(DESK_HEAD)
      const chunk = Buffer.from('<p>filler filler filler filler filler filler filler filler filler filler</p>\n'.repeat(13000)) // ~1 MB
      let left = 12
      const pump = () => {
        while (left > 0) { left--; if (!res.write(chunk)) return res.once('drain', pump) }
        res.end('</body></html>')
      }
      req.socket.on('close', () => { left = 0 })
      return pump()
    }
    if (r.generate === 'gzip') {
      const body = zlib.gzipSync(fs.readFileSync(path.join(SYNTH, 'pages/jsonld-cm.html')))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': body.length })
      return res.end(body)
    }
    if (r.generate === 'gzip-bomb') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      const gz = zlib.createGzip({ level: 9 })
      gz.on('error', () => {})
      gz.pipe(res)
      gz.write(DESK_HEAD)
      const spaces = Buffer.alloc(1 << 20, 0x20)
      let left = 200
      const pump = () => {
        while (left > 0) { left--; if (!gz.write(spaces)) return gz.once('drain', pump) }
        gz.end('</body></html>')
      }
      req.socket.on('close', () => { left = 0; gz.destroy() })
      return pump()
    }
    if (r.file) return send(r.status || 200, r.type || typeFor(r.file), fs.readFileSync(path.join(dir, r.file)))
    return send(r.status || 200, r.type || 'text/html; charset=utf-8', Buffer.from(r.body ?? ''))
  })
  server.keepAliveTimeout = 1000
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port, base: `http://127.0.0.1:${port}`, hits,
    stop: () => new Promise((resolve) => { for (const t of timers) clearTimeout(t); server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
