import { computed, shallowRef } from 'vue'
import { useRuntimeConfig } from '#imports'
import {
	isPublicationSnapshot,
	type PublicationSnapshot,
} from '../../src/application/services/publication-snapshot'
import type { HandoffRoot } from '../../src/domain/handoff/schema'
import { publishedAssetKind } from '../utils/published-asset-files'

export type VersionResourceRead<T> = Readonly<{ versionId: string; kind: string; key: string; revision: string; workspaceSchemaVersion: number; resource: T }>

type ResourceListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>

type PreviewAdaptersResponse =
	| { state: 'valid'; diagnostics: readonly []; summaries: readonly unknown[]; bundleUrl: string }
	| { state: 'invalid'; diagnostics: readonly { code: string; path: string; message: string }[]; summaries: readonly unknown[] }

let publicationPromise: Promise<PublicationSnapshot> | undefined
const publicationState = shallowRef<PublicationSnapshot>()
/** Published document-capable files as base64 `data:application/octet-stream` URLs, by file and digest. */
const inertDataUrls = new Map<string, Promise<string>>()
const OCTET_STREAM_DATA = 'data:application/octet-stream;base64,'

async function octetStreamDataUrl(url: string): Promise<string> {
	const response = await fetch(url, { credentials: 'same-origin' })
	if (!response.ok) throw new Error(`${url}: ${response.status}`)
	const blob = new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' })
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error ?? new Error(`${url}: unreadable`))
		reader.readAsDataURL(blob)
	})
}

/** Where the Assets page shows an Asset from (`''` when it shows no image) and downloads it from. */
export type AssetAddresses = Readonly<{ image: string; download: string }>

