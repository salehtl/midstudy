// §2.9 URL fetches and Page fetches (server/src/fetch.ts) against local servers: v1's image fetch sentences, private
// addresses refused before any connection (a canary port records any), every redirect re-checked and at most 3, 20 MB,
// image/* only, the one MIDSTUDY_FETCH_ALLOW exemption; and the general reader the product page uses (redirects,
// gzip/deflate within the limit, the cut, the same-origin rule, the budget).
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Budget, fetchImage, FetchError, FetchFailed, originOf, PRIVATE, safeFetch, WEB_PAGE, type SafeFetchOptions } from '../src/fetch.ts'
import { SCRATCH } from './helpers.ts'

const DIR = path.join(SCRATCH, 'fetch-' + String(process.pid))
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)])
let port = 0
let canaryPort = 0
let canaryHits = 0
const servers: (http.Server | net.Server)[] = []

const listen = (s: http.Server | net.Server): Promise<number> => new Promise((resolve) => {
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    resolve(typeof a === 'object' && a !== null ? a.port : 0)
  })
})

before(async () => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  const canary = net.createServer((sock) => {
    canaryHits += 1
    sock.destroy()
  })
  canaryPort = await listen(canary)
  servers.push(canary)
  const big = Buffer.alloc(21 * 1024 * 1024, 1)
  const page = Buffer.from('<html><body>' + 'size 200 x 90 cm '.repeat(200) + '</body></html>')
  const web = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const redirect = (to: string): void => {
      res.writeHead(302, { Location: to })
      res.end()
    }
    if (url === '/chair.jpg') res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG)
    else if (url === '/chair.png') res.writeHead(200, { 'Content-Type': 'image/png; charset=binary' }).end(JPEG)
    else if (url === '/weird') res.writeHead(200, { 'Content-Type': 'image/x-thing' }).end(JPEG)
    else if (url === '/page.html') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<html></html>')
    else if (url === '/text') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('hi')
    else if (url === '/untyped') res.writeHead(200).end('x')
    else if (url === '/empty') res.writeHead(200, { 'Content-Type': 'image/png' }).end()
    else if (url === '/declared-big') res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(21 * 1024 * 1024) }).end()
    else if (url === '/big') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end(big)
    } else if (url === '/redir-ok') redirect('http://127.0.0.1:' + String(port) + '/chair.jpg')
    else if (url === '/redir-relative') redirect('chair.jpg')
    else if (url === '/redir-private') redirect('http://127.0.0.1:' + String(canaryPort) + '/x')
    else if (url === '/redir-file') redirect('file:///etc/passwd')
    else if (url.startsWith('/hop')) {
      const n = Number(url.slice(4))
      if (n <= 0) res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG)
      else redirect('/hop' + String(n - 1))
    } else if (url === '/noloc') res.writeHead(302).end()
    else if (url === '/missing') res.writeHead(404, { 'Content-Type': 'text/html' }).end('no')
    else if (url === '/gzip') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }).end(zlib.gzipSync(page))
    else if (url === '/deflate') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' }).end(zlib.deflateSync(page))
    else if (url === '/deflate-raw') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' }).end(zlib.deflateRawSync(page))
    else if (url === '/brotli') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' }).end(zlib.brotliCompressSync(page))
    else if (url === '/plain') res.writeHead(200, { 'Content-Type': 'text/html' }).end(page)
    else if (url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      const t = setInterval(() => res.write('x'), 100)
      res.on('close', () => {
        clearInterval(t)
      })
    } else if (url === '/to-other-origin') redirect('http://localhost:' + String(port) + '/plain')
    else res.writeHead(404).end()
  })
  port = await listen(web)
  servers.push(web)
})

after(async () => {
  for (const s of servers) {
    if (s instanceof http.Server) s.closeAllConnections()
    await new Promise((resolve) => s.close(resolve))
  }
  fs.rmSync(DIR, { recursive: true, force: true })
})

const allow = (): string => '127.0.0.1:' + String(port)
const web = (p: string): string => 'http://127.0.0.1:' + String(port) + p
const messageOf = async (url: string): Promise<string> => {
  try {
    await fetchImage(url, DIR, allow())
    return 'ok'
  } catch (e) {
    if (e instanceof FetchError) return e.message
    throw e
  }
}

