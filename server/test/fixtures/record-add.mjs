// A stand-in for midstudy-add (server/test/library/routes.test.ts): appends its arguments as one JSON line to
// `record-add.log` in its --library=<dir> and exits 0 without a summary, so the job ends at once as failed.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = args.find((a) => a.startsWith('--library='))
if (arg === undefined) {
  process.stderr.write('record-add: no --library=\n')
  process.exit(2)
}
fs.appendFileSync(path.join(arg.slice('--library='.length), 'record-add.log'), JSON.stringify(args) + '\n')
