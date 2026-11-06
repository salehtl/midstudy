// A stand-in for `midstudy-calib` in the worker tests (server/test/scenes/worker.test.ts): the one-shot commands and
// `serve`, with the misbehaviour FAKE_CALIB_SERVE asks for. Each process start is logged to FAKE_CALIB_LOG as one JSON
// line {argv, pid, mock} (mock: whether MIDSTUDY_CALIB_MOCK reached it), and each worker request as {request}.
//
//   FAKE_CALIB_SERVE=ok          answers every request like the one-shot command (the default)
//   FAKE_CALIB_SERVE=exit2       no `serve`: exits 2 at once (fixtures/stub_calib.py's argparse error)
//   FAKE_CALIB_SERVE=garbled     answers with a line that isn't JSON
//   FAKE_CALIB_SERVE=wrong-id    answers with another id
//   FAKE_CALIB_SERVE=crash       exits 1 after reading the request
//   FAKE_CALIB_SERVE=hang        never answers
//   FAKE_CALIB_SERVE=fail        answers {ok: false, error: "the photo is unreadable"}
//   FAKE_CALIB_SERVE=second-crash   answers the first request, exits 3 on the second
//   FAKE_CALIB_OFF_CONTRACT=1    run/fit results (one-shot and served) lack `camera`: they break calib-cli.schema.json
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const log = process.env['FAKE_CALIB_LOG'] ?? ''
function note(entry: unknown): void {
  if (log !== '') fs.appendFileSync(log, JSON.stringify(entry) + '\n')
}

const CAMERA = { fov_y_deg: 61.5, height_m: 1.52, pitch_deg: -12.5, roll_deg: 1.25 }

/** The one-shot result line of `cmd args` (and the files it writes). */
function result(cmd: string, args: readonly string[]): Record<string, unknown> {
  if (cmd === 'light') return { ok: true, lighting: true, cct_k: 4500.5, confidence: 0.8, elapsed_s: 0.01 }
  const out = cmd === 'run' ? args[args.indexOf('--out') + 1] ?? '' : args[0] ?? ''
  const calib = {
    version: 1, source: 'moge-2', model: 'fake', image: { w: 1600, h: 1200 }, camera: CAMERA, principal: [0.5, 0.5],
    floor: { found: true, inlier_ratio: 0.3, rmse_m: 0.01 }, depth: null, exif: { make: 'FakeCam', model: 'Fake 1' }, device: 'cpu', elapsed_s: 0.01,
  }
  if (out !== '' && fs.existsSync(out)) fs.writeFileSync(path.join(out, 'calib.json'), JSON.stringify(calib, null, 2) + '\n')
  const line: Record<string, unknown> = { ...calib, ok: true }
  if (process.env['FAKE_CALIB_OFF_CONTRACT'] === '1') Reflect.deleteProperty(line, 'camera')
  return line
}

const [cmd = '', ...args] = process.argv.slice(2)
note({ argv: [cmd, ...args], pid: process.pid, mock: process.env['MIDSTUDY_CALIB_MOCK'] !== undefined })

if (cmd !== 'serve') {
  process.stderr.write('fake-calib: ' + cmd + '\n')
  process.stdout.write(JSON.stringify(result(cmd, args)) + '\n')
  process.exit(0)
}

const mode = process.env['FAKE_CALIB_SERVE'] ?? 'ok'
if (mode === 'exit2') {
  process.stderr.write('usage: midstudy-calib [-h] {run,ingest,fit,light,align} ...\nmidstudy-calib: error: argument cmd: invalid choice: \'serve\'\n')
  process.exit(2)
}
process.stderr.write('fake-calib: worker ready\n')
let served = 0
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req: unknown = JSON.parse(line)
  note({ request: req })
  if (typeof req !== 'object' || req === null || !('id' in req) || !('cmd' in req) || !('args' in req)) return
  const id = req.id
  const reqCmd = typeof req.cmd === 'string' ? req.cmd : ''
  const reqArgs = Array.isArray(req.args) ? req.args.filter((a): a is string => typeof a === 'string') : []
  served += 1
  process.stderr.write('fake-calib: request ' + String(id) + '\n')
  if (mode === 'garbled') process.stdout.write('this is not JSON\n')
  else if (mode === 'wrong-id') process.stdout.write(JSON.stringify({ id: 'someone-else', ...result(reqCmd, reqArgs) }) + '\n')
  else if (mode === 'crash' || (mode === 'second-crash' && served === 2)) process.exit(mode === 'crash' ? 1 : 3)
  else if (mode === 'hang') return
  else if (mode === 'fail') {
    process.stderr.write('midstudy-calib: the photo is unreadable\n')
    process.stdout.write(JSON.stringify({ id, ok: false, error: 'the photo is unreadable' }) + '\n')
  } else process.stdout.write(JSON.stringify({ id, ...result(reqCmd, reqArgs) }) + '\n')
})
rl.on('close', () => {
  note({ eof: true, pid: process.pid })
  process.exit(0)
})
