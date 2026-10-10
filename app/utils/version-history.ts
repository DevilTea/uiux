import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { HistoryVersionType } from '../../src/domain/history/constants'
import type { HistoryActor, VersionRecord } from '../../src/domain/history/schema'
import type { VersionListItem } from '../../src/application/services/history-service'

/**
 * The Workbench version timeline's pure parts (issue #132, B8): the history address keys, the
 * comparison a selection asks for, the timeline grouping and its filters. The components and the
 * composable fetch; everything here is framework-free and unit-tested.
 */

export type HistoryResourceRef = Readonly<{ kind: string; key: string }>

/** `canvas` (Clause 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41): side by side or change highlighting (B9). */
export const HISTORY_CANVAS_MODES = ['side', 'highlight'] as const
export type HistoryCanvasMode = typeof HISTORY_CANVAS_MODES[number]

/** The `compare` values that name no version (Clause 01a11e0d-d74b-701a-9a25-a149e400b7ec). */
export const PARENT_COMPARE = 'parent'
export const CURRENT_COMPARE = 'current'

/**
 * What the address holds, exactly as written: an omitted key stays omitted, so a copied link
 * reopens the same selection and nothing is ever added to the address on its own (owner ruling
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18834723).
 */
export type HistoryAddress = Readonly<{
	version?: string
	compare?: string
	resource?: HistoryResourceRef
	canvas?: HistoryCanvasMode
}>

/** The comparison the address asks for once the defaults apply. */
export type HistorySelection = Readonly<{
	version: string
	/** `parent`, `current` or a version ID; `parent` when the address omits it. */
	compare: string
	/** Only these resources' diffs are shown; every changed resource when omitted. */
	resource?: HistoryResourceRef
	/** The canvas comparison (B9); the change list only when omitted. */
	canvas?: HistoryCanvasMode
}>

function single(value: LocationQuery[string] | undefined): string {
	const first = Array.isArray(value) ? value[0] : value
	return typeof first === 'string' ? first.trim() : ''
}

/** `<kind>:<key>`, split at the first colon (the server's `resource` parameter). */
export function parseResourceRef(value: string): HistoryResourceRef | undefined {
	const separator = value.indexOf(':')
	if (separator <= 0 || separator === value.length - 1) return undefined
	return { kind: value.slice(0, separator), key: value.slice(separator + 1) }
}

export function formatResourceRef(resource: HistoryResourceRef): string {
	return `${resource.kind}:${resource.key}`
}

export function sameResource(left: HistoryResourceRef | undefined, right: HistoryResourceRef | undefined): boolean {
	return !!left && !!right && left.kind === right.kind && left.key === right.key
}

/** Reads `version`, `compare`, `resource` and `canvas`; an empty or malformed value counts as omitted. */
export function parseHistoryAddress(query: LocationQuery): HistoryAddress {
	const version = single(query.version)
	const compare = single(query.compare)
	const resource = parseResourceRef(single(query.resource))
	const canvas = single(query.canvas)
	return {
		...(version ? { version } : {}),
		...(compare ? { compare } : {}),
		...(resource ? { resource } : {}),
		...((HISTORY_CANVAS_MODES as readonly string[]).includes(canvas) ? { canvas: canvas as HistoryCanvasMode } : {}),
	}
}

/** The address keys of a selection, with only the keys it holds. */
export function historyQuery(address: HistoryAddress, keys: readonly (keyof HistoryAddress)[] = ['version', 'compare', 'resource', 'canvas']): LocationQueryRaw {
	const query: LocationQueryRaw = {}
	if (keys.includes('version') && address.version) query.version = address.version
	if (keys.includes('compare') && address.compare) query.compare = address.compare
	if (keys.includes('resource') && address.resource) query.resource = formatResourceRef(address.resource)
	if (keys.includes('canvas') && address.canvas) query.canvas = address.canvas
	return query
}

/**
 * The defaults of the owner ruling (discussioncomment-18834723): `version` without `compare`
 * compares with the parent; without `version` there is no comparison, only the timeline (a
 * `compare` alone selects nothing).
 */
