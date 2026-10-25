import { jsonPointer, Validator, type ValidationResult } from '../validation'
import type { AdapterManifest } from './schema'

const SOURCE_SLOTS = ['semantic', 'renderer', 'designSystem', 'supporting'] as const
const SOURCE_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/u

/**
 * Whether a file reference's `path` is relative and stays inside its root as written (Clause
 * 01a11a5a-45a7-7139-ac1c-d3881976eb71): non-empty, no leading separator or drive, no backslash, no NUL, no percent-encoded dot or separator,
 * and no empty, `.` or `..` segment. Whether the file's real path stays inside is judged when Handoff reads it.
 */
export function isContainedSourcePath(path: string): boolean {
	if (path.length === 0 || path.includes('\0') || path.includes('\\') || /%(?:2e|2f|5c)/iu.test(path) || path.startsWith('/') || /^[a-z]:/iu.test(path)) return false
	return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * The shape and ownership of `sources` (Clauses 01a11a5a-4511-72d3-9269-cc112056f743 and
 * 01a11a5a-45a7-7139-ac1c-d3881976eb71, Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a): when present, an
 * object keyed by Widget types the same Adapter owns (`ownedWidgetTypes`), each entry `{ semantic,
 * renderer, designSystem?, supporting? }` of file references `{ path, package?, embed? }` or
 * provenance-only `{ url }`. A foreign key or a malformed entry makes the Adapter invalid on every
 * surface. Nothing is read from disk. `path` is the manifest's path.
 */
export function validateAdapterSources(manifest: AdapterManifest, ownedWidgetTypes: readonly string[], path = ''): ValidationResult<AdapterManifest['sources']> {
	const v = new Validator()
	if (Object.hasOwn(manifest, 'sources')) {
		const sources = v.object(manifest.sources, `${path}/sources`)
		if (sources) {
			const owned = new Set(ownedWidgetTypes)
			for (const [widgetType, entryValue] of Object.entries(sources)) {
				const entryPath = jsonPointer(`${path}/sources`, widgetType)
				if (!owned.has(widgetType))
					v.issue('adapter.invalid_sources', entryPath, `sources of Adapter ${manifest.id} names ${widgetType}, which that Adapter does not own.`)
				const entry = v.object(entryValue, entryPath)
				if (!entry) continue
				for (const key of Object.keys(entry)) {
					if (!(SOURCE_SLOTS as readonly string[]).includes(key))
						v.issue('adapter.invalid_sources', jsonPointer(entryPath, key), `The sources entry of ${widgetType} has the unknown member ${key}.`)
				}
				for (const slot of ['semantic', 'renderer'] as const) {
					if (!Object.hasOwn(entry, slot)) v.issue('adapter.invalid_sources', jsonPointer(entryPath, slot), `The sources entry of ${widgetType} requires ${slot}.`)
					else validateAdapterSourceRef(entry[slot], jsonPointer(entryPath, slot), v)
				}
				if (Object.hasOwn(entry, 'designSystem')) validateAdapterSourceRef(entry.designSystem, jsonPointer(entryPath, 'designSystem'), v)
				if (Object.hasOwn(entry, 'supporting')) {
					const supportingPath = jsonPointer(entryPath, 'supporting')
					const supporting = v.array(entry.supporting, supportingPath)
					supporting?.forEach((ref, index) => validateAdapterSourceRef(ref, jsonPointer(supportingPath, index), v))
				}
			}
		}
	}
	return v.finish<AdapterManifest['sources']>(manifest.sources)
}

function validateAdapterSourceRef(input: unknown, path: string, v: Validator): void {
	const ref = v.object(input, path)
	if (!ref) return
	const keys = Object.keys(ref)
	if (Object.hasOwn(ref, 'url')) {
		if (keys.length !== 1) v.issue('adapter.invalid_sources', path, 'A url source has no other member.')
		const valid = typeof ref.url === 'string' && URL.canParse(ref.url) && /^https?:$/u.test(new URL(ref.url).protocol)
		if (!valid) v.issue('adapter.invalid_sources', `${path}/url`, 'A url source is an absolute http or https URL.')
		return
	}
	for (const key of keys) {
		if (key !== 'path' && key !== 'package' && key !== 'embed')
			v.issue('adapter.invalid_sources', jsonPointer(path, key), `A file source has the unknown member ${key}.`)
	}
	if (typeof ref.path !== 'string' || !isContainedSourcePath(ref.path))
		v.issue('adapter.invalid_sources', `${path}/path`, 'A file source path is relative and stays inside its root.')
	if (Object.hasOwn(ref, 'package') && (typeof ref.package !== 'string' || !SOURCE_PACKAGE_NAME.test(ref.package)))
		v.issue('adapter.invalid_sources', `${path}/package`, 'A file source package is a package name.')
	if (Object.hasOwn(ref, 'embed') && typeof ref.embed !== 'boolean')
		v.issue('adapter.invalid_sources', `${path}/embed`, 'A file source embed is a boolean.')
}
