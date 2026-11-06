#!/usr/bin/env node
// Refuses a track's changes outside the paths it owns (docs/REFACTOR.md §6, scripts/ownership.json).
// Usage: node scripts/check-ownership.mjs <track> [--base <ref>]   (default base: the merge-base with main; v2's
// before the cutover, when there is no main)
// Checks committed changes since the base plus anything uncommitted or untracked. Exit 0 when clean, 1 otherwise.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const args = process.argv.slice(2)
const track = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--base')
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null
const spec = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ownership.json'), 'utf8'))

if (!track || !spec.tracks[track]) {
  console.error(`check-ownership: name a track: ${Object.keys(spec.tracks).join(', ')}`)
  process.exit(2)
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' })
const hasRef = (r) => { try { git('rev-parse', '--verify', '--quiet', r); return true } catch { return false } }
const base = baseArg || git('merge-base', 'HEAD', hasRef('main') ? 'main' : 'v2').trim()

// glob → RegExp: ** any depth, * one segment, ? one char, {a,b} alternatives.
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') { const j = g.indexOf('}', i); re += `(${g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = j }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const rules = spec.tracks[track]
const include = rules.filter((r) => !r.startsWith('!')).map(globRe)
const exclude = rules.filter((r) => r.startsWith('!')).map((r) => globRe(r.slice(1)))
const shared = spec.shared_append.map(globRe)
// a track's notes: docs/notes/<track>.md, or docs/notes/rooms-<track>.md for the rooms work (docs/ROOMS.md §5)
const notes = { test: (p) => p === `docs/notes/${track}.md` || p === `docs/notes/rooms-${track}.md` }

const owned = (p) => notes.test(p) || shared.some((r) => r.test(p)) || (include.some((r) => r.test(p)) && !exclude.some((r) => r.test(p)))

const committed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)
const pending = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
  .flatMap((l) => l.slice(3).split(' -> ')).map((p) => p.replace(/^"|"$/g, ''))
const changed = [...new Set([...committed, ...pending])].sort()
const bad = changed.filter((p) => !owned(p))

if (bad.length) {
  console.log(`check-ownership ${track}: FAIL, ${bad.length} path(s) outside the track (base ${base.slice(0, 7)}):`)
  for (const p of bad) console.log(`  ${p}`)
  process.exit(1)
}
console.log(`check-ownership ${track}: ok, ${changed.length} changed path(s) all owned (base ${base.slice(0, 7)})`)
