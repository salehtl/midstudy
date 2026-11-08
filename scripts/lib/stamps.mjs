// What scripts/build.mjs's stamps decide (pure; the file system stays in build.mjs). A stamp's `inputs` maps a path to
// the `size:mtime` it had when the step was built, or MISSING for a file that wasn't there.

export const MISSING = 'missing'

/** How long files of an older build stay: an open planner tab lazily loads the chunks of the app.js it started with. */
export const PRUNE_GRACE_MS = 24 * 60 * 60_000

/**
 * `nowStats` maps a path to `{key, mtimeMs}` (`{key: MISSING, mtimeMs: null}` for a file that isn't there).
 *
 * Without `buildStart`, before a step: 'current' when every path in the stamp and in `nowStats` has the key the stamp
 * recorded (a path it never saw is a change), else 'stale'.
 *
 * With `buildStart` (ms, taken before the tools read anything), after a step: 'do-not-write' when an input was saved
 * during the build, or has gone (unless `stamp`, what the inputs were at the start, already had it missing), else
 * 'write'. A stamp written then would call output built from the old file current.
 */
export function decide(stamp, nowStats, buildStart = null) {
  if (buildStart !== null) {
    for (const [file, { key, mtimeMs }] of Object.entries(nowStats)) {
      if (key === MISSING ? stamp?.inputs[file] !== MISSING : mtimeMs > buildStart) return 'do-not-write'
    }
    return 'write'
  }
  for (const [file, key] of Object.entries(stamp.inputs)) if ((nowStats[file]?.key ?? MISSING) !== key) return 'stale'
  for (const file of Object.keys(nowStats)) if (!(file in stamp.inputs)) return 'stale'
  return 'current'
}
