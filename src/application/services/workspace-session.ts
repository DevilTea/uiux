import type { FlowResource } from '../../domain/flows/schema'
import type { I18nResource } from '../../domain/i18n/schema'
import type { Diagnostic } from '../../domain/validation'
import type { ViewResource } from '../../domain/views/schema'
import type { WorkspaceManifest } from '../../domain/workspace/schema'
import type { FileNativePersistence, WorkspaceInspection } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import {
	DISCOVERABLE_RESOURCE_KINDS,
	validateResourceDiscoveryRequest,
	type DiscoverableResourceKind,
	type ResourceDiscoveryItem,
	type ResourceDiscoveryOutcome,
	type ResourceDiscoveryRequest,
} from '../dto/resource-discovery'
import type { ResourceRevision } from '../dto/revisions'
import { isValidPointResourceAddress, type PointResourceKind } from '../dto/point-resources'

export type PointResourceRead =
	| Readonly<{ kind: 'workspace'; key: 'workspace'; resource: WorkspaceManifest; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; inspection: WorkspaceInspection }>
	| Readonly<{ kind: 'view'; key: string; resource: ViewResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'flow'; key: string; resource: FlowResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'locale'; key: string; resource: I18nResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>

export interface WorkspaceApplicationSession {
	readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined>
	listPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	searchPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
}

/**
 * Application-facing selected-Workspace facade shared by HTTP/MCP/Workbench.
 * Transports never reach into FileNativePersistence directly.
 */
export function createWorkspaceApplicationSession(persistence: FileNativePersistence): WorkspaceApplicationSession {
	async function readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined> {
		if (!isValidPointResourceAddress({ kind, key })) return undefined
		switch (kind) {
			case 'workspace': {
				if (key !== 'workspace') return undefined
				const read = await persistence.workspace.readInspected()
				if (!read.resource || !read.revision) return undefined
				return { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics, inspection: read.inspection }
			}
			case 'view': {
				const read = await persistence.views.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'flow': {
				const read = await persistence.flows.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'locale': {
				const read = await persistence.locales.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
		}
	}

	async function discover(input: unknown, mode: 'list' | 'search'): Promise<ResourceDiscoveryOutcome> {
		const validation = validateResourceDiscoveryRequest(input, mode)
		if (validation.status === 'invalid') return validation
		const request = normalizeDiscoveryRequest(validation.request, mode)
		const scope = discoveryScope(request)
		const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, scope)
		if (request.cursor !== undefined && after === undefined)
			return { status: 'invalid', diagnostics: [{ code: 'discovery.invalid_cursor', path: '/cursor', message: 'Discovery cursor is invalid or belongs to a different query scope.' }] }

		const items: ResourceDiscoveryItem[] = []
		for (const kind of request.kinds ?? DISCOVERABLE_RESOURCE_KINDS) {
			for (const key of await discoverKeys(kind)) {
				let item: ResourceDiscoveryItem | undefined
				try {
					const read = await readPointResource(kind, key)
					if (!read || read.kind === 'workspace') continue
					item = summarize(read)
				}
				catch (error) {
					item = await summarizeUnreadable(kind, key, error)
					if (!item) continue
				}
				if (request.query !== undefined && !matchesQuery(item, request.query)) continue
				items.push(item)
			}
		}
		items.sort((left, right) => compareAscii(sortKey(left), sortKey(right)))
		const start = after === undefined ? 0 : firstAfter(items, after)
		const pageItems = items.slice(start, start + request.limit)
		const end = start + pageItems.length
		return {
			status: 'ok',
			page: {
				items: pageItems,
				...(end < items.length && pageItems.length > 0 ? { nextCursor: encodeCursor(sortKey(pageItems.at(-1)!), scope) } : {}),
			},
		}
	}

	async function discoverKeys(kind: DiscoverableResourceKind): Promise<readonly string[]> {
		switch (kind) {
			case 'view': return persistence.views.discoverKeys()
			case 'flow': return persistence.flows.discoverKeys()
			case 'locale': return persistence.locales.discover()
		}
	}

	async function summarizeUnreadable(kind: DiscoverableResourceKind, key: string, error: unknown): Promise<ResourceDiscoveryItem | undefined> {
		if (!(error instanceof PersistenceError) || error.code !== 'persistence.invalid_json') throw error
		const revision = kind === 'view' ? await persistence.views.readRevision(key)
			: kind === 'flow' ? await persistence.flows.readRevision(key)
				: await persistence.locales.readRevision(key)
		if (!revision) return undefined
		const diagnosticCount = Math.max(1, error.diagnostics.length)
		if (kind === 'view') return { kind, key, revision, diagnosticCount, summary: {} }
		if (kind === 'flow') return { kind, key, revision, diagnosticCount, summary: {} }
		return { kind, key, revision, diagnosticCount, summary: {} }
	}

	return {
		readPointResource,
		listPointResources: input => discover(input, 'list'),
		searchPointResources: input => discover(input, 'search'),
	}
}

type NormalizedDiscoveryRequest = Readonly<{
	kinds: readonly DiscoverableResourceKind[]
	query?: string
	cursor?: string
	limit: number
}>

function normalizeDiscoveryRequest(request: ResourceDiscoveryRequest, mode: 'list' | 'search'): NormalizedDiscoveryRequest {
	const selected = request.kinds ?? DISCOVERABLE_RESOURCE_KINDS
	const kinds = DISCOVERABLE_RESOURCE_KINDS.filter(kind => selected.includes(kind))
	return {
		kinds,
		...(mode === 'search' ? { query: request.query!.trim().toLowerCase() } : {}),
		...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
		limit: request.limit,
	}
}

function summarize(read: Exclude<PointResourceRead, { kind: 'workspace' }>): ResourceDiscoveryItem {
	switch (read.kind) {
		case 'view':
			return { kind: 'view', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { name: read.resource.name, ...(read.resource.feature ? { feature: read.resource.feature } : {}) } }
		case 'flow':
			return { kind: 'flow', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { name: read.resource.name } }
		case 'locale':
			return { kind: 'locale', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { messageCount: Object.keys(read.resource).length } }
	}
}

function matchesQuery(item: ResourceDiscoveryItem, query: string): boolean {
	const fields = item.kind === 'view'
		? [item.key, item.summary.name, item.summary.feature]
		: item.kind === 'flow' ? [item.key, item.summary.name] : [item.key]
	return fields.some(value => value?.toLowerCase().includes(query))
}

function sortKey(item: ResourceDiscoveryItem): string {
	return `${String(DISCOVERABLE_RESOURCE_KINDS.indexOf(item.kind)).padStart(2, '0')}:${item.key}`
}

function discoveryScope(request: NormalizedDiscoveryRequest): string {
	return JSON.stringify({ kinds: request.kinds, query: request.query ?? null })
}

function encodeCursor(after: string, scope: string): string {
	return Buffer.from(JSON.stringify({ v: 1, after, scope }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, scope: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return undefined
	try {
		const decoded = Buffer.from(cursor, 'base64url')
		if (decoded.toString('base64url') !== cursor) return undefined
		const value = JSON.parse(decoded.toString('utf8')) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		if (record.v !== 1 || typeof record.after !== 'string' || record.scope !== scope || Object.keys(record).sort().join(',') !== 'after,scope,v') return undefined
		return record.after
	}
	catch { return undefined }
}

function firstAfter(items: readonly ResourceDiscoveryItem[], after: string): number {
	const index = items.findIndex(item => compareAscii(sortKey(item), after) > 0)
	return index < 0 ? items.length : index
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
