// midstudy's server (contract §2.1, §4.4): `node server/src/main.ts`, with v1's flags and startup refusals (v1 was
// planner/serve.py, deleted at the v2 cutover).
//
//   node server/src/main.ts [--port 8765] [--host 127.0.0.1] [--scenes-dir scenes] [--layouts-dir layouts]
//                           [--renders-dir renders] [--rooms-dir rooms] [--library-dir library] [--costs-file <library-dir>/costs.csv]
//                           [--calib "uv run --project calib --extra rooms midstudy-calib"]
//                           [--midstudy-add "node pipeline/src/cli.ts"] [--daily-spend-usd N]
//                           [--allowed-host NAME ...]
//
// Relative paths are resolved against the repository. FAL_KEY comes from the environment, else from <repo>/.env
// (unless MIDSTUDY_NO_DOTENV=1). MIDSTUDY_FAL_MOCK makes every fal call a mock; MIDSTUDY_STRICT=1 checks every answer
// and written file against the contract's schemas; MIDSTUDY_SOCKET_TIMEOUT (evals) shortens the 30 s socket timeout;
// MIDSTUDY_FETCH_ALLOW=<host>:<port> (evals) lets the URL fetcher reach that one address.
import os from 'node:os'
import path from 'node:path'
import { hostName } from '../../core/js/node.ts'
import { falMock } from '../../common/fal.ts'
import { resolvePath as pathResolve } from '../../common/files.ts'
import { pyFloat } from '../../common/logic/csv.ts'
import type { ServerConfig, ServerDeps } from './deps.ts'
import type { ApiRoute } from './http/router.ts'
import { createServer } from './http/server.ts'
import { allowedHostProblem, costsFileProblem, help, parseCli, spendProblem, usage } from './logic/cli.ts'
import { SpendCap } from './spend.ts'
import { startCap } from './logic/spend.ts'
import { readJsonFile } from '../../common/files.ts'
import { enableStrict, strictRequested } from './strict.ts'
import { killAllTools, liveToolPids, splitCommand } from '../../common/tools.ts'
import { routes as libraryRoutes } from './routes/library.ts'
import { routes as layoutsRoutes } from './routes/layouts.ts'
import { routes as renderRoutes } from './routes/render.ts'
import { routes as roomsRoutes } from './routes/rooms.ts'
import { routes as scenesRoutes } from './routes/scenes.ts'
import { routes as spendRoutes } from './routes/spend.ts'
import { routes as productRoutes } from './product/route.ts'

/** The repository root (server/src/main.ts → ../..). */
const REPO = path.resolve(import.meta.dirname, '../..')
const PROG = 'main.ts'
/** How long the stop waits for requests, tools and hooks: the tools' 5 s kill grace plus room for their 'close' and
 *  a cost row; under the eval harness's own stop ladder. */
const STOP_LIMIT_MS = 7000

/** The /api route modules, in v1's order (within a method the first full match wins). */
function allRoutes(deps: ServerDeps): readonly ApiRoute[] {
  return [
    ...scenesRoutes(deps),
    ...roomsRoutes(deps),
    ...layoutsRoutes(deps),
    ...renderRoutes(deps),
    ...libraryRoutes(deps),
    ...productRoutes(deps),
    ...spendRoutes(deps),
  ]
}

/** The daily cap: --daily-spend-usd's (fixed), else the app's Settings in <library>/settings.json, else $2 (§2.9). */
function spendCap(costsFile: string, flag: number | null, settingsFile: string): SpendCap {
  const { cap, locked } = startCap(flag, flag === null ? readJsonFile(settingsFile) : null)
  return new SpendCap(costsFile, cap, Date.now, { file: settingsFile, locked })
}

function fail(message: string, code = 2): never {
  process.stderr.write(usage(PROG) + PROG + ': error: ' + message + '\n')
  process.exit(code)
}

/** v1 `resolve`: `~` expanded, a relative path against the repository. */
function resolvePath(p: string): string {
  const expanded = p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(REPO, expanded)
}


