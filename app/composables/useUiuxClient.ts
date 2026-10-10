import type { HandoffRoot } from '../../src/domain/handoff/schema'

export type VersionResourceRead<T> = Readonly<{ versionId: string; kind: string; key: string; revision: string; workspaceSchemaVersion: number; resource: T }>

type ResourceListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>

type PreviewAdaptersResponse =
	| { state: 'valid'; diagnostics: readonly []; summaries: readonly unknown[]; bundleUrl: string }
	| { state: 'invalid'; diagnostics: readonly { code: string; path: string; message: string }[]; summaries: readonly unknown[] }

export function useUiuxClient() {
	async function readResource<T>(kind: string, key: string): Promise<T | undefined> {
		try {
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
		options: Readonly<{ query?: string; limit?: number; cursor?: string }> = {},
	): Promise<ResourceListPage<T>> {
		return await $fetch<ResourceListPage<T>>(options.query ? '/api/resources/search' : '/api/resources/list', {
			method: 'POST',
			body: {
				kinds,
				...(options.query ? { query: options.query } : {}),
				...(options.cursor ? { cursor: options.cursor } : {}),
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

	async function assessHandoff<T>(roots: readonly HandoffRoot[]): Promise<T> {
		return await $fetch<T>('/api/handoff/assess', {
			method: 'POST',
			body: { roots },
		}) as unknown as T
	}

	async function previewAdapters(): Promise<PreviewAdaptersResponse> {
		return await $fetch<PreviewAdaptersResponse>('/api/preview/adapters')
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
		assessHandoff,
		previewAdapters,
		assetUrl,
		artifactUrl,
		routeUrl,
	}
}

/** A version blob by content digest (host history store, then artifact store; `history.read`). */
export function versionBlobUrl(digest: string): string {
	return `/api/history/blobs/${encodeURIComponent(digest)}`
}
