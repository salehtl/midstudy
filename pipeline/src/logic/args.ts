// midstudy-add's command line, parsed as v1's argparse parser (Python 3.12) parses it (contract §3.1): long options and
// their unambiguous prefixes, `--opt=value`, one optional INPUT, `--` ends the options, the last of a repeated option
// wins, and argparse's messages ("argument --yaw: invalid choice: '45' (choose from 0, 90, 180, 270)", "unrecognized
// arguments: …", "ambiguous option: …"). Pure (functional core).

import { repr, strip } from './pyformat.ts'

export const ENGINES = ['idol', 'sam3d', 'trellis2', 'glb', 'rug'] as const
export type Engine = (typeof ENGINES)[number]
export const YAWS = [0, 90, 180, 270] as const
export const RESOLUTIONS = [512, 1024, 1536] as const
export const MOUNTS = ['floor', 'wall'] as const
export type Mount = (typeof MOUNTS)[number]

export interface Options {
  readonly input: string | null
  readonly name: string | null
  readonly dims: string | null
  readonly id: string | null
  readonly category: string | null
  readonly engine: Engine
  readonly prompt: string | null
  readonly yaw: number
  readonly resolution: number | null
  readonly library: string | null
  readonly notes: string | null
  readonly mount: Mount | null
  readonly rescale: string | null
  readonly sourceInput: string | null
}

export type ParsedArgs =
  | { readonly kind: 'ok'; readonly options: Options }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

type Dest = 'name' | 'dims' | 'id' | 'category' | 'engine' | 'prompt' | 'yaw' | 'resolution' | 'library' | 'notes' | 'mount' | 'rescale' | 'sourceInput'

interface Opt {
  readonly strings: readonly string[]
  readonly dest: Dest | 'help'
}

/** The parser's options in registration order (argparse lists ambiguous matches in this order). */
const OPTS: readonly Opt[] = [
  { strings: ['-h', '--help'], dest: 'help' },
  { strings: ['--name'], dest: 'name' },
  { strings: ['--dims'], dest: 'dims' },
  { strings: ['--id'], dest: 'id' },
  { strings: ['--category'], dest: 'category' },
  { strings: ['--engine'], dest: 'engine' },
  { strings: ['--prompt'], dest: 'prompt' },
  { strings: ['--yaw'], dest: 'yaw' },
  { strings: ['--resolution'], dest: 'resolution' },
  { strings: ['--library'], dest: 'library' },
  { strings: ['--notes'], dest: 'notes' },
  { strings: ['--mount'], dest: 'mount' },
  { strings: ['--rescale'], dest: 'rescale' },
  { strings: ['--source-input'], dest: 'sourceInput' },
]

/** Every option string with its option, in registration order. */
function optionStrings(): { readonly s: string; readonly opt: Opt }[] {
  const out: { readonly s: string; readonly opt: Opt }[] = []
  for (const opt of OPTS) for (const s of opt.strings) out.push({ s, opt })
  return out
}

interface Found {
  readonly opt: Opt
  readonly string: string
  /** The value after `=` (or after `-h`), when given in the same argument. */
  readonly explicit: string | null
}

type Classified =
  | { readonly kind: 'arg' }
  | { readonly kind: 'option'; readonly found: Found }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'error'; readonly message: string }

/** argparse's `_parse_optional` for one argument. */
function classify(arg: string): Classified {
  if (arg === '' || !arg.startsWith('-')) return { kind: 'arg' }
  const all = optionStrings()
  const exact = all.find((o) => o.s === arg)
  if (exact !== undefined) return { kind: 'option', found: { opt: exact.opt, string: exact.s, explicit: null } }
  if (arg.length === 1) return { kind: 'arg' }
  const eq = arg.indexOf('=')
  if (eq >= 0) {
    const before = arg.slice(0, eq)
    const named = all.find((o) => o.s === before)
    if (named !== undefined) return { kind: 'option', found: { opt: named.opt, string: named.s, explicit: arg.slice(eq + 1) } }
  }
  const matches: Found[] = []
  if (arg.startsWith('--')) {
    const prefix = eq >= 0 ? arg.slice(0, eq) : arg
    for (const o of all) {
      if (o.s.startsWith(prefix)) matches.push({ opt: o.opt, string: o.s, explicit: eq >= 0 ? arg.slice(eq + 1) : null })
    }
  } else {
    const short = arg.slice(0, 2)
    for (const o of all) {
      if (o.s === short) matches.push({ opt: o.opt, string: o.s, explicit: arg.slice(2) })
      else if (o.s.startsWith(arg)) matches.push({ opt: o.opt, string: o.s, explicit: null })
    }
  }
  if (matches.length > 1) return { kind: 'error', message: `ambiguous option: ${arg} could match ${matches.map((m) => m.string).join(', ')}` }
  const only = matches[0]
  if (only !== undefined) return { kind: 'option', found: only }
  if (/^-\d+$|^-\d*\.\d+$/.test(arg)) return { kind: 'arg' }
  if (arg.includes(' ')) return { kind: 'arg' }
  return { kind: 'unknown' }
}

