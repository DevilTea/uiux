import type { WorkspaceAdapterSelection, WorkspaceManifest } from '../../src/domain/workspace/schema'

/**
 * Pure helpers behind the Workspace authoring pages (brief g): Workspace settings,
 * Locales and Assets. They hold no state and touch no network, so the pages stay thin
 * and the rules (payload shape, key diff, reference counting) are unit-tested.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON with object keys sorted, so two values compare equal regardless of key order. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (isObject(value)) {
		return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
	}
	return JSON.stringify(value ?? null)
}

export function sameJson(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b)
}

export function cloneJson<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

/**
 * Flattens a JSON value to `path → display string` leaves. Used to count unsaved changes
 * and to lay out the Compare dialog. Paths use JSON Pointer segments.
 */
export function flattenJson(value: unknown, prefix = ''): Map<string, string> {
	const out = new Map<string, string>()
	const visit = (node: unknown, path: string) => {
		if (Array.isArray(node)) {
			if (node.length === 0) out.set(path || '/', '[]')
			node.forEach((item, index) => visit(item, `${path}/${index}`))
			return
		}
		if (isObject(node)) {
			const keys = Object.keys(node).filter(key => node[key] !== undefined)
			if (keys.length === 0) out.set(path || '/', '{}')
			for (const key of keys.sort()) visit(node[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)
			return
		}
		out.set(path || '/', typeof node === 'string' ? node : JSON.stringify(node ?? null))
	}
	visit(value, prefix)
	return out
}

export type JsonDifference = Readonly<{ path: string; theirs?: string; yours?: string }>

/** Leaves that differ between two values; a missing side is `undefined`. */
export function diffJson(theirs: unknown, yours: unknown): JsonDifference[] {
	const left = flattenJson(theirs)
	const right = flattenJson(yours)
	const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
	return paths
		.filter(path => left.get(path) !== right.get(path))
		.map(path => ({ path, theirs: left.get(path), yours: right.get(path) }))
}

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

export type SettingsSectionId = 'general' | 'viewports' | 'themes' | 'adapters'
export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = ['general', 'viewports', 'themes', 'adapters']

export type SettingsPayload = Readonly<{
	i18n: WorkspaceManifest['i18n']
	adapters: WorkspaceManifest['adapters']
	viewports: WorkspaceManifest['viewports']
	themes: WorkspaceManifest['themes']
}>

/** The manifest fields that `update_workspace_settings` replaces as one document. */
export function settingsFromManifest(manifest: WorkspaceManifest): SettingsPayload {
	return {
		i18n: cloneJson(manifest.i18n ?? { defaultLocale: 'en-US' }),
		adapters: cloneJson(manifest.adapters ?? []),
		viewports: cloneJson(manifest.viewports ?? {}),
		themes: cloneJson(manifest.themes ?? {}),
	}
}

/**
 * `PUT /api/workspace/settings` is a full replace. Saving one section therefore resends every
 * other section exactly as the server last returned it, so an unsaved draft elsewhere on the
 * page is never written by accident.
 */
export function buildSettingsPayload(current: WorkspaceManifest, section: SettingsSectionId, value: unknown): SettingsPayload {
	const base = settingsFromManifest(current)
	switch (section) {
		case 'general': return { ...base, i18n: value as SettingsPayload['i18n'] }
		case 'viewports': return { ...base, viewports: value as SettingsPayload['viewports'] }
		case 'themes': return { ...base, themes: value as SettingsPayload['themes'] }
		case 'adapters': return { ...base, adapters: value as SettingsPayload['adapters'] }
	}
}

/** A Viewport or theme registry row. Unknown entry fields ride along untouched in `extra`. */
export type RegistryRow = {
	/** Stable identity for list rendering; never persisted. */
	uid: string
	key: string
	/** The key this row had when it was loaded; absent for rows added on this page. */
	savedKey?: string
	label: string
	width: number | null
	height: number | null
	extra: JsonObject
	dimensionExtra: JsonObject
}

export type RegistryKind = 'viewports' | 'themes'

let rowCounter = 0
export function nextRowUid(): string {
	rowCounter += 1
	return `row-${rowCounter}`
}

export function registryRows(record: Readonly<Record<string, unknown>> | undefined, kind: RegistryKind): RegistryRow[] {
	const rows = Object.entries(record ?? {}).map(([key, entry]): RegistryRow => {
		const object = isObject(entry) ? entry as JsonObject : {}
		const { label, dimensions, ...extra } = object
		const dims = isObject(dimensions) ? dimensions as JsonObject : {}
		const { width, height, ...dimensionExtra } = dims
		return {
			uid: nextRowUid(),
			key,
			savedKey: key,
			label: typeof label === 'string' ? label : '',
			width: typeof width === 'number' ? width : null,
			height: typeof height === 'number' ? height : null,
			extra: kind === 'viewports' ? extra : { ...extra, ...(dimensions !== undefined ? { dimensions } : {}) },
			dimensionExtra: kind === 'viewports' ? dimensionExtra : {},
		}
	})
	return kind === 'viewports' ? sortViewportsWidestFirst(rows) : rows
}

/** Viewports read widest first (then tallest, then by key), the order a reviewer scans sizes in. */
export function sortViewportsWidestFirst<T extends { key: string; width: number | null; height: number | null }>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => (b.width ?? -1) - (a.width ?? -1) || (b.height ?? -1) - (a.height ?? -1) || a.key.localeCompare(b.key))
}