void describe('v1\'s image fetch (from-URL adds)', () => {
  void test('an image downloads to download.<ext> by its Content-Type, also through a redirect (absolute or relative)', async () => {
    const a = await fetchImage(web('/chair.jpg'), DIR, allow())
    assert.equal(path.basename(a), 'download.jpg')
    assert.deepEqual(fs.readFileSync(a), JPEG)
    assert.equal(path.basename(await fetchImage(web('/redir-ok'), DIR, allow())), 'download.jpg')
    assert.equal(path.basename(await fetchImage(web('/redir-relative'), DIR, allow())), 'download.jpg')
    assert.equal(path.basename(await fetchImage(web('/chair.png'), DIR, allow())), 'download.png')
    assert.equal(path.basename(await fetchImage(web('/weird'), DIR, allow())), 'download.img')
    assert.equal(path.basename(await fetchImage(web('/hop3'), DIR, allow())), 'download.jpg')
  })
  void test('v1\'s sentences for what it refuses', async () => {
    assert.equal(await messageOf(web('/page.html')), WEB_PAGE)
    assert.equal(await messageOf(web('/text')), "that link isn't an image (it's text/plain): paste the image's own link")
    assert.equal(await messageOf(web('/untyped')), "that link isn't an image (it's untyped): paste the image's own link")
    assert.equal(await messageOf(web('/empty')), 'the link returned an empty file')
    assert.equal(await messageOf(web('/declared-big')), 'that image is over 20 MB: use a smaller one')
    assert.equal(await messageOf(web('/big')), 'that image is over 20 MB: use a smaller one')
    assert.equal(await messageOf(web('/missing')), 'the link answered HTTP 404: check it opens the image in a browser')
    assert.equal(await messageOf(web('/noloc')), 'the link redirects (HTTP 302) without saying where')
    assert.equal(await messageOf(web('/hop4')), "the link redirects more than 3 times: paste the image's own link")
    assert.equal(await messageOf('file:///etc/passwd'), "only http and https links work: paste the image's web address")
    assert.equal(await messageOf(web('/redir-file')), "only http and https links work: paste the image's web address")
    assert.equal(await messageOf('http:///x'), 'that link has no host name')
    assert.equal(await messageOf('http://127.0.0.1:abc/x'), "that link's port isn't a number")
    assert.equal(await messageOf('http://[::1/x'), "that link isn't a valid web address: paste the image's web address")
  })
  void test('W3: private addresses are refused before any connection, in every spelling, and after a redirect', async () => {
    const before = canaryHits
    for (const u of ['http://127.0.0.1:' + String(canaryPort) + '/x', 'http://localhost:' + String(canaryPort) + '/x', 'http://[::ffff:127.0.0.1]:' + String(canaryPort) + '/x',
      'http://[::1]:' + String(canaryPort) + '/x', 'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.100/x.jpg', 'http://10.0.0.1/x', 'http://0.0.0.0:' + String(canaryPort) + '/',
      'http://[fe80::1]/x', 'http://2130706433:' + String(canaryPort) + '/', web('/redir-private')]) {
      assert.equal(await messageOf(u), PRIVATE, u)
    }
    assert.equal(canaryHits, before, 'the canary was never connected to')
  })
  void test('the exemption is exactly one host and port: without it the stand-in web is private too', async () => {
    await assert.rejects(fetchImage(web('/chair.jpg'), DIR, ''), (e: unknown) => e instanceof FetchError && e.message === PRIVATE)
    await assert.rejects(fetchImage(web('/chair.jpg'), DIR, '127.0.0.1:' + String(port + 1)), FetchError)
    await assert.rejects(fetchImage('http://localhost:' + String(port) + '/chair.jpg', DIR, allow()), FetchError)
  })
  void test('a name that doesn\'t resolve', async () => {
    assert.equal(await messageOf('http://midstudy-test.invalid/x.jpg'), "couldn't find midstudy-test.invalid: check the link")
  })
})

void describe('the general reader (product pages and feeds)', () => {
  const page = (o: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    budget: new Budget(20000), maxRedirects: 5, maxBytes: 10 * 1024 * 1024, overflow: 'cut', decode: true, headers: { 'User-Agent': 'midstudy/1.0 (product page reader)' }, allow: allow(), ...o,
  })
  const failure = async (url: string, o: Partial<SafeFetchOptions>): Promise<string> => {
    try {
      await safeFetch(url, page(o))
      return 'ok'
    } catch (e) {
      if (e instanceof FetchFailed) return e.failure.kind
      throw e
    }
  }
  void test('gzip and deflate (zlib-wrapped or raw) bodies are decoded; plain ones read as sent', async () => {
    const plain = await safeFetch(web('/plain'), page())
    for (const p of ['/gzip', '/deflate', '/deflate-raw']) {
      const r = await safeFetch(web(p), page())
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, plain.body, p)
      assert.equal(r.cut, false)
    }
    assert.equal(await failure(web('/brotli'), {}), 'encoding')
  })
  void test('over maxBytes: the first maxBytes and cut (decoded size counts), or too-large', async () => {
    for (const p of ['/plain', '/gzip']) {
      const r = await safeFetch(web(p), page({ maxBytes: 1000 }))
      assert.equal(r.body.length, 1000)
      assert.equal(r.cut, true)
    }
    assert.equal(await failure(web('/plain'), { maxBytes: 1000, overflow: 'error' }), 'too-large')
  })
  void test('a status other than 200 comes back without its body; the final URL follows redirects', async () => {
    const r = await safeFetch(web('/missing'), page())
    assert.equal(r.status, 404)
    assert.equal(r.body.length, 0)
    const hop = await safeFetch(web('/hop5'), page())
    assert.equal(hop.url, web('/hop0'))
    assert.equal(await failure(web('/hop6'), {}), 'too-many-redirects')
  })
  void test('a feed kept to its page\'s origin; the budget stops a trickle', async () => {
    assert.equal(originOf('HTTPS://Shop.Example:443/a?b'), 'https://shop.example:443')
    assert.equal(await failure(web('/to-other-origin'), { sameOrigin: originOf(web('/x')) }), 'cross-origin')
    assert.equal((await safeFetch(web('/plain'), page({ sameOrigin: originOf(web('/')) }))).status, 200)
    const t0 = Date.now()
    assert.equal(await failure(web('/slow'), { budget: new Budget(400) }), 'timeout')
    assert.ok(Date.now() - t0 < 2000)
  })
})
