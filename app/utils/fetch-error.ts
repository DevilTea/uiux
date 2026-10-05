/**
 * Extracts the server's diagnostic body from a failed `$fetch` call.
 *
 * ofetch throws a FetchError whose `message` is a transport string such as
 * `[POST] "/api/evidence/capture": 422 Unprocessable Entity`. The useful part is
 * the JSON body the Nitro route returned (`error.data`): a top-level `message`,
 * `diagnostics[]`, or per-context `results[].error` / `results[].diagnostics[]`.
 */
export type FetchErrorDiagnostic = Readonly<{ code?: string; path?: string; message: string }>

export type FetchErrorDetails = Readonly<{
	/** Human-readable summary suitable for an error alert title or toast. */
	message: string
	/** Structured diagnostics reported by the server, if any. */
	diagnostics: readonly FetchErrorDiagnostic[]
	/** HTTP status code when the failure came from an HTTP response. */
	statusCode?: number
	/** Domain status reported in the body (e.g. 'conflict', 'blocked', 'failed'). */
	status?: string
	/** The edit lease that refused the write: `423 resource.locked` (accepted identity decision 11). */
	lock?: FetchErrorLock
}>

/** Who holds the edit lease on the resource, and until when. */
export type FetchErrorLock = Readonly<{ kind: string; key: string; holder: Readonly<{ nickname: string; kind: string }>; expiresAt: string }>

/** True when the write was refused because someone else holds the resource's edit lease. */
export function isLockedError(details: FetchErrorDetails): boolean {
	return details.statusCode === 423 || details.status === 'locked'
}

export function describeFetchError(cause: unknown, fallback: string): FetchErrorDetails {
	const record = isRecord(cause) ? cause : undefined
	const statusCode = numberField(record, 'statusCode') ?? numberField(record, 'status')
	const body = record && 'data' in record ? record.data : undefined
	const diagnostics = collectDiagnostics(body)
	const bodyRecord = isRecord(body) ? body : undefined
	const bodyMessage = stringField(bodyRecord, 'message') ?? stringField(bodyRecord, 'statusMessage')
	const status = stringField(bodyRecord, 'status')
	const lock = lockField(bodyRecord)

	const message = bodyMessage
		?? diagnostics[0]?.message
		?? (cause instanceof Error && !isTransportMessage(cause.message) ? cause.message : undefined)
		?? fallback

	return Object.freeze({
		message,
		diagnostics: Object.freeze(diagnostics),
		...(statusCode !== undefined ? { statusCode } : {}),
		...(status ? { status } : {}),
		...(lock ? { lock } : {}),
	})
}

function lockField(body: Record<string, unknown> | undefined): FetchErrorLock | undefined {
	const candidate = isRecord(body?.lock) ? body.lock : Array.isArray(body?.locks) && isRecord(body.locks[0]) ? body.locks[0] : undefined
	if (!candidate) return undefined
	const holder = isRecord(candidate.holder) ? candidate.holder : undefined
	const nickname = stringField(holder, 'nickname')
	const expiresAt = stringField(candidate, 'expiresAt')
	if (!nickname || !expiresAt) return undefined
	return Object.freeze({
		kind: stringField(candidate, 'kind') ?? '',
		key: stringField(candidate, 'key') ?? '',
		holder: Object.freeze({ nickname, kind: stringField(holder, 'kind') ?? 'agent' }),
		expiresAt,
	})
}

/** Joins the summary and any distinct diagnostic messages into a single line. */
export function formatFetchError(cause: unknown, fallback: string): string {
	const details = describeFetchError(cause, fallback)
	const extra = details.diagnostics
		.map(item => item.message)
		.filter(item => item && item !== details.message)
	return extra.length ? `${details.message} ${extra.join(' ')}` : details.message
}

function collectDiagnostics(body: unknown): FetchErrorDiagnostic[] {
	if (!isRecord(body)) return []
	const result: FetchErrorDiagnostic[] = []
	const push = (value: unknown) => {
		if (!Array.isArray(value)) return
		for (const item of value) {
			if (isRecord(item) && typeof item.message === 'string' && item.message) {
				result.push({
					message: item.message,
					...(typeof item.code === 'string' ? { code: item.code } : {}),
					...(typeof item.path === 'string' ? { path: item.path } : {}),
				})
			}
		}
	}
	push(body.diagnostics)
	if (Array.isArray(body.results)) {
		for (const entry of body.results) {
			if (!isRecord(entry)) continue
			push(entry.diagnostics)
			if (typeof entry.error === 'string' && entry.error)
				result.push({ message: entry.error })
		}
	}
	const seen = new Set<string>()
	return result.filter((item) => {
		const key = `${item.code ?? ''}\u0000${item.path ?? ''}\u0000${item.message}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function isTransportMessage(message: string): boolean {
	return /^\[(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\]\s/.test(message) || /^(fetch failed|Failed to fetch|NetworkError)/i.test(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key]
	return typeof value === 'string' && value ? value : undefined
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key]
	return typeof value === 'number' ? value : undefined
}
