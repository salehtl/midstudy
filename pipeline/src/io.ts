// midstudy-add's output (contract §3.1): every line goes out at once and in order, as v1's flushed prints did, so a
// reader merging stdout and stderr (planner/serve.py's job log) sees them interleaved as written, and an interrupt
// loses nothing already said.
import fs from 'node:fs'

const pause = new Int32Array(new SharedArrayBuffer(4))

function errno(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** All of `text` to `fd`, synchronously (a full non-blocking pipe is waited out). */
function writeAll(fd: 1 | 2, text: string): void {
  const buf = Buffer.from(text, 'utf8')
  let off = 0
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off)
    } catch (e) {
      if (errno(e) !== 'EAGAIN') throw e
      Atomics.wait(pause, 0, 0, 5)
    }
  }
}

/** One line on stdout. */
export function out(line: string): void {
  writeAll(1, `${line}\n`)
}

/** Text on stdout as is (the help). */
export function outRaw(text: string): void {
  writeAll(1, text)
}

/** One line on stderr. */
export function err(line: string): void {
  writeAll(2, `${line}\n`)
}
