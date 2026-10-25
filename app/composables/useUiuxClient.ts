import type { EvidenceAdapterProvenance } from '../../src/domain/evidence/adapter-provenance'
import type { HandoffRoot } from '../../src/domain/handoff/schema'
import type { AssetResolutionTable } from '../../src/assets/bindings'

export type VersionResourceRead<T> = Readonly<{ versionId: string; kind: string; key: string; revision: string; workspaceSchemaVersion: number; resource: T }>

type ResourceListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>

/** A View's current render-input digest (Clause 01a14e30-2d4a-…) and the revision it was read at. */
export type EvidenceViewRenderInput = Readonly<{ key: string; revision: string; renderInputDigest: string }>

type PreviewAdaptersResponse =
	| {
		state: 'valid'
		diagnostics: readonly []
		summaries: readonly unknown[]
		bundleUrl: string
		/** The Product Kit stylesheet, when the bundle has CSS. */
		stylesheetUrl?: string
		/** Workspace theme ID to the root attributes the Product Kit sets for it. */
		themes: Readonly<Record<string, Readonly<Record<string, string>>>>
		/** The server-side Adapter check could not run on the bundle; the Preview's own guard decides. */
		warnings?: readonly { code: string; path: string; message: string }[]
		/**
		 * The theme support of the resolution: the Workspace themes the active Adapters do not support, and
		 * the predicates that could not answer (Rule 01a11add-f46d-7e92-8f5a-9d10dba6473d).
		 */
		themeSupport: Readonly<{ unsupportedThemeIds: readonly string[]; diagnostics: readonly { code: string; path: string; message: string }[] }>
	}
	| { state: 'invalid'; diagnostics: readonly { code: string; path: string; message: string }[]; summaries: readonly unknown[] }

export function useUiuxClient() {
	async function readResource<T>(kind: string, key: string): Promise<T | undefined> {
		try {
			// The Product Kit file is read through its own route, which answers
			// the same `{ kind, key, resource, revision }` plus its resolution state.
			if (kind === 'product-kit') return await $fetch<T>('/api/product-kit') as unknown as T
			// The Access presets file likewise has its own route, read over HTTP only.
			if (kind === 'access-presets') return await $fetch<T>('/api/access-presets') as unknown as T
			return await $fetch<T>(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`) as unknown as T
		}
		catch (cause) {
			const error = cause as { status?: number; statusCode?: number }
			if (error?.status === 404 || error?.statusCode === 404) return undefined
			throw cause
		}
	}

	/**
	 * One resource as a version records it, for Preview's read-only version mode (Rule
	 * 01a11a5e-1232-777c-a76d-26a6d5cbcfc0): `workspace`, `view` or `locale`, already upgraded to the
	 * current schema by the server. `undefined` when the version does not hold it.
	 */
	async function readVersionResource<T>(versionId: string, kind: string, key: string): Promise<VersionResourceRead<T> | undefined> {
		try {
			return await $fetch<VersionResourceRead<T>>(`/api/history/versions/${encodeURIComponent(versionId)}/resources/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`, { cache: 'no-store' }) as VersionResourceRead<T>
		}
		catch (cause) {
			const error = cause as { status?: number; statusCode?: number; data?: { code?: string } }
			if ((error?.status === 404 || error?.statusCode === 404) && error.data?.code === 'history.resource_missing') return undefined
			throw cause
		}
	}

	async function listResources<T>(
		kinds: readonly string[],
		options: Readonly<{ query?: string; limit?: number; cursor?: string; detail?: 'summary' | 'expanded' }> = {},
	): Promise<ResourceListPage<T>> {
		return await $fetch<ResourceListPage<T>>(options.query ? '/api/resources/search' : '/api/resources/list', {
			method: 'POST',
			body: {
				kinds,
				...(options.query ? { query: options.query } : {}),
				...(options.cursor ? { cursor: options.cursor } : {}),
				...(options.detail ? { detail: options.detail } : {}),
				limit: options.limit ?? 100,
			},
		})
	}

	async function listEvidence<T>(viewId?: string): Promise<readonly T[]> {
		const result = await $fetch<{ items: T[] }>('/api/evidence/list', {
			query: viewId ? { viewId } : undefined,
		})
		return result.items
	}

	/**
	 * The formal Evidence with what its freshness is judged against: each View's current
	 * render-input digest (`views`), and the current Product Kit provenance, `productKit`, or
	 * `productKitUnavailable` when it cannot be computed, and the current Adapter provenance,
	 * `adapters`, or `adaptersUnavailable` likewise.
	 */
	async function listEvidenceForFreshness<T, P>(): Promise<Readonly<{ items: readonly T[]; views?: readonly EvidenceViewRenderInput[]; productKit?: P; productKitUnavailable?: boolean; adapters?: readonly EvidenceAdapterProvenance[]; adaptersUnavailable?: boolean }>> {
		return await $fetch<{ items: T[]; views?: EvidenceViewRenderInput[]; productKit?: P; productKitUnavailable?: boolean; adapters?: EvidenceAdapterProvenance[]; adaptersUnavailable?: boolean }>('/api/evidence/list')
	}

	async function assessHandoff<T>(roots: readonly HandoffRoot[]): Promise<T> {
		return await $fetch<T>('/api/handoff/assess', {
			method: 'POST',
			body: { roots },
		}) as unknown as T
	}

	async function previewAdapters(): Promise<PreviewAdaptersResponse> {
		return await $fetch<PreviewAdaptersResponse>('/api/preview/adapters')
	}

	/**
	 * The server's resolution of the Assets a Preview's View binds (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c):
	 * the current Assets, or with `versionId` the Assets as that version records them. No ID asks nothing.
	 */
	async function previewAssets(assetIds: readonly string[], versionId?: string): Promise<AssetResolutionTable> {
		if (assetIds.length === 0) return {}
		const url = versionId ? `/api/history/versions/${encodeURIComponent(versionId)}/assets` : '/api/preview/assets'
		return (await $fetch<{ assets: AssetResolutionTable }>(url, { query: { ids: assetIds.join(',') }, cache: 'no-store' })).assets
	}

	function assetUrl(assetId: string): string {
		return `/api/assets/${encodeURIComponent(assetId)}/content`
	}

	function artifactUrl(digest: string): string {
		return `/api/artifacts/${encodeURIComponent(digest)}`
	}

	/** An app route as a root-relative URL, for frames and links that open it outside the router. */
	function routeUrl(path: string): string {
		return `/${path.startsWith('/') ? path.slice(1) : path}`
	}

	return {
		readResource,
		readVersionResource,
		listResources,
		listEvidence,
		listEvidenceForFreshness,
		assessHandoff,
		previewAdapters,
		previewAssets,
		assetUrl,
		artifactUrl,
		routeUrl,
	}
}

/** A version blob by content digest (host history store, then artifact store; `history.read`). */
export function versionBlobUrl(digest: string): string {
	return `/api/history/blobs/${encodeURIComponent(digest)}`
}