export function resolveHistorySelection(address: HistoryAddress): HistorySelection | undefined {
	if (!address.version) return undefined
	return {
		version: address.version,
		compare: address.compare ?? PARENT_COMPARE,
		...(address.resource ? { resource: address.resource } : {}),
		...(address.canvas ? { canvas: address.canvas } : {}),
	}
}

/** The two sides of `GET /api/history/diff`: `from` a version ID or `parent`, `to` a version ID or `current`. */
export type ComparisonEndpoints = Readonly<{ from: string; to: string }>

/**
 * The older side is `from`. With another version the two are ordered by their timestamps when
 * both are known (`at` looks one up), else the compared version is taken as the older one.
 */
export function comparisonEndpoints(selection: Pick<HistorySelection, 'version' | 'compare'>, at: (id: string) => string | undefined = () => undefined): ComparisonEndpoints {
	if (selection.compare === PARENT_COMPARE) return { from: PARENT_COMPARE, to: selection.version }
	if (selection.compare === CURRENT_COMPARE) return { from: selection.version, to: CURRENT_COMPARE }
	const selected = at(selection.version)
	const other = at(selection.compare)
	if (selected !== undefined && other !== undefined && other > selected) return { from: selection.version, to: selection.compare }
	return { from: selection.compare, to: selection.version }
}

/** The query of `GET /api/history/diff`. */
export function diffRequestQuery(endpoints: ComparisonEndpoints, resources: readonly HistoryResourceRef[] = [], detail: 'summary' | 'semantic' = 'semantic'): Record<string, string | string[]> {
	return {
		from: endpoints.from,
		to: endpoints.to,
		...(resources.length ? { resource: resources.map(formatResourceRef) } : {}),
		detail,
	}
}

// ----- Timeline filters ----------------------------------------------------------------------

/** Rule 01a11a5e-199c-712f-b982-bb506c4954c8: actor, resource kind and Checkpoints only. */
export type TimelineFilters = Readonly<{
	/** An actor filter value (see `actorFilterValue`); every actor when omitted. */
	actor?: string
	/** A resource kind a version must have changed; every kind when omitted. */
	kind?: string
	checkpointsOnly?: boolean
}>

/** The value `GET /api/history/versions?actor=` takes for this actor: its ID, or `external`. */
export function actorFilterValue(actor: HistoryActor): string {
	return actor.type === 'external' ? 'external' : actor.id ?? ''
}

/**
 * The listing query: the server filters by type and actor and projects one resource; the kind
 * filter needs the changed-resource summary, so it is applied to the listed rows (`matchesKind`).
 */
export function versionListQuery(filters: TimelineFilters, page: Readonly<{ resource?: HistoryResourceRef; limit?: number; cursor?: string }> = {}): Record<string, string | string[]> {
	return {
		...(filters.checkpointsOnly ? { type: ['checkpoint'] satisfies HistoryVersionType[] } : {}),
		...(filters.actor ? { actor: filters.actor } : {}),
		...(page.resource ? { resource: formatResourceRef(page.resource) } : {}),
		...(page.limit ? { limit: String(page.limit) } : {}),
		...(page.cursor ? { cursor: page.cursor } : {}),
	}
}

export function matchesKind(version: Pick<VersionListItem, 'summary'>, kind: string | undefined): boolean {
	return !kind || version.summary.some(resource => resource.kind === kind)
}

/** Every filter applied to already listed rows; the server applies the type and actor ones too. */
export function filterVersions<V extends Pick<VersionListItem, 'type' | 'actor' | 'summary'>>(versions: readonly V[], filters: TimelineFilters): V[] {
	return versions.filter(version =>
		(!filters.checkpointsOnly || version.type === 'checkpoint')
		&& (!filters.actor || actorFilterValue(version.actor) === filters.actor)
		&& matchesKind(version, filters.kind))
}

