// What every route module gets (server/src/http/router.ts): the server's resolved configuration, the spend cap, and a
// way to finish work before the server exits. The rest of the infrastructure is imported directly (see
// docs/notes/server-core.md): common/lock.ts, common/costs.ts, common/fal.ts, common/files.ts, server/src/fetch.ts,
// server/src/jobs.ts, server/src/tools.ts, server/src/strict.ts, server/src/logic/*, common/logic/*.
import type { SpendCap } from './spend.ts'

/** The server's flags (contract §2.1, §4.4), resolved: every path absolute (relative ones against the repository,
 *  `~` expanded), the commands split once (shlex) into argument lists. */
export interface ServerConfig {
  /** The repository root (tools run here, as v1's cwd=REPO). */
  readonly repo: string
  readonly host: string
  /** The port listened on (the real one when --port was 0). */
  readonly port: number
  readonly scenesDir: string
  readonly layoutsDir: string
  readonly rendersDir: string
  readonly libraryDir: string
  /** Always `<libraryDir>/costs.csv` (main.ts refuses any other --costs-file). */
  readonly costsFile: string
  /** --calib, split (never empty). */
  readonly calib: readonly string[]
  /** --midstudy-add, split (never empty). */
  readonly midstudyAdd: readonly string[]
  /** null: the app's Settings set the budget (<library>/settings.json, §2.9) */
  readonly dailySpendUsd: number | null
  /** The --allowed-host values as given (already checked to be `name[:port]`). */
  readonly allowedHosts: readonly string[]
  /** MIDSTUDY_SOCKET_TIMEOUT (default 30), in seconds: how long one read may wait. */
  readonly socketTimeoutSeconds: number
}

/** Handed to every route module's `routes(deps)`. */
export interface ServerDeps {
  readonly config: ServerConfig
  /** The daily cap: reserve before a paid call, release after (GET /api/spend reads it). */
  readonly spend: SpendCap
  /** Registers work to finish when the server stops (SIGINT/SIGTERM), e.g. closing a calibration worker's stdin;
   *  all of it gets 5 s together. */
  readonly onShutdown: (fn: () => Promise<void>) => void
}
