import {
	BUILT_IN_ACCESS_PRESETS,
	inCatalogOrder,
	isCatalogKey,
	isPermissionKeyName,
	missingRequirements,
	PERMISSION_KEYS,
} from '../../application/access/keys'
import { jsonPointer, rejectUnknownKeys, Validator, type Diagnostic, type ValidationResult } from '../validation'

/**
 * The Access presets file (Discussion #140, Part 15): named permission key sets a Workspace keeps
 * in `access-presets.json` (Clause 01a11c09-a855-7d7e-93ec-cd9a85fdb65e).
 * Presets are Workspace data (Rule 01a11c09-c724-7a1b-9505-3146b5b2b241): the built-in presets are
 * only the content a new or migrated Workspace starts with (Rule 01a11c09-c78f-773d-ad98-5c6def1b22e3).
 *
 * The checks fall in two groups:
 * - the shape (Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5): `{ presets }`, each preset
 *   `{ id, name, keys }`, ids unique slugs, names of at most 40 characters without control or
 *   format characters, non-empty and never `Custom`, keys unique permission key names in catalog
 *   order, with the codes of Clause 01a12f9d-eb8d-7eba-b618-84e1bf1b7d08 (`access.preset_id_invalid`,
 *   `access.preset_name_invalid` and, for a file on disk, `access.preset_keys_unordered`);
 * - the rules of Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74: no two presets with equal key sets
 *   (`access.preset_duplicate`, naming both), no two names the same ({@link presetNameKey})
 *   (`access.preset_name_taken`), every requirement of each key present (`access.key_requires`)
 *   and, for a file on disk, no key outside the catalog (`access.unknown_key`).
 *
 * A key unknown to this UIUX version (one a newer version wrote) is kept on every write and ignored
 * by the requirement check; a preset holding one labels nobody (Rule 01a11c09-ca9b-7c86-9277-22b0397bee03).
 */

/** The `schemaVersion` from which a Workspace keeps its Access presets file. */
export const ACCESS_PRESETS_SCHEMA_VERSION = 6
/** Clause 01a11c09-a855-7d7e-93ec-cd9a85fdb65e: the file under the Workspace root, its kind and its key. */
export const ACCESS_PRESETS_FILENAME = 'access-presets.json'
export const ACCESS_PRESETS_RESOURCE_KIND = 'access-presets'
export const ACCESS_PRESETS_RESOURCE_KEY = 'access-presets'

/** Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5: the longest preset name, in characters. */
export const ACCESS_PRESET_NAME_MAX_LENGTH = 40
/** The label of a member whose keys match no preset; no preset may take the name. */
export const CUSTOM_LABEL_NAME = 'Custom'

/** A preset id: lowercase letters and digits, words joined by single hyphens. */
const PRESET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PRESET_ID_MAX_LENGTH = 64

export type AccessPreset = { id: string; name: string; keys: string[] }
export type AccessPresetsFile = { presets: AccessPreset[] }

/** The content of a new presets file (`uiux init`, `uiux.v5-to-v6`): the built-in presets (Clause 01a11c09-a930-7e31-bb0a-9e2bee79490c). */
export function builtInAccessPresetsFile(): AccessPresetsFile {
	return { presets: BUILT_IN_ACCESS_PRESETS.map(preset => ({ id: preset.id, name: preset.name, keys: [...preset.keys] })) }
}

/**
 * Keys as a preset stores them: once each, the catalog keys in catalog order, then the keys
 * unknown to this version in the order given.
 */
export function orderPresetKeys(keys: readonly string[]): string[] {
	const unique = [...new Set(keys)]
	return [...inCatalogOrder(unique.filter(isCatalogKey)), ...unique.filter(key => !isCatalogKey(key))]
}

/** The length of a name in characters, counted as code points. */
function characters(value: string): number {
	return [...value].length
}

/**
 * Control and format characters (Unicode categories Cc and Cf), which a preset name may not hold
 * (Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5): newlines and tabs, zero-width characters and the
 * bidirectional controls among them.
 */
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u

