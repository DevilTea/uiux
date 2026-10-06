import { send, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'

import { isPersistenceBusyError, persistenceBusyResult, PERSISTENCE_BUSY_RETRY_AFTER_SECONDS } from '../persistence/busy'

/**
 * Answers a route that could not get the persistence lock in time with the retryable
 * `503 persistence.busy` and `Retry-After`, instead of an unhandled 500. Returns undefined, leaving
 * the response untouched, for every other error so the next error handler sees it unchanged.
 */
export function sendPersistenceBusyError(error: unknown, event: H3Event): Promise<void> | undefined {
	if (!isPersistenceBusyError(error)) return undefined
	setResponseStatus(event, 503, 'Service Unavailable')
	setResponseHeaders(event, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Retry-After': String(PERSISTENCE_BUSY_RETRY_AFTER_SECONDS),
	})
	return send(event, JSON.stringify(persistenceBusyResult()))
}
