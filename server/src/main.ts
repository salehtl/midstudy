// midstudy's server (contract §2.1, §4.4; v2 of planner/serve.py): `node server/src/main.ts` with exactly v1's
// flags, defaults and startup refusals.
//
//   node server/src/main.ts [--port 8765] [--host 127.0.0.1] [--scenes-dir scenes] [--layouts-dir layouts]
//                           [--renders-dir renders] [--library-dir library] [--costs-file <library-dir>/costs.csv]
//                           [--calib "uv run --project calib midstudy-calib"]
//                           [--midstudy-add "uv run --project pipeline midstudy-add"] [--daily-spend-usd 2]
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
import { enableStrict, strictRequested } from './strict.ts'
import { splitCommand } from '../../common/tools.ts'
import { routes as libraryRoutes } from './routes/library.ts'
import { routes as layoutsRoutes } from './routes/layouts.ts'
import { routes as renderRoutes } from './routes/render.ts'
import { routes as scenesRoutes } from './routes/scenes.ts'
import { routes as spendRoutes } from './routes/spend.ts'
import { routes as productRoutes } from './product/route.ts'

/** The repository root (server/src/main.ts → ../..). */
const REPO = path.resolve(import.meta.dirname, '../..')
const PROG = 'main.ts'

/** The /api route modules, in v1's order (within a method the first full match wins). */
function allRoutes(deps: ServerDeps): readonly ApiRoute[] {
  return [
    ...scenesRoutes(deps),
    ...layoutsRoutes(deps),
    ...renderRoutes(deps),
    ...libraryRoutes(deps),
    ...productRoutes(deps),
    ...spendRoutes(deps),
  ]
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
    spend: new SpendCap(costsFile, o.dailySpendUsd),
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
  const stop = (): void => {
    if (stopping) return
    stopping = true
    server.close()
    server.closeAllConnections()
    const finish = Promise.allSettled(hooks.map((fn) => fn()))
    const limit = new Promise((resolve) => setTimeout(resolve, 5000).unref())
    void Promise.race([finish, limit]).then(() => {
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