/** The value of a Unicode decimal digit (Python's `int()` accepts them all), or -1. */
function digitValue(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 48 && c <= 57) return c - 48
  if (!/^\p{Nd}$/u.test(ch)) return -1
  let start = c
  while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--
  return (c - start) % 10
}

/** Python's `int(s)` for a string, or null. */
export function pyInt(s: string): number | null {
  const t = strip(s)
  let i = 0
  let negative = false
  if (t.startsWith('+') || t.startsWith('-')) {
    negative = t.startsWith('-')
    i = 1
  }
  const body = Array.from(t.slice(i))
  if (body.length === 0 || body[0] === '_' || body[body.length - 1] === '_') return null
  let v = 0
  let prevUnderscore = false
  for (const ch of body) {
    if (ch === '_') {
      if (prevUnderscore) return null
      prevUnderscore = true
      continue
    }
    prevUnderscore = false
    const d = digitValue(ch)
    if (d < 0) return null
    v = v * 10 + d
  }
  return negative ? -v : v
}

function actionName(opt: Opt): string {
  return opt.strings.join('/')
}

type Mutable = { -readonly [K in keyof Options]: Options[K] }

function fresh(): Mutable {
  return {
    input: null, name: null, dims: null, id: null, category: null, engine: 'idol', prompt: null, yaw: 0, resolution: null,
    library: null, notes: null, mount: null, rescale: null, sourceInput: null,
  }
}

function isEngine(s: string): s is Engine {
  return ENGINES.some((e) => e === s)
}

function isMount(s: string): s is Mount {
  return MOUNTS.some((m) => m === s)
}

/** Stores one option's value, converting and checking it as argparse would; an error message, or null. */
function store(o: Mutable, opt: Opt, raw: string): string | null {
  const name = actionName(opt)
  switch (opt.dest) {
    case 'engine':
      if (!isEngine(raw)) return `argument ${name}: invalid choice: ${repr(raw)} (choose from ${ENGINES.join(', ')})`
      o.engine = raw
      return null
    case 'mount':
      if (!isMount(raw)) return `argument ${name}: invalid choice: ${repr(raw)} (choose from ${MOUNTS.join(', ')})`
      o.mount = raw
      return null
    case 'yaw':
    case 'resolution': {
      const v = pyInt(raw)
      if (v === null) return `argument ${name}: invalid int value: ${repr(raw)}`
      const choices: readonly number[] = opt.dest === 'yaw' ? YAWS : RESOLUTIONS
      if (!choices.includes(v)) return `argument ${name}: invalid choice: ${repr(String(v))} (choose from ${choices.join(', ')})`
      if (opt.dest === 'yaw') o.yaw = v
      else o.resolution = v
      return null
    }
    case 'name': o.name = raw; return null
    case 'dims': o.dims = raw; return null
    case 'id': o.id = raw; return null
    case 'category': o.category = raw; return null
    case 'prompt': o.prompt = raw; return null
    case 'library': o.library = raw; return null
    case 'notes': o.notes = raw; return null
    case 'rescale': o.rescale = raw; return null
    case 'sourceInput': o.sourceInput = raw; return null
    case 'help': return null
  }
}

