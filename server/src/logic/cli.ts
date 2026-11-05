// The server's command line (contract §2.1, §4.4): v1's flags, defaults and argparse's rules (`--flag value` and
// `--flag=value`, unambiguous prefixes, the last value wins, `--allowed-host` repeats) and its error sentences.
// Pure (TScert); server/src/main.ts prints and exits.
import { pyRepr } from '../../../common/logic/pyfmt.ts'
import { pyFloat } from '../../../common/logic/csv.ts'

/** v1's default --calib. */
export const DEFAULT_CALIB = 'uv run --project calib midstudy-calib'
/** v1's default --midstudy-add. */
export const DEFAULT_MIDSTUDY_ADD = 'uv run --project pipeline midstudy-add'

/** The parsed flags, before paths are resolved. */
export interface CliOptions {
  readonly port: number
  readonly host: string
  readonly scenesDir: string
  readonly libraryDir: string | null
  readonly layoutsDir: string
  readonly rendersDir: string
  readonly costsFile: string | null
  readonly calib: string
  readonly midstudyAdd: string
  readonly allowedHosts: readonly string[]
  readonly dailySpendUsd: number
}

/** What the command line asks for: run with these options, print the help, or stop with argparse's message. */
export type CliParse =
  | { readonly kind: 'run'; readonly options: CliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

type Flag = '--port' | '--host' | '--scenes-dir' | '--library-dir' | '--layouts-dir' | '--renders-dir' | '--costs-file'
  | '--calib' | '--midstudy-add' | '--allowed-host' | '--daily-spend-usd' | '--help'

const FLAGS: readonly Flag[] = ['--help', '--port', '--host', '--scenes-dir', '--library-dir', '--layouts-dir', '--renders-dir',
  '--costs-file', '--calib', '--midstudy-add', '--allowed-host', '--daily-spend-usd']

/** argparse's usage line for v1's flags. */
export function usage(prog: string): string {
  return 'usage: ' + prog + ' [-h] [--port PORT] [--host HOST] [--scenes-dir SCENES_DIR] [--library-dir LIBRARY_DIR]\n'
    + '       [--layouts-dir LAYOUTS_DIR] [--renders-dir RENDERS_DIR] [--costs-file COSTS_FILE] [--calib CALIB]\n'
    + '       [--midstudy-add MIDSTUDY_ADD] [--allowed-host NAME] [--daily-spend-usd DAILY_SPEND_USD]\n'
}

/** argparse's help text. */
export function help(prog: string): string {
  return usage(prog) + '\nmidstudy planner server\n\noptions:\n'
    + '  -h, --help            show this help message and exit\n'
    + '  --port PORT\n'
    + '  --host HOST\n'
    + "  --scenes-dir SCENES_DIR\n                        the scenes (one folder per uploaded photo; default: the repo's scenes/)\n"
    + "  --library-dir LIBRARY_DIR\n                        serve /library/ from here (default: the repo's library/)\n"
    + '  --layouts-dir LAYOUTS_DIR\n'
    + '  --renders-dir RENDERS_DIR\n'
    + '  --costs-file COSTS_FILE\n                        default: <library-dir>/costs.csv, where midstudy-add writes its rows; if\n                        given, it must be that file\n'
    + '  --calib CALIB         the calibration command, run as an argument list (default: ' + DEFAULT_CALIB + ')\n'
    + '  --midstudy-add MIDSTUDY_ADD\n                        the command that adds furniture, run with --library <library-dir>\n                        (default: ' + DEFAULT_MIDSTUDY_ADD + ')\n'
    + '  --allowed-host NAME   also answer requests with this Host name, e.g. midstudy.example.com (repeatable;\n                        loopback names always work)\n'
    + '  --daily-spend-usd DAILY_SPEND_USD\n                        cap on paid fal calls (library adds and renders) per UTC day, in USD\n                        (default 2)\n'
}

/** Python's `int(s)` for ASCII text: surrounding whitespace, a sign, `_` between digits; null where it raises. */
export function pyInt(s: string): number | null {
  const t = s.trim()
  if (!/^[+-]?\d(?:_?\d)*$/.test(t)) return null
  return parseInt(t.replace(/_/g, ''), 10)
}

/** argparse's guess that a word is a negative number (`-1`, `-.5`), which it reads as a value, not an option. */
function negativeNumber(s: string): boolean {
  return /^-\d+$|^-\d*\.\d+$/.test(s)
}

/** How argparse reads one word (`_parse_optional`): a value, one of our flags (with an `=value`), an unknown option,
 *  or an ambiguous prefix (an error wherever it stands). */
type Word =
  | { readonly kind: 'value' }
  | { readonly kind: 'flag'; readonly flag: Flag; readonly explicit: string | null }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly message: string }

function exactFlag(s: string): Flag | null {
  if (s === '-h') return '--help'
  return FLAGS.find((f) => f === s) ?? null
}

