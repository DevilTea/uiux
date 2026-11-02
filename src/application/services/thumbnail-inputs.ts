import { collectBoundAssetIds } from '../../assets/bindings'
import { renderInputDigest } from '../../domain/evidence/render-input-digest'
import type { ResolvedRenderContext } from '../../domain/render-context/schema'
import { thumbnailInputDigest } from '../../domain/thumbnails/digest'
import type { JsonValue } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import { settledValue } from '../../persistence/file-native'
import { resolveCaptureContexts } from '../../preview/capture-contexts'
import { isFullUuid } from '../../domain/validation'
import type { ThumbnailInputsSource, ThumbnailPlan } from '../ports/thumbnails'
import { readCurrentAdapterProvenance, type AdapterProvenanceSource } from './adapter-provenance'
import { readCurrentProductKitProvenance } from './product-kit-provenance'

/**
 * Reads what every View's thumbnail depends on (Clause 01a19b99-ccfa-74bb-9671-08ab5d4e2656) and
 * its default context (Rule 01a19b99-cfcc-7abb-8be5-75c2cc6e7148): the context of
 * `uiux evidence capture --view` without options (Clause 01a19a17-1381-74db-bda9-efd8176865c6), the
 * View's own render-input digest, the default Locale's revision, the current Adapter and Product Kit
 * provenance a formal capture records, and the revision of each Asset the View binds. A View whose
 * digest cannot be computed has a plan without one (Rule 01a19b99-d221-715d-979a-1977a210a7b2).
 */
export function createThumbnailInputs(persistence: FileNativePersistence, options?: Readonly<{ adapterProvenance?: AdapterProvenanceSource }>): ThumbnailInputsSource {
	async function plans(viewIds?: readonly string[]): Promise<readonly ThumbnailPlan[]> {
		const views = await readViews(persistence, viewIds)
		if (views.length === 0) return []
		const manifest = (await persistence.workspace.readInspected().catch(() => undefined))?.resource
		const locales = manifest ? await persistence.locales.discover().catch(() => undefined) : undefined
		// Taken once for the run, as a formal capture takes them.
		const [productKit, adapters] = manifest && locales
			? await Promise.all([readCurrentProductKitProvenance(persistence), readCurrentAdapterProvenance(persistence, options?.adapterProvenance)])
			: [undefined, undefined]
		const defaultLocale = manifest?.i18n?.defaultLocale ?? 'en-US'
		const localeRevision = manifest ? await persistence.locales.readRevision(defaultLocale).catch(() => undefined) : undefined
		const resolved = manifest && locales
			? resolveCaptureContexts({ workspace: manifest, locales, views: views.map(view => ({ id: view.key, variants: [] })) }, { views: views.map(view => view.key) })
			: undefined
		const contexts = new Map<string, ResolvedRenderContext>()
		if (resolved?.ok) for (const context of resolved.contexts) contexts.set(context.viewId, context)

		const result: ThumbnailPlan[] = []
		for (const view of views) {
			const context = contexts.get(view.key)
			if (!context) {
				result.push({ key: view.key })
				continue
			}
			const assets = await boundAssetRevisions(persistence, view.resource.ir)
			if (!localeRevision || productKit?.state !== 'available' || adapters?.state !== 'available' || !assets) {
				result.push({ key: view.key, context })
				continue
			}
			const digest = thumbnailInputDigest({
				renderInputDigest: renderInputDigest(view.resource),
				locale: { id: context.locale, revision: localeRevision },
				viewport: { id: context.viewportId, width: context.viewport.width, height: context.viewport.height },
				themeId: context.themeId,
				adapters: adapters.adapters as unknown as JsonValue,
				productKit: productKit.provenance as unknown as JsonValue,
				assets,
			})
			result.push({ key: view.key, context, digest })
		}
		return result
	}

	return {
		plans,
		async defaultLocaleMissing() {
			const manifest = (await persistence.workspace.readInspected()).resource
			const defaultLocale = manifest?.i18n?.defaultLocale
			if (!defaultLocale) return false
			return (await persistence.locales.readRevision(defaultLocale)) === undefined
		},
	}
}

type ReadView = Readonly<{ key: string; resource: { ir?: unknown; variants?: unknown } }>

/** The readable Views among `viewIds`, or every readable View; a View file that is not valid JSON has no thumbnail, as it has no render input. */
async function readViews(persistence: FileNativePersistence, viewIds: readonly string[] | undefined): Promise<readonly ReadView[]> {
	const views: ReadView[] = []
	if (viewIds) {
		for (const key of [...new Set(viewIds)]) {
			if (!isFullUuid(key)) continue
			const read = await persistence.views.readInspected(key).catch(ignoreBrokenFile)
			if (read?.resource) views.push({ key, resource: read.resource })
		}
		return views
	}
	for (const { key, read: settled } of await persistence.views.readAllInspected()) {
		let read: Awaited<ReturnType<typeof persistence.views.readInspected>>
		try { read = settledValue(settled) }
		catch (error: unknown) {
			if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') continue
			throw error
		}
		if (read?.resource) views.push({ key, resource: read.resource })
	}
	return views.sort((a, b) => a.key.localeCompare(b.key))
}

function ignoreBrokenFile(error: unknown): undefined {
	if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') return undefined
	throw error
}

/** The Asset id to revision map of a View's bindings, or `undefined` when a bound Asset cannot be read. */
async function boundAssetRevisions(persistence: FileNativePersistence, ir: unknown): Promise<Record<string, string> | undefined> {
	const assets: Record<string, string> = {}
	for (const id of collectBoundAssetIds(ir)) {
		const read = await persistence.assets.readInspected(id).catch(() => undefined)
		if (!read?.revision) return undefined
		assets[id] = read.revision
	}
	return assets
}