/** Parses `argv` (without the program name). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  // classify every argument first (argparse raises "ambiguous option" before anything else)
  const kinds: Classified[] = []
  let dashdash = -1
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (dashdash < 0 && a === '--') {
      dashdash = i
      kinds.push({ kind: 'arg' })
      continue
    }
    const c = dashdash >= 0 ? { kind: 'arg' as const } : classify(a)
    if (c.kind === 'error') return { kind: 'error', message: c.message }
    kinds.push(c)
  }
  const o = fresh()
  const extras: string[] = []
  let inputTaken = false
  let i = 0
  while (i < argv.length) {
    const a = argv[i] ?? ''
    const k = kinds[i] ?? { kind: 'arg' }
    if (i === dashdash) {
      i++
      continue
    }
    if (k.kind === 'arg') {
      if (!inputTaken) {
        o.input = a
        inputTaken = true
      } else extras.push(a)
      i++
      continue
    }
    if (k.kind === 'unknown') {
      extras.push(a)
      i++
      continue
    }
    if (k.kind !== 'option') {
      i++
      continue
    }
    const { opt, explicit } = k.found
    if (opt.dest === 'help') {
      if (explicit !== null && explicit !== '' && (a.startsWith('--') || a.includes('='))) {
        return { kind: 'error', message: `argument ${actionName(opt)}: ignored explicit argument ${repr(explicit)}` }
      }
      return { kind: 'help' }
    }
    let raw: string
    if (explicit !== null) {
      raw = explicit
      i++
    } else {
      const next = kinds[i + 1]
      if (next?.kind !== 'arg' || i + 1 === dashdash) return { kind: 'error', message: `argument ${actionName(opt)}: expected one argument` }
      raw = argv[i + 1] ?? ''
      i += 2
    }
    const err = store(o, opt, raw)
    if (err !== null) return { kind: 'error', message: err }
  }
  if (extras.length > 0) return { kind: 'error', message: `unrecognized arguments: ${extras.join(' ')}` }
  return { kind: 'ok', options: o }
}

/** `midstudy-add --help`, as v1's argparse prints it at 80 columns (stdout not a terminal). */
export const HELP = `usage: midstudy-add [-h] [--name NAME] [--dims DIMS] [--id ID]
                    [--category CATEGORY]
                    [--engine {idol,sam3d,trellis2,glb,rug}] [--prompt PROMPT]
                    [--yaw {0,90,180,270}] [--resolution {512,1024,1536}]
                    [--library LIBRARY] [--notes NOTES] [--mount {floor,wall}]
                    [--rescale ID] [--source-input SOURCE_INPUT]
                    [INPUT]

Add a piece of furniture to the midstudy library at real-world size.

positional arguments:
  INPUT                 image path or URL (idol, sam3d, trellis2, rug), or
                        .glb/.gltf path or URL, or an OBJ .zip (glb)

options:
  -h, --help            show this help message and exit
  --name NAME           human name, e.g. 'Strandmon wing chair' (required
                        unless --rescale)
  --dims DIMS           W x D x H in cm, e.g. 75x80x95 (x or ×, spaces and
                        decimals allowed)
  --id ID               slug; defaults to a slug of --name. An existing id is
                        replaced
  --category CATEGORY   e.g. armchair
  --engine {idol,sam3d,trellis2,glb,rug}
                        idol (default, $0.10): a lifelike splat from one
                        photo, with a stand-in box mesh; rug: a flat rug from
                        a top-down picture, no model call ($0); H in --dims is
                        its thickness
  --prompt PROMPT       sam3d only: the object to extract; defaults to
                        --category or 'furniture'
  --yaw {0,90,180,270}  extra counterclockwise turn about +Y (seen from above)
                        so the front faces +Z; with --rescale, relative to the
                        item's current orientation
  --resolution {512,1024,1536}
                        trellis2 only (default 512)
  --library LIBRARY     library directory (default: <repo>/library)
  --notes NOTES         free text stored with the item
  --mount {floor,wall}  where the planner places it by default (§2.10)
  --rescale ID          refit an existing item from its normalized assets (no
                        INPUT, no model call, $0); takes --dims (default:
                        keep) and --yaw (relative)
  --source-input SOURCE_INPUT
                        what to record as source.input (default: INPUT);
                        planner/serve.py passes the original file name or link
                        of an upload
`
