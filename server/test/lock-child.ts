// A child process for lock.test.ts: takes the lock folder N times, each time reading a counter file, waiting a
// little and writing it back + 1 (a lost update would show without mutual exclusion); or holds the lock and stays alive
// (`hold`), or takes it and exits without giving it back (`crash`).
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquireLock, withLock } from '../../common/lock.ts'

const [mode = '', dir = '', counter = '', times = '1'] = process.argv.slice(2)

if (mode === 'count') {
  for (let i = 0; i < Number(times); i++) {
    await withLock(dir, { waitMs: 60000, cmd: 'lock-child count', pollMs: 5 }, async () => {
      const n = Number(fs.readFileSync(counter, 'utf8'))
      await sleep(2)
      fs.writeFileSync(counter, String(n + 1))
    })
  }
} else if (mode === 'hold') {
  await acquireLock(dir, { waitMs: 10000, cmd: 'lock-child hold' })
  process.stdout.write('held\n')
  await sleep(60000)
} else if (mode === 'crash') {
  await acquireLock(dir, { waitMs: 10000, cmd: 'lock-child crash' })
  process.stdout.write('held\n')
  process.exit(0)
}
