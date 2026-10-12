import { isCatalogKey } from '../access/keys'
import {
	ACCESS_PRESETS_FILENAME,
	ACCESS_PRESETS_RESOURCE_KEY,
	ACCESS_PRESETS_RESOURCE_KIND,
	ACCESS_PRESETS_SCHEMA_VERSION,
	accessPresetsRuleDiagnostics,
	labelPresetsOf,
	orderPresetKeys,
	validateAccessPresetsShape,
	type AccessPresetsFile,
} from '../../domain/access-presets/schema'
import { isRecord, jsonPointer, type Diagnostic } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'

/**
 * The Access presets operations (Feature 01a11c09-984a-7835-95ef-67164dd91746), over HTTP only
 * (Rule 01a11c09-cbea-7341-9d5a-01719e9c5d94): reading the Access presets file, and
 * `update_access_presets` (Clause 01a11c09-a50e-7531-b16e-74ba685c6bad), which takes
 * `{ expectedRevision, presets }` and replaces the whole `presets` array with compare-and-swap.
 *
 * The written file must have the file's shape (each preset's keys are stored in catalog order) and
 * keep the rules of Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74: a write that would make two
 * presets equal (`access.preset_duplicate`, Rule 01a11c09-c7ff-72bb-8afe-2a7d1dc1024d), give two
 * presets one name ignoring case (`access.preset_name_taken`) or leave a requirement of a key out
 * (`access.key_requires`) is refused, and nothing is written. A key unknown to this UIUX version is
 * kept when the current file already holds it, as a newer UIUX wrote it, and refused with
 * `access.unknown_key` otherwise (#140 owner ruling 1 of 2026-10-11: a key newly supplied over HTTP
 * must be in the catalog). Editing presets never changes a member's keys (Rule
 * 01a11c09-ca2d-7b0e-b428-e2d66f5252dd): it writes only this file.
 *
 * A `schemaVersion` 6 Workspace whose presets file is missing is not blocked, since presets only
 * affect labels (Rule 01a12f98-c032-7e1f-806c-41648565004c): its read answers no resource with
 * `access.presets_missing` (Clause 01a12f98-f466-7c86-af94-5887f1d1b50d), and a write whose
 * `expectedRevision` is `null` creates the file (Rule 01a12f98-d643-7e29-9273-23564146d518).
 *
 * Access (`workspace.read` to read, `presets.manage` to write) and the design-write context belong
 * to the scoped session. Below `schemaVersion` 6 the Workspace has no presets file: reads find none,
 * and the write refuses with `workspace.migration_required`.
 */
export type UpdateAccessPresetsCommand = Readonly<{
	/** The revision of the file the write replaces, or `null` to create the file while there is none. */
	expectedRevision: string | null
	presets: readonly unknown[]
}>

type Key = typeof ACCESS_PRESETS_RESOURCE_KEY

export type AccessPresetsAuthoringResult =
	| Readonly<{ status: 'updated' | 'created'; key: Key; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'not_found'; key: Key }>
	| Readonly<{ status: 'conflict'; key: Key; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: Key; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: Key; code?: string; message?: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'blocked'; key: Key; code: string; message: string; diagnostics: readonly Diagnostic[] }>

/**
 * The Access presets resource: the file as it is, with its diagnostics on disk (Rule
 * 01a11c09-cb08-7007-bcdd-8a04e54d02b5). `resource` and `revision` are `null` while a
 * `schemaVersion` 6 Workspace has no presets file (Clause 01a12f98-f466-7c86-af94-5887f1d1b50d).
 */
export type AccessPresetsRead = Readonly<{
	kind: typeof ACCESS_PRESETS_RESOURCE_KIND
	key: Key
	resource: AccessPresetsFile | null
	revision: ResourceRevision | null
	diagnostics: readonly Diagnostic[]
}>

export type AccessPresetsAuthoringService = Readonly<{
	/** The Access presets resource, or `undefined` below `schemaVersion` 6, where a Workspace keeps no presets file. */
	readAccessPresets(): Promise<AccessPresetsRead | undefined>
	updateAccessPresets(command: UpdateAccessPresetsCommand): Promise<AccessPresetsAuthoringResult>
}>

const KEY: Key = ACCESS_PRESETS_RESOURCE_KEY

/**
 * The presets a write stores: each preset's keys in catalog order, then any unknown keys in the
 * order given. A preset whose keys are not an array of unique strings is left as it is, so the
 * shape check reports it.
 */
export function normalizeAccessPresets(presets: readonly unknown[]): unknown[] {
	return presets.map((preset) => {
		if (!isRecord(preset) || !Array.isArray(preset.keys)) return preset
		const keys = preset.keys
		if (!keys.every(key => typeof key === 'string') || new Set(keys).size !== keys.length) return preset
		return { ...preset, keys: orderPresetKeys(keys as string[]) }
	})
}

/**
 * The checks a presets write makes on the file it writes, `current` being the file it replaces (or
 * `undefined`): its shape, the rules of Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74 and the keys
 * outside the catalog the current file does not already hold. Also used by a restore of the
 * `access-presets` resource, which writes a version's file through the same checks.
 */
