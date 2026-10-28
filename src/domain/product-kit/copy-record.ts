import {
	isSafeRelativePath,
	jsonPointer,
	rejectUnknownKeys,
	segmentNamesInAnyCase,
	validateDigest,
	validateUtcTimestamp,
	Validator,
	type ValidationResult,
} from '../validation'
import { isProductKitComponentName } from './schema'

/**
 * The copy record (Clauses 01a11bb1-8bd0-72ce-83e5-b251bf855e0f and 01a11bb1-8c36-7cf9-943b-526a4c2bc514):
 * the file `uiux-components.json` at the product project root, `{ formatVersion: 1, components }`.
 * Each entry is `{ target, componentDigest, exportedAt, files }`; `target` and the `files` keys are
 * relative to the product project root, and each file's `source` is relative to `kit/`. It names no
 * Workspace path or identity. One record per product project covers every component copied into
 * it (Rule 01a11bb1-a3de-7426-94d2-c0e2bdd0be72); UIUX keeps no other (Rule 01a11bb1-a5cf-7723-8b36-e6dc808381e1).
 */
export const COPY_RECORD_FILENAME = 'uiux-components.json'
export const COPY_RECORD_FORMAT_VERSION = 1

export type CopyRecordFile = { source: string; digest: string }
export type CopyRecordEntry = {
	target: string
	componentDigest: string
	exportedAt: string
	files: Record<string, CopyRecordFile>
}
export type CopyRecord = { formatVersion: typeof COPY_RECORD_FORMAT_VERSION; components: Record<string, CopyRecordEntry> }

/** The kit's source directory, under which every registry file lies (Clause 01a11bb1-8a44-…). */
const KIT_SOURCE_PREFIX = 'src/'

export function emptyCopyRecord(): CopyRecord {
	return { formatVersion: COPY_RECORD_FORMAT_VERSION, components: {} }
}

/**
 * Where a copy of the kit file `source` (`src/…`, relative to `kit/`) lies for the target directory
 * `target`: its path relative to the kit's source directory, under the target (Rule
 * 01a11bb1-a376-719c-86e0-5f5e4d11cb8c). Both are project-relative.
 */
export function copyDestination(target: string, source: string): string {
	return `${target}/${copyPathBelowTarget(source)}`
}

/** Where a copy of the kit file `source` (`src/…`) lies relative to its target directory: its path relative to `kit/src/`. */
export function copyPathBelowTarget(source: string): string {
	return source.slice(KIT_SOURCE_PREFIX.length)
}

/**
 * Validates a copy record. Paths must be plain relative paths (no empty, `.` or `..` segment, no
 * backslash or control character), so a record can never name a file outside the product project
 * or `kit/src/`; each `files` key must be the copy destination of its `source` under `target`.
 * Whether a recorded path stays out of the Workspace and of `.git` depends on where the project and
 * the Workspace lie, so `uiux components` checks that itself before acting on a record.
 */
export function validateCopyRecord(input: unknown): ValidationResult<CopyRecord> {
	const v = new Validator()
	const root = v.object(input, '')
	if (!root) return v.finish<CopyRecord>(input)
	rejectUnknownKeys(root, ['formatVersion', 'components'], '', v)
	if (root.formatVersion !== COPY_RECORD_FORMAT_VERSION)
		v.issue('copy_record.unsupported_format', '/formatVersion', `formatVersion is ${COPY_RECORD_FORMAT_VERSION}.`)
	const components = v.object(root.components, '/components')
	for (const [name, value] of Object.entries(components ?? {})) {
		const path = jsonPointer('/components', name)
		if (!isProductKitComponentName(name))
			v.issue('product_kit.invalid_component_name', path, 'A component name is lowercase words joined by single hyphens.')
		const entry = v.object(value, path)
		if (!entry) continue
		rejectUnknownKeys(entry, ['target', 'componentDigest', 'exportedAt', 'files'], path, v)
		const target = isSafeRelativePath(entry.target) ? entry.target : undefined
		if (target === undefined)
			v.issue('copy_record.invalid_path', `${path}/target`, 'target is a directory path relative to the product project root.')
		validateDigest(entry.componentDigest, `${path}/componentDigest`, v)
		validateUtcTimestamp(entry.exportedAt, `${path}/exportedAt`, v)
		const files = v.object(entry.files, `${path}/files`)
		for (const [file, recorded] of Object.entries(files ?? {})) {
			const filePath = jsonPointer(`${path}/files`, file)
			const fileEntry = v.object(recorded, filePath)
			if (!fileEntry) continue
			rejectUnknownKeys(fileEntry, ['source', 'digest'], filePath, v)
			const source = fileEntry.source
			if (!isSafeRelativePath(source) || !source.startsWith(KIT_SOURCE_PREFIX) || source.length === KIT_SOURCE_PREFIX.length)
				v.issue('copy_record.invalid_path', `${filePath}/source`, 'source is a file path relative to kit/ under kit/src/.')
			else if (target !== undefined && file !== copyDestination(target, source))
				v.issue('copy_record.invalid_path', filePath, `A copied file lies at its source path relative to kit/src/, under the target ${target}.`)
			validateDigest(fileEntry.digest, `${filePath}/digest`, v)
		}
	}
	return v.finish<CopyRecord>(input)
}

