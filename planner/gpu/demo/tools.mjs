// Build and serve helpers for the WebGPU check's demo pages (planner/gpu/demo/), used by check.mjs and gltrace.mjs.
// - build(outDir): the wasm kernels (scripts/build.mjs --wasm-only), then esbuild (the project's, from node_modules)
//   bundles the demo entries and the sort worker into outDir as ES modules, three.js from node_modules (its WebGPU build
//   for 'three', as scripts/build.mjs), with the kernels' .wasm beside them.
// - serve(routes): a static file server on 127.0.0.1 (a secure context, so WebGPU is exposed) on a free port.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '../../..')

export const ENTRIES = ['planner/gpu/demo/demo.ts', 'planner/gpu/sort.worker.ts']

export async function build(outDir, { minify = false, entries = ENTRIES } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const t0 = Date.now()
  execFileSync(process.execPath, [path.join(REPO, 'scripts/build.mjs'), '--wasm-only', '--quiet'], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] })
  const esbuild = await import('esbuild')
  const threeWebGPU = { name: 'three-webgpu', setup(b) { b.onResolve({ filter: /^three$/ }, () => ({ path: path.join(REPO, 'node_modules/three/build/three.webgpu.js') })) } }
  await esbuild.build({
    absWorkingDir: REPO, entryPoints: entries.map((e) => path.join(REPO, e)), bundle: true, format: 'esm', target: 'es2022', platform: 'browser',
    outdir: outDir, entryNames: '[name]', sourcemap: true, logLevel: 'warning', minify, plugins: [threeWebGPU],
  })
  for (const f of fs.readdirSync(path.join(REPO, 'build/wasm/web')).filter((f) => f.endsWith('.wasm'))) fs.copyFileSync(path.join(REPO, 'build/wasm/web', f), path.join(outDir, f))
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