/**
 * The form in which preset names are compared (Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5): NFC,
 * trimmed, ignoring case. Two names of one form are the same name, and a name whose form is
 * `custom` is the reserved Custom label. Confusable characters, such as a Greek Omicron for an O,
 * are not folded (#140 owner rulings of 2026-10-12, ruling 4).
 */
export function presetNameKey(name: string): string {
	return name.normalize('NFC').trim().toLowerCase()
}

/**
 * The shape of the presets file (Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5). The rules of Clause
 * 01a11c09-a57d-7d3d-a46f-1e9512200f74 are separate: {@link accessPresetsRuleDiagnostics}.
 */
export function validateAccessPresetsShape(input: unknown): ValidationResult<AccessPresetsFile> {
	const v = new Validator()
	const root = v.object(input, '')
	if (!root) return v.finish<AccessPresetsFile>(input)
	rejectUnknownKeys(root, ['presets'], '', v)
	if (!Object.hasOwn(root, 'presets')) {
		v.issue('schema.required_field', '/presets', 'The Access presets file requires presets, which may be empty.')
		return v.finish<AccessPresetsFile>(input)
	}
	const ids = new Set<string>()
	v.array(root.presets, '/presets')?.forEach((entry, index) => {
		const path = jsonPointer('/presets', index)
		const preset = v.object(entry, path)
		if (!preset) return
		rejectUnknownKeys(preset, ['id', 'name', 'keys'], path, v)
		const id = preset.id
		if (typeof id !== 'string' || id.length > PRESET_ID_MAX_LENGTH || !PRESET_ID_PATTERN.test(id)) {
			v.issue('access.preset_id_invalid', `${path}/id`, `A preset id is a slug of at most ${PRESET_ID_MAX_LENGTH} characters: lowercase letters and digits, words joined by single hyphens.`)
		}
		else {
			if (ids.has(id)) v.issue('identity.duplicate', `${path}/id`, `Preset id ${id} is duplicated; ids are unique in the file.`)
			ids.add(id)
		}
		const name = preset.name
		if (typeof name !== 'string' || presetNameKey(name).length === 0 || characters(name) > ACCESS_PRESET_NAME_MAX_LENGTH)
			v.issue('access.preset_name_invalid', `${path}/name`, `A preset name is a non-empty string of at most ${ACCESS_PRESET_NAME_MAX_LENGTH} characters.`)
		else if (CONTROL_OR_FORMAT_CHARACTER.test(name))
			v.issue('access.preset_name_invalid', `${path}/name`, 'A preset name holds no control or format character, such as a newline, a zero-width character or a bidirectional control.')
		else if (presetNameKey(name) === presetNameKey(CUSTOM_LABEL_NAME))
			v.issue('access.preset_name_invalid', `${path}/name`, `${CUSTOM_LABEL_NAME} is the label of members no preset matches, so no preset may take the name.`)
		const keys = v.array(preset.keys, `${path}/keys`)
		if (!keys) return
		const seen = new Set<string>()
		keys.forEach((key, keyIndex) => {
			const keyPath = jsonPointer(`${path}/keys`, keyIndex)
			if (!isPermissionKeyName(key)) {
				v.issue('access.invalid_keys', keyPath, 'A key is a permission key name, <domain>.<capability>, such as views.write.')
				return
			}
			if (seen.has(key)) v.issue('identity.duplicate', keyPath, `Key ${key} is listed twice.`)
			seen.add(key)
		})
		if (seen.size === keys.length && keys.every(isPermissionKeyName)) {
			const ordered = orderPresetKeys(keys as string[])
			if (ordered.some((key, keyIndex) => key !== keys[keyIndex]))
				v.issue('access.preset_keys_unordered', `${path}/keys`, `A preset lists its keys in catalog order (${PERMISSION_KEYS.join(', ')}).`)
		}
	})
	return v.finish<AccessPresetsFile>(input)
}

const quote = (value: string) => JSON.stringify(value)
const keyList = (keys: readonly string[]) => keys.map(key => `\`${key}\``).join(', ')