/** The distinct actors of the listed rows, in first-seen order. */
export function distinctActors(versions: readonly Pick<VersionListItem, 'actor'>[]): HistoryActor[] {
	const seen = new Map<string, HistoryActor>()
	for (const { actor } of versions) {
		const value = actorFilterValue(actor)
		if (value && !seen.has(value)) seen.set(value, actor)
	}
	return [...seen.values()]
}

// ----- Grouping ------------------------------------------------------------------------------

/** Rule 01a11a5e-19f4-77a0-8e8b-30ea280b7b24: an autosave whose writes cancelled out. */
export function isNoNetChange(version: Pick<VersionListItem, 'type' | 'netChange'>): boolean {
	return version.type === 'autosave' && version.netChange === false
}

/** A timeline row: one version, or a collapsed run of consecutive autosaves with no net change. */
export type TimelineEntry<V> =
	| Readonly<{ type: 'version'; version: V }>
	| Readonly<{ type: 'quiet'; id: string; versions: readonly V[] }>

export function collapseNoNetChange<V extends Pick<VersionListItem, 'id' | 'type' | 'netChange'>>(versions: readonly V[]): TimelineEntry<V>[] {
	const entries: TimelineEntry<V>[] = []
	let run: V[] = []
	const flush = () => {
		if (run.length) entries.push({ type: 'quiet', id: run[0]!.id, versions: run })
		run = []
	}
	for (const version of versions) {
		if (isNoNetChange(version)) { run.push(version); continue }
		flush()
		entries.push({ type: 'version', version })
	}
	flush()
	return entries
}

export type DayGroup<V> = Readonly<{ day: string; entries: readonly TimelineEntry<V>[] }>

/** `YYYY-MM-DD` in the browser's own time zone. */
export function localDayKey(at: string): string {
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return ''
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Rule 01a11a5e-1946-7217-aff5-db13df3a2977: versions newest first, grouped by day; within a day,
 * consecutive autosaves with no net change collapse into one row. The input is the listing's
 * newest-first order, which is kept.
 */
export function groupVersionsByDay<V extends Pick<VersionListItem, 'id' | 'type' | 'netChange' | 'at'>>(versions: readonly V[], dayKey: (at: string) => string = localDayKey): DayGroup<V>[] {
	const days: { day: string; versions: V[] }[] = []
	for (const version of versions) {
		const day = dayKey(version.at)
		const last = days.at(-1)
		if (last && last.day === day) last.versions.push(version)
		else days.push({ day, versions: [version] })
	}
	return days.map(group => ({ day: group.day, entries: collapseNoNetChange(group.versions) }))
}

// ----- "Changes since you last looked" -------------------------------------------------------

/** The revision a version record holds for a resource, if it holds the resource. */
export function revisionIn(record: Pick<VersionRecord, 'resources'>, resource: HistoryResourceRef): string | undefined {
	return record.resources.find(entry => entry.kind === resource.kind && entry.key === resource.key)?.revision
}

/** The Activity address of a comparison, `/?tab=activity&version=…&compare=…&resource=…`. */
export function activityLocation(address: HistoryAddress) {
	return { path: '/', query: { tab: 'activity', ...historyQuery(address, ['version', 'compare', 'resource']) } }
}

// ----- System Checkpoint names -----------------------------------------------------------------

const MIGRATION_TARGET = /schemaVersion (\d+)$/u

/**
 * Which localized title a system Checkpoint gets, keyed by the system actor that created it (owner
 * ruling https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18844687); `undefined`
 * for a member's Checkpoint, whose name is shown as written, and for any other version.
 */
export function systemCheckpointTitle(version: Readonly<{ type: string; name?: string | null; actor: HistoryActor }>): Readonly<{ key: 'baseline' } | { key: 'migrate'; target: string }> | undefined {
	if (version.type !== 'checkpoint' || !version.name || version.actor.type !== 'system') return undefined
	if (version.actor.id === 'system:baseline') return { key: 'baseline' }
	const target = MIGRATION_TARGET.exec(version.name)?.[1]
	if (version.actor.id === 'system:migrate' && target) return { key: 'migrate', target }
	return undefined
}
