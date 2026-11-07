// common/tools.ts's child lifecycle: a timeout sends SIGTERM to the tool's process group first and SIGKILL after the
// grace, the run settles only once the tool has exited, an AbortSignal ends a run as the 'exited' it really is, and
// killAllTools() ends every live tool (grandchildren too) and latches: no tool is spawned after it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runTool } from '../../common/tools.ts'
import { REPO } from './helpers.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midstudy-tools-test-'))
after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** True while `pid` exists (a zombie counts: it has not been reaped). */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `ms` for `pid` to be gone (a grandchild is reaped by init, not by us). */
async function gone(pid: number, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (exists(pid)) {
    if (Date.now() > end) return false
    await sleep(20)
  }
  return true
}

async function until(file: string, ms = 10000): Promise<string> {
  const end = Date.now() + ms
  for (;;) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8')
      if (text.endsWith('\n')) return text
    }
    if (Date.now() > end) throw new Error('no ' + file)
    await sleep(20)
  }
}

function script(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

void describe('runTool: kill sequence and settle', () => {
  void test('a timeout sends SIGTERM first: a tool that traps it gets to clean up before the run settles', async () => {
    const marker = path.join(dir, 'term-marker')
    const ready = path.join(dir, 'term-ready')
    const child = script('trap.mjs', [
      "import fs from 'node:fs'",
      "process.on('SIGTERM', () => { setTimeout(() => { fs.writeFileSync(" + JSON.stringify(marker) + ", 'x'); process.exit(0) }, 100) })",
      'fs.writeFileSync(' + JSON.stringify(ready) + ", 'ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const run = runTool([process.execPath, child], { cwd: dir, timeoutMs: 1500 })
    await until(ready)
    const r = await run
    assert.equal(r.kind, 'timeout')
    assert.ok(fs.existsSync(marker), 'the SIGTERM handler ran before the run settled')
  })

  void test('a tool that ignores SIGTERM is SIGKILLed after the grace, and is gone when the run settles', async () => {
    const pidFile = path.join(dir, 'ignore-pid')
    const child = script('ignore.mjs', [
      "import fs from 'node:fs'",
      "process.on('SIGTERM', () => {})",
      'fs.writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid) + "\\n")',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const t0 = Date.now()
    const run = runTool([process.execPath, child], { cwd: dir, timeoutMs: 1000, killGraceMs: 300 })
    const pid = Number((await until(pidFile)).trim())
    const r = await run
    assert.equal(r.kind, 'timeout')
    assert.ok(Date.now() - t0 >= 1300, 'settled after the grace')
    assert.equal(exists(pid), false, 'the tool is dead (and reaped) when the run settles')
  })

  void test('an aborted run ends the group and resolves as exited with -15', async () => {
    const pidFile = path.join(dir, 'abort-pid')
    const controller = new AbortController()
    const run = runTool(['sh', '-c', 'echo $$ > ' + JSON.stringify(pidFile) + '; exec sleep 5'], { cwd: dir, timeoutMs: 30000, signal: controller.signal })
    const pid = Number((await until(pidFile)).trim())
    controller.abort()
    const r = await run
    assert.equal(r.kind, 'exited')
    assert.equal(r.returnCode, -15)
    assert.equal(exists(pid), false)
  })

  void test('a signal already aborted spawns nothing', async () => {
    const marker = path.join(dir, 'pre-aborted')
    const r = await runTool(['sh', '-c', 'touch ' + JSON.stringify(marker)], { cwd: dir, timeoutMs: 5000, signal: AbortSignal.abort() })
    assert.equal(r.kind, 'spawn-error')
    await sleep(200)
    assert.equal(fs.existsSync(marker), false)
  })

  void test('killAllTools ends a running tool and its grandchild, and nothing is spawned after it (in a subprocess: the latch is module state)', async () => {
    const pidFile = path.join(dir, 'group-pids')
    const after = path.join(dir, 'after-marker')
    const driver = script('driver.mjs', [
      'import fs from "node:fs"',
      'const { runTool, killAllTools } = await import(' + JSON.stringify(pathToFileURL(path.join(REPO, 'common/tools.ts')).href) + ')',
      'const run = runTool(["sh", "-c", "sleep 60 & echo $$ $! > ' + pidFile + '; exec sleep 60"], { cwd: ' + JSON.stringify(dir) + ', timeoutMs: 60000 })',
      'for (let i = 0; i < 500 && !fs.existsSync(' + JSON.stringify(pidFile) + '); i++) await new Promise((r) => setTimeout(r, 20))',
      'await new Promise((r) => setTimeout(r, 100))',
      'const t0 = Date.now()',
      'await killAllTools(2000)',
      'const first = await run',
      'const later = await runTool(["sh", "-c", "touch ' + after + '"], { cwd: ' + JSON.stringify(dir) + ', timeoutMs: 5000 })',
      'console.log(JSON.stringify({ ms: Date.now() - t0, first: first.kind, later }))',
    ].join('\n'))
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [driver], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
      let text = ''
      p.stdout.on('data', (d: Buffer) => {
        text += d.toString('utf8')
      })
      p.on('error', reject)
      p.on('close', () => {
        resolve(text)
      })
    })
    const parsed: unknown = JSON.parse(out.trim().split('\n').pop() ?? '')
    assert.deepEqual(parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'later') : null, { kind: 'spawn-error', message: 'the server is stopping' })
    const pids = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.ok(await gone(pid), 'pid ' + String(pid) + ' is gone')
    assert.equal(fs.existsSync(after), false, 'the run after killAllTools spawned nothing')
  })
})