export function registryRecord(rows: readonly RegistryRow[], kind: RegistryKind): Record<string, JsonObject> {
	const record: Record<string, JsonObject> = {}
	for (const row of rows) {
		const entry: JsonObject = { ...row.extra }
		if (row.label.trim()) entry.label = row.label.trim()
		if (kind === 'viewports') entry.dimensions = { ...row.dimensionExtra, width: row.width ?? 0, height: row.height ?? 0 }
		record[row.key.trim()] = entry
	}
	return record
}

export type RegistryRowIssue = 'keyRequired' | 'keyTaken' | 'keyWhitespace' | 'dimensionRequired'

/** Client-side checks that mirror the manifest validator, so a bad row never reaches the server. */
export function registryRowIssues(rows: readonly RegistryRow[], kind: RegistryKind): Map<string, RegistryRowIssue[]> {
	const issues = new Map<string, RegistryRowIssue[]>()
	const seen = new Map<string, number>()
	for (const row of rows) seen.set(row.key.trim(), (seen.get(row.key.trim()) ?? 0) + 1)
	for (const row of rows) {
		const list: RegistryRowIssue[] = []
		const key = row.key.trim()
		if (!key) list.push('keyRequired')
		else if (/\s/u.test(key)) list.push('keyWhitespace')
		else if ((seen.get(key) ?? 0) > 1) list.push('keyTaken')
		if (kind === 'viewports' && (!row.width || !row.height || row.width < 1 || row.height < 1)) list.push('dimensionRequired')
		if (list.length) issues.set(row.uid, list)
	}
	return issues
}

/** An Adapter selection row. `savedIndex` maps it to the resolution summary of the saved set. */
export type AdapterRow = {
	uid: string
	moduleSpecifier: string
	configText: string
	savedIndex?: number
}

export function adapterRows(adapters: readonly WorkspaceAdapterSelection[] | undefined): AdapterRow[] {
	return (adapters ?? []).map((adapter, index) => ({
		uid: nextRowUid(),
		moduleSpecifier: adapter.moduleSpecifier,
		configText: adapter.config === undefined ? '' : JSON.stringify(adapter.config, null, 2),
		savedIndex: index,
	}))
}

export type ParsedConfig = { ok: true; value: Json | undefined } | { ok: false }

export function parseAdapterConfig(text: string): ParsedConfig {
	if (!text.trim()) return { ok: true, value: undefined }
	try { return { ok: true, value: JSON.parse(text) as Json } }
	catch { return { ok: false } }
}

/** Adapter rows as the manifest stores them. A row whose config is not JSON keeps its text, so dirty-checking still sees it. */
export function adapterSelections(rows: readonly AdapterRow[]): WorkspaceAdapterSelection[] {
	return rows.map((row) => {
		const parsed = parseAdapterConfig(row.configText)
		const config = parsed.ok ? parsed.value : row.configText
		return { moduleSpecifier: row.moduleSpecifier.trim(), ...(config !== undefined ? { config } : {}) }
	})
}

