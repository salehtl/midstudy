// A stand-in for midstudy-add that never finishes (server/test/shutdown.test.ts): it starts a grandchild, writes
// `sleepy-add-<pid>.json` ({pid, grandchild}) into its --library=<dir>, and sleeps 60 s. Used as
// `--midstudy-add 'node server/test/fixtures/sleepy-add.mjs'` to hold a library job running.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const arg = process.argv.find((a) => a.startsWith('--library='))
if (arg === undefined) {
  process.stderr.write('sleepy-add: no --library=\n')
  process.exit(2)
}
const library = arg.slice('--library='.length)
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
fs.writeFileSync(path.join(library, 'sleepy-add-' + String(process.pid) + '.json'), JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }))
setTimeout(() => {}, 60000)
