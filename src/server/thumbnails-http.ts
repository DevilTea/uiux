import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { ThumbnailStatus } from '../application/ports/thumbnails'

/** The most View keys one `GET /api/thumbnails` or `POST /api/thumbnails/request` names. */
export const MAX_THUMBNAIL_REQUEST_KEYS = 1000

export type ThumbnailHttpResult<Body> = Readonly<{ status: number; body: Body; headers?: Readonly<Record<string, string>> }>

/**
 * `GET /api/views/:id/thumbnail` (Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c, no HTTP Contract): the
 * View's fresh PNG, else its stale one, 404 while it is missing. It never captures. The response says
 * `Cache-Control: no-store` (Clause 01a19bb9-8e8a-7775-b19b-76e0b855095c), the 404 too.
 */
export async function readThumbnailForHttp(session: Pick<ScopedWorkspaceSession, 'readViewThumbnail'>, viewId: string): Promise<ThumbnailHttpResult<Uint8Array | Readonly<{ status: 'not_found'; message: string }>>> {
	const bytes = await session.readViewThumbnail(viewId)
	if (bytes) return { status: 200, body: bytes, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
	return { status: 404, body: { status: 'not_found', message: 'The View has no thumbnail.' }, headers: { 'Cache-Control': 'no-store' } }
}

type Listing = Readonly<{ items: readonly ThumbnailStatus[] }>
type Invalid = Readonly<{ status: 'invalid'; code: string; message: string; diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[] }>

function invalid(message: string, path: string): ThumbnailHttpResult<Invalid> {
	const code = 'thumbnail.invalid_request'
	return { status: 400, body: { status: 'invalid', code, message, diagnostics: [{ code, path, message }] }, headers: { 'Cache-Control': 'no-store' } }
}

/** The named View keys: `undefined` for none named, an error message for a value that is not a list of at most `MAX_THUMBNAIL_REQUEST_KEYS` strings. */
function namedKeys(value: unknown): readonly string[] | undefined | string {
	if (value === undefined) return undefined
	if (!Array.isArray(value) || value.length > MAX_THUMBNAIL_REQUEST_KEYS || value.some(key => typeof key !== 'string'))
		return `The Views to name are at most ${MAX_THUMBNAIL_REQUEST_KEYS} View keys.`
	return [...new Set(value as string[])]
}

/** `GET /api/thumbnails?keys=a,b`: each named View's state and whether it is refreshing (every View when `keys` is absent). */
export async function listThumbnailsForHttp(session: Pick<ScopedWorkspaceSession, 'listViewThumbnails'>, keys: unknown): Promise<ThumbnailHttpResult<Listing | Invalid>> {
	if (keys !== undefined && typeof keys !== 'string') return invalid('The keys parameter is one comma-separated list of View keys.', '/keys')
	const named = namedKeys(keys === undefined ? undefined : keys.split(',').filter(Boolean))
	if (typeof named === 'string') return invalid(named, '/keys')
	return { status: 200, body: { items: await session.listViewThumbnails(named) }, headers: { 'Cache-Control': 'no-store' } }
}

/** `POST /api/thumbnails/request` with `{ keys: [...] }`: queues the named Views' missing and stale thumbnails now, then lists them. */
export async function requestThumbnailsForHttp(session: Pick<ScopedWorkspaceSession, 'requestViewThumbnails'>, body: unknown): Promise<ThumbnailHttpResult<Listing | Invalid>> {
	const keys = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { keys?: unknown }).keys : undefined
	const named = namedKeys(keys)
	if (named === undefined || typeof named === 'string') return invalid(typeof named === 'string' ? named : 'The request names its Views in keys.', '/keys')
	return { status: 200, body: { items: await session.requestViewThumbnails(named) }, headers: { 'Cache-Control': 'no-store' } }
}
