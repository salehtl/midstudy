// Build and serve helpers for the WebGPU spike's demo pages (planner/gpu/demo/), used by check.mjs.
// - build(outDir): esbuild (from the flake's pinned nixpkgs, no global install) bundles the demo entries and the sort
//   worker into outDir as ES modules, three.js from node_modules.
// - serve(routes): a static file server on 127.0.0.1 (a secure context, so WebGPU is exposed) on a free port.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '../../..')
const NP = 'github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c'
let esbuildBin = null
function esbuild() {
  if (!esbuildBin) {
    const out = execFileSync('nix', ['build', '--no-link', '--print-out-paths', `${NP}#esbuild`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()
    esbuildBin = path.join(out, 'bin/esbuild')
  }
  return esbuildBin
}

export const ENTRIES = ['planner/gpu/demo/probe.ts', 'planner/gpu/demo/demo.ts', 'planner/gpu/sort-worker.ts']

export function build(outDir, { minify = false, entries = ENTRIES } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const t0 = Date.now()
  const present = entries.filter((e) => fs.existsSync(path.join(REPO, e)))
  execFileSync(esbuild(), [...present, '--bundle', '--format=esm', '--target=es2022', '--platform=browser', `--outdir=${outDir}`,
    '--entry-names=[name]', '--sourcemap', '--log-level=warning', ...(minify ? ['--minify'] : [])], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] })
  const sizes = Object.fromEntries(fs.readdirSync(outDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.statSync(path.join(outDir, f)).size]))
  return { ms: Date.now() - t0, sizes }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.glb': 'model/gltf-binary', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream' }

// routes: { '/prefix/': '/abs/dir' }. Never serves outside a route's directory.
export function serve(routes) {
  const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const hit = entries.find(([p]) => url.pathname.startsWith(p))
    if (!hit) { res.writeHead(404).end('no route'); return }
    const rel = decodeURIComponent(url.pathname.slice(hit[0].length))
    const file = path.resolve(hit[1], rel)
    if (!file.startsWith(path.resolve(hit[1]) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) })
  }))
}