async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseCli(argv)
  if (parsed.kind === 'help') {
    process.stdout.write(help(PROG))
    process.exit(0)
  }
  if (parsed.kind === 'error') fail(parsed.message)
  const o = parsed.options
  const spend = spendProblem(o.dailySpendUsd)
  if (spend !== null) fail(spend)
  const calib = splitCommand(o.calib)
  if (!calib.ok) fail('argument --calib: ' + calib.error)
  if (calib.argv.length === 0) fail("--calib can't be empty")
  const add = splitCommand(o.midstudyAdd)
  if (!add.ok) fail('argument --midstudy-add: ' + add.error)
  if (add.argv.length === 0) fail("--midstudy-add can't be empty")
  const allowedHostNames: string[] = []
  for (const h of o.allowedHosts) {
    // The same rule as a Host header (§2.9): exactly name[:port]. A URL or a typo would otherwise add "" to the
    // allowlist, which a request with no Host, or a malformed one, would match.
    const name = hostName(h)
    if (name === null) fail(allowedHostProblem(h))
    allowedHostNames.push(name)
  }
  const libraryDir = resolvePath(o.libraryDir ?? 'library')
  const costsFile = o.costsFile === null ? path.join(libraryDir, 'costs.csv') : resolvePath(o.costsFile)
  // midstudy-add always writes <library-dir>/costs.csv, so the cap would miss its rows (library adds would be
  // unlimited) if this read another file: refuse any other --costs-file (§2.9 W2).
  if (pathResolve(costsFile) !== pathResolve(path.join(libraryDir, 'costs.csv'))) {
    process.stderr.write(costsFileProblem(costsFile, path.join(libraryDir, 'costs.csv')) + '\n')
    process.exit(1)
  }
  const timeoutText = process.env['MIDSTUDY_SOCKET_TIMEOUT'] ?? ''
  const socketTimeoutSeconds = timeoutText === '' ? 30 : pyFloat(timeoutText)
  if (socketTimeoutSeconds === null || !Number.isFinite(socketTimeoutSeconds) || socketTimeoutSeconds <= 0) {
    process.stderr.write('midstudy planner: MIDSTUDY_SOCKET_TIMEOUT must be a number of seconds, not ' + JSON.stringify(timeoutText) + '\n')
    process.exit(1)
  }
  if (strictRequested()) await enableStrict()

  const hooks: (() => Promise<void>)[] = []
  const config: ServerConfig = {
    repo: REPO,
    host: o.host,
    port: o.port,
    scenesDir: resolvePath(o.scenesDir),
    roomsDir: resolvePath(o.roomsDir),
    layoutsDir: resolvePath(o.layoutsDir),
    rendersDir: resolvePath(o.rendersDir),
    libraryDir,
    costsFile,
    calib: calib.argv,
    midstudyAdd: add.argv,
    dailySpendUsd: o.dailySpendUsd,
    allowedHosts: o.allowedHosts,
    socketTimeoutSeconds,
  }
  const deps: ServerDeps = {
    config,
    spend: spendCap(costsFile, o.dailySpendUsd, path.join(libraryDir, 'settings.json')),
    onShutdown: (fn) => {
      hooks.push(fn)
    },
  }
  const server = createServer({
    routes: allRoutes(deps),
    staticDirs: { planner: path.join(REPO, 'planner'), library: libraryDir, scenes: config.scenesDir, renders: config.rendersDir },
    allowedHostNames,
    socketTimeoutSeconds,
    log: (line) => {
      process.stderr.write(line + '\n')
    },
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch((e: unknown) => {
    process.stderr.write('midstudy planner: can\'t listen on ' + o.host + ':' + String(o.port) + ': ' + (e instanceof Error ? e.message : String(e)) + '\n')
    process.exit(1)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : o.port
  process.stdout.write('midstudy planner: http://' + o.host + ':' + String(port) + '/planner/  (serving ' + REPO + ')\n')
  if (falMock()) process.stdout.write('midstudy planner: MIDSTUDY_FAL_MOCK is set, so Render makes no fal calls and costs $0\n')

  let stopping = false
  // Requests still open, for the line the stop logs when it gives up waiting. While stopping, a connection whose
  // request just ended is closed as soon as it is idle (else a keep-alive one would hold the close for its timeout).
  let openRequests = 0
  server.on('request', (_req, res) => {
    openRequests += 1
    res.once('close', () => {
      openRequests -= 1
      if (stopping) {
        setImmediate(() => {
          server.closeIdleConnections()
        })
      }
    })
  })
  // The stop (SIGINT/SIGTERM): no new connections, idle ones closed, requests in flight allowed to finish (a render
  // between its fal answer and its cost row); every tool ended (SIGTERM, SIGKILL after 5 s) behind killAllTools'
  // latch, so the library queue can't start the next job's tool; the shutdown hooks run. All of it under one limit,
  // after which what is still pending is named, the connections cut and the process exits (common/tools.ts' 'exit'
  // handler SIGKILLs any tool left). A second signal exits at once.
  const stop = (): void => {
    if (stopping) process.exit(0)
    stopping = true
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    server.closeIdleConnections()
    const toolsGone = killAllTools()
    const unsettled = new Set<number>()
    const hookRuns = hooks.map((fn, i) => {
      unsettled.add(i + 1)
      return Promise.resolve().then(fn).finally(() => unsettled.delete(i + 1))
    })
    const finish = Promise.allSettled([Promise.allSettled(hookRuns), serverClosed, toolsGone]).then(() => true)
    const limit = new Promise<boolean>((resolve) => setTimeout(resolve, STOP_LIMIT_MS, false).unref())
    void Promise.race([finish, limit]).then((clean) => {
      if (!clean) {
        const pids = liveToolPids()
        process.stderr.write('midstudy server: stopping after ' + String(STOP_LIMIT_MS / 1000) + ' s with ' + String(openRequests) + ' request(s) open, tool pid(s) ' +
          (pids.length === 0 ? 'none' : pids.join(' ')) + ', shutdown hook(s) ' + (unsettled.size === 0 ? 'none' : [...unsettled].join(' ')) + ' unsettled\n')
        server.closeAllConnections()
      }
      process.exit(0)
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // v1's handler threads died alone; here a stray failure is logged and the server keeps serving.
  process.on('uncaughtException', (e) => {
    process.stderr.write('midstudy server: uncaught: ' + (e.stack ?? e.message) + '\n')
  })
  process.on('unhandledRejection', (e) => {
    process.stderr.write('midstudy server: unhandled rejection: ' + (e instanceof Error ? e.stack ?? e.message : String(e)) + '\n')
  })
}

await main(process.argv.slice(2))
