// Preloaded into midstudy-add by paid.test.ts (`node --import <this> pipeline/src/cli.ts …`): a stand-in for live fal,
// so the CLI takes its paid branch with no network and no key. It answers fal-client's protocol as far as an accepted
// queue job that stays IN_PROGRESS (with one log line, the test's cue to signal), and refuses any other request: none
// reaches the network.
import { installFalStandIn } from '../src/standin.ts'

if ((process.env['FAL_KEY'] ?? '') !== '') throw new Error('paid-standin: run with FAL_KEY unset')

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function answer(url: string, init: RequestInit): Response {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  if (method === 'POST' && u.hostname === 'rest.fal.ai' && u.pathname === '/storage/auth/token') {
    return json({ token_type: 'Bearer', token: 'stand-in', base_url: 'https://v3.fal.media', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
  }
  if (method === 'POST' && u.hostname === 'v3.fal.media' && u.pathname === '/files/upload') {
    return json({ access_url: 'https://stand-in.invalid/files/engine-input.jpg' })
  }
  if (method === 'POST' && u.hostname === 'queue.fal.run') {
    // the submit: from here on the job counts as billed
    return json({ request_id: 'stand-in', status_url: 'https://stand-in.invalid/status', response_url: 'https://stand-in.invalid/result' })
  }
  if (method === 'GET' && u.hostname === 'stand-in.invalid' && u.pathname === '/status') {
    return json({ status: 'IN_PROGRESS', logs: [{ message: 'stand-in: running' }] })
  }
  throw new TypeError(`paid-standin: no answer for ${method} ${url}`)
}

installFalStandIn({
  key: 'stand-in-not-a-key',
  fetch: (url, init) => {
    if (init.signal?.aborted === true) return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
    try {
      return Promise.resolve(answer(url, init))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  },
})