/** Moves one item and returns a new array; out-of-range moves return the input unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items]
	const next = [...items]
	const [item] = next.splice(from, 1)
	next.splice(to, 0, item!)
	return next
}

/** The npm package name of a bare specifier (`@scope/name/sub` → `@scope/name`); undefined for `./` paths. */
export function packageNameOf(specifier: string): string | undefined {
	if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return undefined
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export type AdapterRepair =
	| Readonly<{ kind: 'command'; command: string }>
	| Readonly<{ kind: 'file'; path: string }>

/**
 * Repair guidance for an Adapter diagnostic. The Workbench never runs a package manager
 * (Part 8 10a); it only prints the command for the user to run in their own project.
 */
export function adapterRepair(code: string, moduleSpecifier: string): AdapterRepair | undefined {
	const packageName = packageNameOf(moduleSpecifier)
	if (code === 'adapter.resolution_failed' || code === 'adapter.manifest_load_failed') {
		if (packageName) return { kind: 'command', command: `pnpm add ${packageName}` }
		if (moduleSpecifier.startsWith('./')) return { kind: 'file', path: moduleSpecifier }
	}
	if (code === 'adapter.api_version_incompatible' && packageName)
		return { kind: 'command', command: `pnpm add ${packageName}@latest` }
	return undefined
}

/** The Adapter index a diagnostic path such as `/adapters/2/manifest` points at. */
export function adapterIndexOf(path: string): number | undefined {
	const match = /^\/adapters\/(\d+)(?:\/|$)/u.exec(path)
	return match ? Number(match[1]) : undefined
}

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

export type LocaleMessages = Readonly<Record<string, string>>

/** How a Locale cell reads. Empty and whitespace-only values are translation reminders (Part 5). */
export type LocaleCellState = 'value' | 'empty' | 'whitespace' | 'missing'

export function localeCellState(value: string | undefined): LocaleCellState {
	if (value === undefined) return 'missing'
	if (value === '') return 'empty'
	if (!value.trim()) return 'whitespace'
	return 'value'
}

export function isReminder(value: string | undefined): boolean {
	const state = localeCellState(value)
	return state === 'empty' || state === 'whitespace'
}

export type LocaleKeyDiff = Readonly<{ missing: readonly string[]; extra: readonly string[] }>

/** Keys a Locale lacks against the primary Locale, and keys it has that the primary does not. */
export function localeKeyDiff(primary: LocaleMessages, other: LocaleMessages): LocaleKeyDiff {
	return {
		missing: Object.keys(primary).filter(key => !Object.hasOwn(other, key)),
		extra: Object.keys(other).filter(key => !Object.hasOwn(primary, key)).sort(),
	}
}

/** Row order for the key × Locale table: the primary Locale's keys, then keys only others have. */
export function localeTableKeys(primary: string, drafts: Readonly<Record<string, LocaleMessages>>): string[] {
	const ordered = Object.keys(drafts[primary] ?? {})
	const seen = new Set(ordered)
	const rest = new Set<string>()
	for (const [locale, messages] of Object.entries(drafts)) {
		if (locale === primary) continue
		for (const key of Object.keys(messages)) if (!seen.has(key)) rest.add(key)
	}
	return [...ordered, ...[...rest].sort()]
}

/** Number of keys whose value was added, removed or changed. */
export function countMessageChanges(saved: LocaleMessages, draft: LocaleMessages): number {
	const keys = new Set([...Object.keys(saved), ...Object.keys(draft)])
	let changes = 0
	for (const key of keys) if (saved[key] !== draft[key]) changes += 1
	return changes
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Every Asset id bound anywhere in a JSON value through `{ "$asset": "<id>" }`. */
export function collectAssetReferences(value: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectAssetReferences(item, into)
	}
	else if (isObject(value)) {
		if (typeof value.$asset === 'string') into.add(value.$asset)
		for (const child of Object.values(value)) collectAssetReferences(child, into)
	}
	return into
}

/** `logo.final.svg` → `logo.final`. */
export function stripExtension(filename: string): string {
	const dot = filename.lastIndexOf('.')
	return dot > 0 ? filename.slice(0, dot) : filename
}

export function isImageMediaType(mediaType: string | undefined): boolean {
	return !!mediaType && mediaType.startsWith('image/')
}

/** Reads a Blob as canonical base64 (no data-URL prefix), the shape the Asset routes accept. */
export async function blobToBase64(blob: Blob): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		// No browser wording reaches the UI: callers show their own localized "couldn't read" message.
		reader.onerror = () => reject(Object.assign(new Error(''), { cause: reader.error }))
		reader.readAsDataURL(blob)
	})
	return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