function classify(word: string): Word {
  if (word === '' || !word.startsWith('-')) return { kind: 'value' }
  const exact = exactFlag(word)
  if (exact !== null) return { kind: 'flag', flag: exact, explicit: null }
  if (word.length === 1) return { kind: 'value' }
  const eq = word.indexOf('=')
  const name = eq >= 0 ? word.slice(0, eq) : word
  const explicit = eq >= 0 ? word.slice(eq + 1) : null
  const named = eq >= 0 ? exactFlag(name) : null
  if (named !== null) return { kind: 'flag', flag: named, explicit }
  if (word.startsWith('--')) {
    const matches = FLAGS.filter((f) => f.startsWith(name))
    const only = matches[0]
    if (matches.length > 1) return { kind: 'ambiguous', message: 'ambiguous option: ' + word + ' could match ' + matches.join(', ') }
    if (matches.length === 1 && only !== undefined) return { kind: 'flag', flag: only, explicit }
  } else if (word.startsWith('-h')) {
    return { kind: 'flag', flag: '--help', explicit: word.slice(2) }
  }
  if (negativeNumber(word) || word.includes(' ')) return { kind: 'value' }
  return { kind: 'unknown' }
}

/** argparse over v1's flags. Values are checked later (main.ts): only their types here. */
export function parseCli(argv: readonly string[]): CliParse {
  let port = 8765
  let host = '127.0.0.1'
  let scenesDir = 'scenes'
  let libraryDir: string | null = null
  let layoutsDir = 'layouts'
  let rendersDir = 'renders'
  let costsFile: string | null = null
  let calib = DEFAULT_CALIB
  let midstudyAdd = DEFAULT_MIDSTUDY_ADD
  const allowedHosts: string[] = []
  let dailySpendUsd = 2
  const extra: string[] = []
  const dash = argv.indexOf('--')
  const words = dash < 0 ? argv : argv.slice(0, dash)
  const kinds = words.map(classify)
  for (const k of kinds) {
    if (k.kind === 'ambiguous') return { kind: 'error', message: k.message }
  }
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    const k = kinds[i] ?? { kind: 'value' }
    i += 1
    if (k.kind === 'value' || k.kind === 'unknown' || k.kind === 'ambiguous') {
      extra.push(word)
      continue
    }
    const flag = k.flag
    if (flag === '--help') {
      if (k.explicit !== null) return { kind: 'error', message: 'argument -h/--help: ignored explicit argument ' + pyRepr(k.explicit) }
      return { kind: 'help' }
    }
    let value: string
    if (k.explicit !== null) {
      value = k.explicit
    } else {
      const next = words[i]
      const nextKind = kinds[i]
      if (next === undefined || nextKind?.kind !== 'value') {
        return { kind: 'error', message: 'argument ' + flag + ': expected one argument' }
      }
      value = next
      i += 1
    }
    switch (flag) {
      case '--port': {
        const n = pyInt(value)
        if (n === null) return { kind: 'error', message: 'argument --port: invalid int value: ' + pyRepr(value) }
        port = n
        break
      }
      case '--daily-spend-usd': {
        const n = pyFloat(value)
        if (n === null) return { kind: 'error', message: 'argument --daily-spend-usd: invalid float value: ' + pyRepr(value) }
        dailySpendUsd = n
        break
      }
      case '--host': host = value; break
      case '--scenes-dir': scenesDir = value; break
      case '--library-dir': libraryDir = value; break
      case '--layouts-dir': layoutsDir = value; break
      case '--renders-dir': rendersDir = value; break
      case '--costs-file': costsFile = value; break
      case '--calib': calib = value; break
      case '--midstudy-add': midstudyAdd = value; break
      case '--allowed-host': allowedHosts.push(value); break
    }
  }
  if (dash >= 0) extra.push(...argv.slice(dash + 1))
  if (extra.length > 0) return { kind: 'error', message: 'unrecognized arguments: ' + extra.join(' ') }
  return {
    kind: 'run',
    options: { port, host, scenesDir, libraryDir, layoutsDir, rendersDir, costsFile, calib, midstudyAdd, allowedHosts, dailySpendUsd },
  }
}

/** v1's checks after parsing that need no file system: a negative cap (and, v2, one that isn't a finite number:
 *  `nan` would switch the cap off). The message argparse's `error` prints, or null. */
export function spendProblem(dailySpendUsd: number): string | null {
  if (Number.isNaN(dailySpendUsd) || dailySpendUsd === Infinity) return '--daily-spend-usd must be a finite number of USD'
  if (dailySpendUsd < 0) return "--daily-spend-usd can't be negative"
  return null
}

/** v1's refusal of a malformed --allowed-host (it would have let a missing or malformed Host through). */
export function allowedHostProblem(value: string): string {
  return '--allowed-host ' + pyRepr(value) + " isn't a host name: give it as name or name:port (e.g. midstudy.example.com)"
}

/** v1's refusal of a --costs-file that isn't the one midstudy-add writes (the cap would miss its rows). */
export function costsFileProblem(costsFile: string, expected: string): string {
  return 'midstudy planner: --costs-file ' + costsFile + " isn't " + expected + ', where midstudy-add writes its costs: drop --costs-file (it defaults to <library-dir>/costs.csv)'
}
