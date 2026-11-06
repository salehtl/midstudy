// A child process for lock.test.ts: holds a library's lock (`<library>/.lock.d`, contract §2.8 One writer v2) as
// midstudy-add holds it for a whole run, until it is killed.
import { setTimeout as sleep } from 'node:timers/promises'
import { acquireLock, libraryLockDir } from '../../../common/lock.ts'

const [library = ''] = process.argv.slice(2)
await acquireLock(libraryLockDir(library), { waitMs: 10000, cmd: 'midstudy-add (test holder)' })
process.stdout.write('held\n')
await sleep(10 * 60 * 1000)