/**
 * The rules of Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74 on presets of a valid shape:
 * `access.preset_duplicate` for each preset whose key set equals an earlier one's, naming both
 * (Rule 01a11c09-c7ff-72bb-8afe-2a7d1dc1024d); `access.preset_name_taken` for each name equal to
 * an earlier one as {@link presetNameKey} compares them; `access.key_requires` for each preset lacking a requirement of one
 * of its keys; and `access.unknown_key` for each key outside the catalog when `unknownKeys` is
 * `report` (a file on disk). Key sets are compared as sets, unknown keys included.
 */
export function accessPresetsRuleDiagnostics(presets: readonly AccessPreset[], options: Readonly<{ unknownKeys: 'report' | 'ignore' }>): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const bySet = new Map<string, number>()
	const byName = new Map<string, number>()
	presets.forEach((preset, index) => {
		const path = jsonPointer('/presets', index)
		const set = [...new Set(preset.keys)].sort().join('\n')
		const twin = bySet.get(set)
		if (twin !== undefined) {
			const other = presets[twin]!
			diagnostics.push({ code: 'access.preset_duplicate', path: `${path}/keys`, message: `Presets ${quote(other.name)} (${other.id}) and ${quote(preset.name)} (${preset.id}) have equal key sets; no two presets may be equal.` })
		}
		else {
			bySet.set(set, index)
		}
		const folded = presetNameKey(preset.name)
		const namesake = byName.get(folded)
		if (namesake !== undefined) {
			const other = presets[namesake]!
			diagnostics.push({ code: 'access.preset_name_taken', path: `${path}/name`, message: `Presets ${quote(other.name)} (${other.id}) and ${quote(preset.name)} (${preset.id}) have the same name, compared ignoring case, surrounding spaces and Unicode normalization; preset names are unique.` })
		}
		else {
			byName.set(folded, index)
		}
		const gaps = missingRequirements(preset.keys)
		if (gaps.length > 0)
			diagnostics.push({ code: 'access.key_requires', path: `${path}/keys`, message: `The keys of preset ${quote(preset.name)} lack requirements: ${gaps.map(gap => `\`${gap.key}\` requires ${keyList(gap.missing)}`).join('; ')}.` })
		if (options.unknownKeys === 'report') {
			const unknown = preset.keys.filter(key => !isCatalogKey(key))
			if (unknown.length > 0)
				diagnostics.push({ code: 'access.unknown_key', path: `${path}/keys`, message: `Preset ${quote(preset.name)} holds ${keyList(unknown)}, ${unknown.length > 1 ? 'which are not permission keys' : 'which is not a permission key'} of this UIUX version; it labels no member.` })
		}
	})
	return diagnostics
}

/**
 * A presets file as it is on disk (Rule 01a11c09-cb08-7007-bcdd-8a04e54d02b5): its shape, then,
 * for a valid shape, every rule including keys outside the catalog. These are the diagnostics of
 * the `access-presets` resource.
 */
export function validateAccessPresetsFile(input: unknown): ValidationResult<AccessPresetsFile> {
	const shape = validateAccessPresetsShape(input)
	if (!shape.ok) return shape
	const diagnostics = accessPresetsRuleDiagnostics(shape.value.presets, { unknownKeys: 'report' })
	return diagnostics.length > 0 ? { ok: false, diagnostics } : shape
}

/**
 * The presets that label members, from a presets file that may break the rules on disk: every
 * entry with a string `id`, a string `name` and an array of string `keys`, in file order. Labels
 * then use the first match in file order (Rule 01a11c33-265e-71f6-939f-4d0d3754a16f), and a preset
 * holding a key unknown to this version matches nobody (`memberLabel`). A file of another shape
 * gives no presets.
 */
export function labelPresetsOf(input: unknown): AccessPreset[] {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return []
	const presets = (input as Record<string, unknown>).presets
	if (!Array.isArray(presets)) return []
	const usable: AccessPreset[] = []
	for (const entry of presets) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
		const { id, name, keys } = entry as Record<string, unknown>
		if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(keys) || !keys.every(key => typeof key === 'string')) continue
		usable.push({ id, name, keys: [...keys as string[]] })
	}
	return usable
}
