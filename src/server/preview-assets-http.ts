import { resolveWorkspaceAssets } from '../application/services/asset-bindings'
import type { AssetResolutionTable } from '../assets/bindings'
import { isFullUuid } from '../domain/validation'
import type { FileNativePersistence } from '../persistence'
import type { AuthoringHttpResult } from './authoring-http'

/** The most Asset IDs one resolution request names. */
export const MAX_PREVIEW_ASSET_IDS = 256

export type PreviewAssetsResponse = Readonly<{ assets: AssetResolutionTable }>
type PreviewAssetsRefusal = Readonly<{ code: 'invalid_asset_ids'; message: string }>

/**
 * Reads the `ids` query of a Preview asset resolution request: comma-separated Asset UUIDs, at most
 * `MAX_PREVIEW_ASSET_IDS`, duplicates folded. A missing or empty `ids` names no Asset.
 */
export function parsePreviewAssetIds(value: unknown): readonly string[] | PreviewAssetsRefusal {
	if (value === undefined || value === '') return []
	if (typeof value !== 'string')
		return { code: 'invalid_asset_ids', message: '`ids` is one comma-separated list of Asset UUIDs.' }
	const ids = [...new Set(value.split(','))]
	if (ids.length > MAX_PREVIEW_ASSET_IDS)
		return { code: 'invalid_asset_ids', message: `At most ${MAX_PREVIEW_ASSET_IDS} Asset IDs are resolved at once.` }
	if (!ids.every(id => isFullUuid(id)))
		return { code: 'invalid_asset_ids', message: 'Every Asset ID must be a UUID.' }
	return ids
}

/**
 * `GET /api/preview/assets?ids=<id>,…`, Preview data (`workspace.read`): the server resolves each
 * Asset a live Preview's View binds to its runtime value, or to what blocks it, from the inspected
 * Asset read (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c; Clauses 01a167f4-3e4e-7af1-b328-30fb52f7f4c5 and
 * 01a167f4-401d-7330-ac65-0a900adbccd6). The response is implementation-defined (there is no HTTP Contract).
 */
export async function resolvePreviewAssetsForHttp(persistence: FileNativePersistence, idsQuery: unknown): Promise<AuthoringHttpResult<PreviewAssetsResponse | PreviewAssetsRefusal>> {
	const ids = parsePreviewAssetIds(idsQuery)
	if (!Array.isArray(ids)) return { status: 400, body: ids as PreviewAssetsRefusal }
	return { status: 200, body: { assets: await resolveWorkspaceAssets(persistence, ids) }, headers: { 'Cache-Control': 'no-store' } }
}
