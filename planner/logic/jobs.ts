// Following a server job by its id (GET /api/rooms/jobs/<id>, /api/scenes/jobs/<id>, /api/library/jobs/<id>): one poll's
// answer to what the follower does next. The server's job stores never prune, and a restart forgets them all (contract
// §4.9, room-job.schema.json "In memory"), so a 404 on a job that answered before means the job is lost, not done.
// Pure and self-contained, written for TScert (tscert/README.md).

/** What a job follower does after one poll: keep waiting, or stop with the job done, failed or lost. */
export type JobOutcome = 'wait' | 'done' | 'failed' | 'lost'

/** One poll of a job: `httpStatus` is the answer's HTTP status (null when the request didn't reach the server) and
 *  `status` the job's status field (common.schema.json jobStatus: queued, running, done, failed). A 404 is lost (the
 *  server restarted); any other error status or no answer is a transient failure to wait through; a status that isn't
 *  one of the four is waited through too (the follower's own loop limit ends it as lost). */
export function jobOutcome(httpStatus: number | null, status: unknown): JobOutcome {
  if (httpStatus === 404) return 'lost'
  if (httpStatus === null || httpStatus < 200 || httpStatus > 299) return 'wait'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return 'wait'
}
