/**
 * The Workbench's single retry of a read the server answered `503 persistence.busy` (the Workspace
 * was momentarily busy; nothing was read). Writes are never retried automatically.
 */

/** Read-only POST endpoints (a JSON query body, no side effects), safe to send twice. */
const READ_ONLY_POSTS: ReadonlySet<string> = new Set(['/api/resources/list', '/api/resources/search', '/api/handoff/assess'])
const MAX_RETRY_DELAY_MS = 3000
const JITTER_MS = 250

export function isRetryableRead(path: string, input: RequestInfo | URL, init?: RequestInit): boolean {
	const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
	if (method === 'GET' || method === 'HEAD') return true
	return method === 'POST' && READ_ONLY_POSTS.has(path) && !(typeof Request !== 'undefined' && input instanceof Request)
}

/** Only a transient answer that says when to come back is retried. */
export function shouldRetryRead(response: Response): boolean {
	return response.status === 503 && response.headers.has('retry-after')
}

/** The server's `Retry-After`, capped at 3 s, plus up to 250 ms of jitter so retries spread out. */
export function transientRetryDelay(response: Response, random: () => number = Math.random): number {
	const seconds = Number(response.headers.get('retry-after'))
	const base = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000
	return Math.min(base, MAX_RETRY_DELAY_MS) + Math.floor(random() * JITTER_MS)
}