/** True when a segment of the project-relative path `path` is `.git`, in any letter case (`segmentNamesInAnyCase`). */
export function hasGitSegment(path: string): boolean {
	return path.split('/').some(segment => segmentNamesInAnyCase(segment, '.git'))
}

/**
 * The pairs of distinct paths in `paths` that differ only in letter case or Unicode normalization,
 * which a case-insensitive file system (the macOS default) treats as one file. Two paths match by
 * the fold of `segmentNamesInAnyCase`: after NFC normalization their upper case or their lower case
 * agree (so `Foſ` matches `Fos`, whose upper cases agree). Each pair names the path seen first, then
 * the other.
 */
export function caseOnlyCollisions(paths: Iterable<string>): Array<readonly [string, string]> {
	const byUpper = new Map<string, string>()
	const byLower = new Map<string, string>()
	const pairs: Array<readonly [string, string]> = []
	for (const path of new Set(paths)) {
		const normalized = path.normalize('NFC')
		const upper = normalized.toUpperCase()
		const lower = normalized.toLowerCase()
		const seen = byUpper.get(upper) ?? byLower.get(lower)
		if (seen !== undefined) {
			pairs.push([seen, path])
			continue
		}
		byUpper.set(upper, path)
		byLower.set(lower, path)
	}
	return pairs
}

/** The record as JSON text: keys sorted, two-space indentation and a final newline. */
export function serializeCopyRecord(record: CopyRecord): string {
	return `${JSON.stringify(sortKeys(record), null, 2)}\n`
}

function sortKeys(value: unknown): unknown {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]))
}

/** The drift states of a file (Clause 01a11bb1-8c9b-78a8-b359-c083412d9789). */
export const DRIFT_STATES = Object.freeze(['unchanged', 'modified', 'upstream', 'diverged', 'missing', 'removed', 'added'] as const)
export type DriftState = typeof DRIFT_STATES[number]

/** The drift states of a recorded file: every state but `added`, which belongs to a file the record does not list. */
export type RecordedDriftState = Exclude<DriftState, 'added'>

/**
 * The files that a recorded component's registry entry lists and its copy record entry does not
 * (state `added`, Clause 01a11bb1-8c9b-78a8-b359-c083412d9789), sorted by path. `declared` is the
 * entry's `files` (sources relative to `kit/`) and `recorded` the `source` of each recorded file. An
 * added file lies where `uiux components add` would copy it, under the recorded `target`
 * (`copyDestination`); a component the entry newly requires adds no file, since only the
 * component's own `files` are read. `target` is `undefined` when the caller holds none, and `path`
 * then is `undefined` too.
 */
export function addedFiles(input: Readonly<{
	declared: readonly string[]
	recorded: Iterable<string>
	target: string | undefined
}>): Array<Readonly<{ source: string; path: string | undefined }>> {
	const recorded = new Set(input.recorded)
	const result = new Map<string, Readonly<{ source: string; path: string | undefined }>>()
	for (const source of input.declared) {
		if (recorded.has(source) || result.has(source)) continue
		result.set(source, { source, path: input.target === undefined ? undefined : copyDestination(input.target, source) })
	}
	const key = (file: Readonly<{ source: string; path: string | undefined }>) => file.path ?? file.source
	return [...result.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

/**
 * The drift state of a copied file (Clause 01a11bb1-8c9b-78a8-b359-c083412d9789, Rule
 * 01a11bb1-a630-7c7c-8dd3-5e0a11e4e919), for a file the copy record lists (`addedFiles` finds the `added` ones): `removed` when its component is no longer in the registry,
 * else `missing` when the copy is gone, else the comparison of the copy and of the Workspace original
 * with the recorded digest. An original that is gone, or that the component no longer declares,
 * differs from the record.
 */
export function driftState(input: Readonly<{
	recorded: string
	/** The copy's digest, or `undefined` when the copy is gone. */
	copy: string | undefined
	/** The Workspace original's digest, `undefined` when it is gone, or `removed` when its component is. */
	original: string | undefined | 'removed'
}>): RecordedDriftState {
	if (input.original === 'removed') return 'removed'
	if (input.copy === undefined) return 'missing'
	const modified = input.copy !== input.recorded
	const upstream = input.original !== input.recorded
	if (modified && upstream) return 'diverged'
	if (modified) return 'modified'
	if (upstream) return 'upstream'
	return 'unchanged'
}