export function useUiuxClient() {
	const runtimeConfig = useRuntimeConfig()
	const isReadOnly = computed(() => runtimeConfig.public.uiuxMode === 'publication')
	const baseURL = computed(() => normalizeBase(runtimeConfig.app.baseURL || '/'))

	async function publication(): Promise<PublicationSnapshot> {
		if (publicationState.value) return publicationState.value
		publicationPromise ??= $fetch<unknown>(staticUrl('_uiux/publication.json'))
			.then((value) => {
				if (!isPublicationSnapshot(value))
					throw new Error('Published UIUX snapshot is missing or invalid.')
				publicationState.value = value
				return value
			})
			.catch((cause) => {
				publicationPromise = undefined
				throw cause
			})
		return publicationPromise
	}

	function staticUrl(relative: string): string {
		const path = relative.startsWith('/') ? relative.slice(1) : relative
		return `${baseURL.value}${path}`
	}

	async function readResource<T>(kind: string, key: string): Promise<T | undefined> {
		if (!isReadOnly.value) {
			try {
				return await $fetch<T>(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`) as unknown as T
			}
			catch (cause) {
				const error = cause as { status?: number; statusCode?: number }
				if (error?.status === 404 || error?.statusCode === 404) return undefined
				throw cause
			}
		}
		const snapshot = await publication()
		if (kind === 'workspace' && key === 'workspace') return snapshot.workspace as T
		const list = snapshot.resources[kind as keyof typeof snapshot.resources] ?? []
		return list.find(item => item.key === key) as T | undefined
	}

	/**
	 * One resource as a version records it, for Preview's read-only version mode (Rule
	 * 01a11a5e-1232-777c-a76d-26a6d5cbcfc0): `workspace`, `view` or `locale`, already upgraded to the
	 * current schema by the server. `undefined` when the version does not hold it. A published
	 * snapshot has no history, so there it is always `undefined`.
	 */
	async function readVersionResource<T>(versionId: string, kind: string, key: string): Promise<VersionResourceRead<T> | undefined> {
		if (isReadOnly.value) return undefined
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
		if (!isReadOnly.value) {
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
		const snapshot = await publication()
		const query = options.query?.trim().toLowerCase()
		const items = kinds.flatMap((kind) => {
			const values = snapshot.discovery[kind as keyof typeof snapshot.discovery] ?? []
			if (!query) return values
			return values.filter(item => JSON.stringify(item).toLowerCase().includes(query))
		})
		return { items: items.slice(0, options.limit ?? 100) as T[] }
	}

	async function listEvidence<T>(viewId?: string): Promise<readonly T[]> {
		if (!isReadOnly.value) {
			const result = await $fetch<{ items: T[] }>('/api/evidence/list', {
				query: viewId ? { viewId } : undefined,
			})
			return result.items
		}
		const snapshot = await publication()
		const items = snapshot.evidence as readonly T[]
		if (!viewId) return items
		return items.filter((item) => {
			const record = (item as { record?: { executionContext?: Record<string, unknown> } }).record
			return record?.executionContext?.viewId === viewId
		})
	}

	async function assessHandoff<T>(roots: readonly HandoffRoot[]): Promise<T> {
		if (!isReadOnly.value) {
			return await $fetch<T>('/api/handoff/assess', {
				method: 'POST',
				body: { roots },
			}) as unknown as T
		}
		const isWorkspaceScope = roots.length === 1 && roots[0]?.type === 'workspace'
		if (!isWorkspaceScope)
			throw new Error('Published UIUX snapshots expose the precomputed Workspace-level Handoff assessment only.')
		return (await publication()).handoff as T
	}

	async function previewAdapters(): Promise<PreviewAdaptersResponse> {
		if (!isReadOnly.value)
			return await $fetch<PreviewAdaptersResponse>('/api/preview/adapters')
		const preview = (await publication()).preview
		return preview.state === 'valid'
			? {
					state: 'valid',
					diagnostics: [],
					summaries: [],
					bundleUrl: staticUrl(preview.runtimeFile),
				}
			: {
					state: 'invalid',
					diagnostics: preview.diagnostics,
					summaries: [],
				}
	}

	function assetUrl(assetId: string): string {
		if (!isReadOnly.value) return `/api/assets/${encodeURIComponent(assetId)}/content`
		const entry = publicationState.value?.files.assets[assetId]
		return entry ? staticUrl(entry.file) : ''
	}

	async function resolveAssetUrl(assetId: string): Promise<string> {
		if (!isReadOnly.value) return assetUrl(assetId)
		const entry = (await publication()).files.assets[assetId]
		return entry ? staticUrl(entry.file) : ''
	}

	/**
	 * The addresses the Assets page shows and downloads an Asset from. In the live Workbench both
	 * are `assetUrl`, as they are for a published raster image or other file. A published file that
	 * a static host would serve as an HTML, XHTML, SVG or XML document (`publishedAssetKind`) is
	 * never linked by its raw file on the published site's own origin: its download is a
	 * `data:application/octet-stream` URL of its bytes, and an SVG is shown from a
	 * `data:image/svg+xml` URL. Both are `''` when the file cannot be read.
	 */
	async function resolveAssetAddresses(assetId: string): Promise<AssetAddresses> {
		if (!isReadOnly.value) return { image: assetUrl(assetId), download: assetUrl(assetId) }
		const entry = (await publication()).files.assets[assetId]
		if (!entry) return { image: '', download: '' }
		const kind = publishedAssetKind(entry)
		if (kind === 'file') return { image: staticUrl(entry.file), download: staticUrl(entry.file) }
		const cacheKey = `${entry.file}#${entry.digest}`
		let pending = inertDataUrls.get(cacheKey)
		if (!pending) {
			pending = octetStreamDataUrl(staticUrl(entry.file))
			inertDataUrls.set(cacheKey, pending)
			pending.catch(() => inertDataUrls.delete(cacheKey))
		}
		const download = await pending.catch(() => '')
		const image = kind === 'svg' && download.startsWith(OCTET_STREAM_DATA)
			? `data:image/svg+xml;base64,${download.slice(OCTET_STREAM_DATA.length)}`
			: ''
		return { image, download }
	}

	function artifactUrl(digest: string): string {
		if (!isReadOnly.value) return `/api/artifacts/${encodeURIComponent(digest)}`
		const entry = publicationState.value?.files.artifacts[digest]
		return entry ? staticUrl(entry.file) : ''
	}

	async function resolveArtifactUrl(digest: string): Promise<string> {
		if (!isReadOnly.value) return artifactUrl(digest)
		const entry = (await publication()).files.artifacts[digest]
		return entry ? staticUrl(entry.file) : ''
	}

	function routeUrl(path: string): string {
		return staticUrl(path)
	}

	return {
		isReadOnly,
		baseURL,
		publication,
		readResource,
		readVersionResource,
		listResources,
		listEvidence,
		assessHandoff,
		previewAdapters,
		assetUrl,
		resolveAssetUrl,
		resolveAssetAddresses,
		artifactUrl,
		resolveArtifactUrl,
		routeUrl,
	}
}

/** A version blob by content digest (host history store, then artifact store; `history.read`). */
export function versionBlobUrl(digest: string): string {
	return `/api/history/blobs/${encodeURIComponent(digest)}`
}

function normalizeBase(value: string): string {
	const withLeading = value.startsWith('/') ? value : `/${value}`
	return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}
