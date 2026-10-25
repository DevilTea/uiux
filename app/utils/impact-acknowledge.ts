import type { ReceivedImpact } from './version-restore'

/**
 * What a write that may need the caller's acknowledgement of its reference impact answered (Clause
 * 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34): `update_workspace_settings` and the delete operations answer
 * `409 { status: "impact_acknowledgement_required", impacts }` when the impact is not empty and the
 * request did not carry `acknowledgeImpact: true`. Told apart from a revision conflict, which is
 * also a 409, by its `status`. Framework-free and unit-tested.
 */
export type AcknowledgedWriteAnswer =
	| Readonly<{ state: 'done'; status: 'created' | 'updated' | 'deleted' }>
	| Readonly<{ state: 'impact'; impacts: readonly ReceivedImpact[] }>
	| Readonly<{ state: 'conflict' }>
	| Readonly<{ state: 'locked' }>
	| Readonly<{ state: 'refused'; status: 'invalid' | 'not_found' | 'blocked' | 'denied' | 'failed' }>

export function classifyAcknowledgedWriteAnswer(httpStatus: number, body: unknown): AcknowledgedWriteAnswer {
	const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
	const status = typeof record.status === 'string' ? record.status : undefined
	if ((status === 'created' || status === 'updated' || status === 'deleted') && httpStatus < 300) return { state: 'done', status }
	if (status === 'impact_acknowledgement_required') return { state: 'impact', impacts: Array.isArray(record.impacts) ? record.impacts as ReceivedImpact[] : [] }
	if (status === 'conflict') return { state: 'conflict' }
	if (status === 'locked' || httpStatus === 423) return { state: 'locked' }
	if (httpStatus === 403 || record.code === 'auth.scope_denied') return { state: 'refused', status: 'denied' }
	if (status === 'invalid' || status === 'not_found' || status === 'blocked') return { state: 'refused', status }
	return { state: 'refused', status: 'failed' }
}

/** The `$fetch` failure's HTTP status and decoded body, which the answer classifies. */
export function failureOf(cause: unknown): Readonly<{ status: number | undefined; body: unknown }> {
	const failure = cause as { statusCode?: number; status?: number; data?: unknown }
	return { status: failure.statusCode ?? failure.status, body: failure.data }
}

/** The collection route of a deletable resource kind: `DELETE /api/<route>/:id`. */
export const DELETE_ROUTES = { view: 'views', flow: 'flows', asset: 'assets' } as const
export type DeletableKind = keyof typeof DELETE_ROUTES
