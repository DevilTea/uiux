import {
	collectBoundAssetIds,
	hasAssetBinding,
	liveAssetContentUrl,
	resolveAssetTarget,
	type AssetResolutionTable,
	type AssetTargetResolution,
} from '../../assets/bindings'
import type { AdapterWidgetCatalogEntry } from '../../domain/adapters/schema'
import type { Diagnostic, JsonValue } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import { assetBindingDiagnostics } from '../../runtime/effective-view-source'
import { resolveProductKitAdapterSet, type AdapterProvenanceSource } from './adapter-provenance'

/** The most resolutions {@link resolveWorkspaceAssets} remembers per Workspace before it starts over. */
const RESOLUTION_MEMO_LIMIT = 1024
const resolutionMemos = new WeakMap<FileNativePersistence, Map<string, AssetTargetResolution>>()

/**
 * Resolves the current Assets `assetIds` name, each to its runtime value with the live content URL
 * (Clauses 01a167f4-3e4e-7af1-b328-30fb52f7f4c5 and 01a167f4-401d-7330-ac65-0a900adbccd6) or to what blocks
 * it, from the inspected read. An Asset whose files cannot even be read (such as `asset.json` that is not
 * JSON) is blocked with that diagnostic, never skipped (Rule 01a115cd-c09f-7018-9f52-48b05284f600). A
 * resolution depends only on the Asset's files, so it is remembered by the Asset's revision, and its
 * content is digested once per revision.
 */
export async function resolveWorkspaceAssets(persistence: FileNativePersistence, assetIds: readonly string[]): Promise<AssetResolutionTable> {
	let memo = resolutionMemos.get(persistence)
	if (!memo) resolutionMemos.set(persistence, memo = new Map())
	const entries: Array<readonly [string, AssetTargetResolution]> = []
	for (const assetId of assetIds) {
		try {
			const read = await persistence.assets.readInspected(assetId)
			const key = read && `${assetId}@${read.revision}`
			let resolution = key === undefined ? undefined : memo.get(key)
			if (!resolution) {
				resolution = await resolveAssetTarget({ assetId, lookup: { read: async () => read }, url: liveAssetContentUrl })
				if (key !== undefined) {
					if (memo.size >= RESOLUTION_MEMO_LIMIT) memo.clear()
					memo.set(key, resolution)
				}
			}
			entries.push([assetId, resolution])
		}
		catch (error) {
			if (!(error instanceof PersistenceError)) throw error
			entries.push([assetId, { state: 'blocked', diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '', message: error.message }] }])
		}
	}
	return Object.fromEntries(entries)
}

/** The active Adapters' Catalog by Widget type, or `undefined` while the Adapter set cannot be resolved. */
export type AssetCatalog = ReadonlyMap<string, AdapterWidgetCatalogEntry> | undefined

/** The server-side check of a View's `$asset` bindings against the current Assets and the active Adapters' Catalog. */
export type ViewAssetBindingCheck = Readonly<{
	/** The diagnostics of `ir`'s bindings; `catalog`, asked only when `ir` has one, reuses a Catalog read once for several Views. */
	check(ir: unknown, catalog?: () => Promise<AssetCatalog>): Promise<readonly Diagnostic[]>
	/** Reads the Catalog, for several `check` calls of one request to share. */
	catalog(): Promise<AssetCatalog>
}>

/**
 * The server-side check of a View's Asset bindings (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c), for the
 * View's diagnostics, Checks and formal capture: it reports what rendering the View reports for its
 * bindings (a field that is not asset-capable, a missing or invalid Asset, an Asset the field does not
 * accept), never rewriting the View. The Catalog comes from the Adapter set the Preview renders with
 * (`source`); while that set cannot be resolved, the fields are not checked, only the Assets. A View
 * without a binding resolves nothing.
 */
export function createViewAssetBindingCheck(persistence: FileNativePersistence, source?: AdapterProvenanceSource): ViewAssetBindingCheck {
	async function catalog(): Promise<AssetCatalog> {
		try {
			const adapters = (await persistence.productKit.read())?.resource.adapters ?? []
			const byType = new Map<string, AdapterWidgetCatalogEntry>()
			if (adapters.length === 0) return byType
			const resolution = await resolveProductKitAdapterSet(persistence, adapters, source)
			if (resolution.state !== 'valid') return undefined
			for (const entry of resolution.set.entries) {
				for (const [widgetType, widgetCatalog] of Object.entries(entry.manifest.catalog.widgets)) byType.set(widgetType, widgetCatalog)
			}
			return byType
		}
		catch {
			return undefined
		}
	}

	return Object.freeze({
		catalog,
		async check(ir: unknown, given?: () => Promise<AssetCatalog>) {
			if (!hasAssetBinding(ir)) return []
			const [assets, catalogByType] = await Promise.all([resolveWorkspaceAssets(persistence, collectBoundAssetIds(ir)), (given ?? catalog)()])
			return assetBindingDiagnostics(ir as JsonValue, catalogByType, assets)
		},
	})
}
