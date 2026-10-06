import type { Diagnostic } from '../domain/validation'
import { PersistenceError } from './errors'

/** Seconds a client should wait before retrying after `persistence.busy`. */
export const PERSISTENCE_BUSY_RETRY_AFTER_SECONDS = 1

/**
 * The transport answer for an operation that could not get the persistence lock in time. It is
 * transient: nothing was read or written, and the same request may simply be retried. HTTP sends
 * it as `503` with `Retry-After`; MCP returns it as an error tool result (or a JSON-RPC error for
 * resource reads) carrying the same code.
 */
export type PersistenceBusyResult = Readonly<{
	status: 'unavailable'
	code: 'persistence.busy'
	retryable: true
	retryAfterSeconds: number
	message: string
	diagnostics: readonly Diagnostic[]
}>

/** Finds a `persistence.lock_busy` failure in `error` or its cause chain (h3 wraps thrown errors). */
export function isPersistenceBusyError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (current instanceof PersistenceError || (current as { name?: unknown })?.name === 'PersistenceError')
			return (current as { code?: unknown }).code === 'persistence.lock_busy'
		current = (current as { cause?: unknown }).cause
	}
	return false
}

export function persistenceBusyResult(): PersistenceBusyResult {
	const message = 'The Workspace is busy with other UIUX operations. Nothing was changed; retry shortly.'
	return {
		status: 'unavailable',
		code: 'persistence.busy',
		retryable: true,
		retryAfterSeconds: PERSISTENCE_BUSY_RETRY_AFTER_SECONDS,
		message,
		diagnostics: [{ code: 'persistence.busy', path: '/', message }],
	}
}