export function accessPresetsWriteDiagnostics(next: unknown, current: unknown): readonly Diagnostic[] {
	const shape = validateAccessPresetsShape(next)
	if (!shape.ok) return shape.diagnostics
	const rules = accessPresetsRuleDiagnostics(shape.value.presets, { unknownKeys: 'ignore' })
	const stored = new Set(labelPresetsOf(current).flatMap(preset => preset.keys))
	const unknown: Diagnostic[] = []
	shape.value.presets.forEach((preset, index) => {
		const added = preset.keys.filter(key => !isCatalogKey(key) && !stored.has(key))
		if (added.length > 0)
			unknown.push({ code: 'access.unknown_key', path: jsonPointer('/presets', index), message: `${added.map(key => `\`${key}\``).join(', ')} ${added.length > 1 ? 'are not permission keys' : 'is not a permission key'} of this UIUX version, so preset ${JSON.stringify(preset.name)} cannot be given ${added.length > 1 ? 'them' : 'it'}.` })
	})
	return [...rules, ...unknown]
}

/** Clause 01a12f98-f466-7c86-af94-5887f1d1b50d: a `schemaVersion` 6 Workspace without its presets file. */
const PRESETS_MISSING: Diagnostic = Object.freeze({
	code: 'access.presets_missing',
	path: `/${ACCESS_PRESETS_FILENAME}`,
	message: `This Workspace has no ${ACCESS_PRESETS_FILENAME}, so no preset labels a member. Saving the Access presets with expectedRevision null creates it.`,
})

export function createAccessPresetsAuthoringService(persistence: FileNativePersistence): AccessPresetsAuthoringService {
	function blocked(code: string, message: string, diagnostics: readonly Diagnostic[]): AccessPresetsAuthoringResult {
		return { status: 'blocked', key: KEY, code, message, diagnostics: diagnostics.length > 0 ? diagnostics : [{ code, path: '/schemaVersion', message }] }
	}

	/**
	 * Whether the Workspace keeps a presets file: from `schemaVersion` 6 (Clause
	 * 01a11c09-a855-7d7e-93ec-cd9a85fdb65e). A file at that path below 6 is not the Workspace's.
	 */
	async function keepsPresetsFile(): Promise<boolean> {
		if (!persistence.layout.accessPresetsPath) return false
		try {
			const { inspection } = await persistence.inspectWorkspace()
			return 'version' in inspection && inspection.version !== undefined && inspection.version >= ACCESS_PRESETS_SCHEMA_VERSION
		}
		catch (error) {
			if (error instanceof PersistenceError) return false
			throw error
		}
	}

	async function readAccessPresets(): Promise<AccessPresetsRead | undefined> {
		if (!await keepsPresetsFile()) return undefined
		const read = await persistence.accessPresets.readInspected()
		if (!read) return { kind: ACCESS_PRESETS_RESOURCE_KIND, key: KEY, resource: null, revision: null, diagnostics: [PRESETS_MISSING] }
		return { kind: ACCESS_PRESETS_RESOURCE_KIND, key: KEY, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
	}

	async function updateAccessPresets(command: UpdateAccessPresetsCommand): Promise<AccessPresetsAuthoringResult> {
		// `null` names the absent file (Clause 01a11c09-a50e-7531-b16e-74ba685c6bad).
		const creating = command.expectedRevision === null
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!creating && !expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: KEY, diagnostics: expectedRevision.diagnostics }
		const legacy = `Access presets exist from Workspace schemaVersion ${ACCESS_PRESETS_SCHEMA_VERSION}. Run: uiux migrate --workspace <dir>`
		if (!persistence.layout.accessPresetsPath) return blocked('workspace.migration_required', legacy, [])

		try {
			const workspace = await persistence.workspace.readInspected()
			if (workspace.inspection.state === 'migration_required')
				return blocked('workspace.migration_required', `The Workspace requires migration before its Access presets can be changed. ${legacy}`, workspace.diagnostics)
			if (workspace.inspection.state !== 'current')
				return blocked('workspace.schema_unsupported', 'This UIUX build cannot change the Access presets of this Workspace.', workspace.diagnostics)

			const current = await persistence.accessPresets.readInspected()
			if (!current && !creating) return { status: 'not_found', key: KEY }
			if (current && (!expectedRevision.ok || current.revision !== expectedRevision.value))
				return { status: 'conflict', key: KEY, currentRevision: current.revision }

			const next = { presets: normalizeAccessPresets(command.presets) }
			const diagnostics = accessPresetsWriteDiagnostics(next, current?.resource)
			if (diagnostics.length > 0) {
				const refusal = diagnostics.find(item => item.code.startsWith('access.'))
				return { status: 'invalid', key: KEY, ...(refusal ? { code: refusal.code, message: refusal.message } : {}), diagnostics }
			}

			if (!current) {
				const revision = await persistence.accessPresets.create(next as AccessPresetsFile)
				return { status: 'created', key: KEY, revision, diagnostics: (await persistence.accessPresets.readInspected())?.diagnostics ?? [] }
			}
			const commit = await persistence.accessPresets.compareAndSwap({ key: KEY, expectedRevision: current.revision, resource: next as AccessPresetsFile })
			if (!commit.ok) return { status: 'conflict', key: KEY, currentRevision: commit.conflict.currentRevision }
			const after = await persistence.accessPresets.readInspected()
			return { status: 'updated', key: KEY, revision: commit.revision, diagnostics: after?.diagnostics ?? [] }
		}
		catch (error) {
			if (!(error instanceof PersistenceError)) throw error
			switch (error.code) {
				case 'workspace.migration_required':
				case 'workspace.schema_unsupported':
					return blocked(error.code, error.message, error.diagnostics)
				case 'persistence.resource_not_found':
					return { status: 'not_found', key: KEY }
				case 'persistence.resource_exists': {
					// Another write created the file after it was read as absent.
					const currentRevision = await persistence.accessPresets.readRevision()
					return currentRevision ? { status: 'conflict', key: KEY, currentRevision } : { status: 'not_found', key: KEY }
				}
				case 'persistence.invalid_json':
					return blocked(error.code, `The current Access presets file is not readable JSON, so it cannot be replaced. ${error.message}`, error.diagnostics)
				default:
					throw error
			}
		}
	}

	return Object.freeze({ readAccessPresets, updateAccessPresets })
}
