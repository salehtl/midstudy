// The server's command line (contract §2.1, §4.4): v1's flags, defaults and argparse's rules (`--flag value` and
// `--flag=value`, unambiguous prefixes, the last value wins, `--allowed-host` repeats) and its error sentences.
// Pure (TScert); server/src/main.ts prints and exits.
import { pyRepr } from '../../../common/logic/pyfmt.ts'
import { pyFloat } from '../../../common/logic/csv.ts'
import { MAX_CAP_USD } from './spend.ts'

/** The default --calib: calib/'s midstudy-calib (its warm worker, `midstudy-calib serve`, is tried first; contract §4.3). */
const DEFAULT_CALIB = 'uv run --project calib midstudy-calib'
/** The default --midstudy-add: the furniture CLI (contract §3.1), run by Node from the repository. */
const DEFAULT_MIDSTUDY_ADD = 'node pipeline/src/cli.ts'

/** The parsed flags, before paths are resolved. */
interface CliOptions {
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
  /** null: not given (the app's Settings set the budget, §2.9) */
  readonly dailySpendUsd: number | null
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
    + '  --daily-spend-usd DAILY_SPEND_USD\n                        cap on paid fal calls (library adds and renders) per UTC day, in USD.\n                        Given, it is fixed and the app\'s Settings can\'t change it; left\n                        out, the app sets it (default 2)\n'
}

/** Python's `int(s)` for ASCII text: surrounding whitespace, a sign, `_` between digits; null where it raises. */
function pyInt(s: string): number | null {
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

/** One flag and its value, as argparse paired them. */
interface FlagValue {
  readonly flag: Flag
  readonly value: string
}

type Pairing =
  | { readonly kind: 'pairs'; readonly pairs: readonly FlagValue[]; readonly extra: readonly string[] }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

/** argparse's type check of a value as it reads it (`type=int`, `type=float`): its error, or null. */
function typeProblem(flag: Flag, value: string): string | null {
  if (flag === '--port' && pyInt(value) === null) return 'argument --port: invalid int value: ' + pyRepr(value)
  if (flag === '--daily-spend-usd' && pyFloat(value) === null) return 'argument --daily-spend-usd: invalid float value: ' + pyRepr(value)
  return null
}

/** argparse's ambiguity error for a word (it is raised before anything else is read), or ''. */
function ambiguityOf(word: string): string {
  const k = classify(word)
  return k.kind === 'ambiguous' ? k.message : ''
}

/** Left to right, as argparse reads: each flag with its value (the first error stops it), the words it didn't
 *  take, `-h` at once. */
function pairUp(argv: readonly string[]): Pairing {
  const dash = argv.indexOf('--')
  const words = dash < 0 ? argv : argv.slice(0, dash)
  const problems = words.map((w) => ambiguityOf(w)).filter((m) => m !== '')
  const firstProblem = problems[0]
  if (firstProblem !== undefined) return { kind: 'error', message: firstProblem }
  const pairs: FlagValue[] = []
  const extra: string[] = []
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    const k = classify(word)
    i += 1
    if (k.kind !== 'flag') {
      extra.push(word)
      continue
    }
    if (k.flag === '--help') {
      if (k.explicit !== null) return { kind: 'error', message: 'argument -h/--help: ignored explicit argument ' + pyRepr(k.explicit) }
      return { kind: 'help' }
    }
    let value: string
    if (k.explicit !== null) {
      value = k.explicit
    } else {
      const next = words[i]
      if (next === undefined || classify(next).kind !== 'value') {
        return { kind: 'error', message: 'argument ' + k.flag + ': expected one argument' }
      }
      value = next
      i += 1
    }
    const problem = typeProblem(k.flag, value)
    if (problem !== null) return { kind: 'error', message: problem }
    pairs.push({ flag: k.flag, value })
  }
  const rest = dash < 0 ? [] : argv.slice(dash)
  return { kind: 'pairs', pairs, extra: [...extra, ...rest] }
}

/** The last value given for `flag` (argparse's store action), or null. */
function lastValue(pairs: readonly FlagValue[], flag: Flag): string | null {
  let v: string | null = null
  for (const p of pairs) {
    if (p.flag === flag) v = p.value
  }
  return v
}

/** argparse over v1's flags. Values are checked later (main.ts): only their types here. */
export function parseCli(argv: readonly string[]): CliParse {
  const paired = pairUp(argv)
  if (paired.kind !== 'pairs') return paired
  if (paired.extra.length > 0) return { kind: 'error', message: 'unrecognized arguments: ' + paired.extra.join(' ') }
  const pairs = paired.pairs
  const portText = lastValue(pairs, '--port')
  const spendText = lastValue(pairs, '--daily-spend-usd')
  const options: CliOptions = {
    port: portText === null ? 8765 : (pyInt(portText) ?? 8765),
    host: lastValue(pairs, '--host') ?? '127.0.0.1',
    scenesDir: lastValue(pairs, '--scenes-dir') ?? 'scenes',
    libraryDir: lastValue(pairs, '--library-dir'),
    layoutsDir: lastValue(pairs, '--layouts-dir') ?? 'layouts',
    rendersDir: lastValue(pairs, '--renders-dir') ?? 'renders',
    costsFile: lastValue(pairs, '--costs-file'),
    calib: lastValue(pairs, '--calib') ?? DEFAULT_CALIB,
    midstudyAdd: lastValue(pairs, '--midstudy-add') ?? DEFAULT_MIDSTUDY_ADD,
    allowedHosts: pairs.filter((p) => p.flag === '--allowed-host').map((p) => p.value),
    dailySpendUsd: spendText === null ? null : pyFloat(spendText),
  }
  return { kind: 'run', options }
}

/** v1's checks after parsing that need no file system: a negative cap (and, v2, one that isn't a finite number:
 *  `nan` would switch the cap off). The message argparse's `error` prints, or null. */
export function spendProblem(dailySpendUsd: number | null): string | null {
  if (dailySpendUsd === null) return null
  if (Number.isNaN(dailySpendUsd) || dailySpendUsd === Infinity) return '--daily-spend-usd must be a finite number of USD'
  if (dailySpendUsd < 0) return "--daily-spend-usd can't be negative"
  if (dailySpendUsd > MAX_CAP_USD) return '--daily-spend-usd must be from 0 to ' + String(MAX_CAP_USD)
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
