import { ACCESS_ROLES, type AccessRole, type MemberKind } from './principal'
import { BUILT_IN_ACCESS_PRESETS, grantedKeys, isCatalogKey, isHumanOnlyKey, type BuiltInAccessPreset } from './keys'

/**
 * Member labels (Discussion #140, decision 5): a label names the Access preset whose key set
 * matches a member's keys, or says Custom. Labels are computed whenever the server answers and
 * never stored (Rule 01a11c09-c9be-736b-95a4-0b39d6f64cf0). Below `schemaVersion` 6 the
 * Workspace has no presets file, so the built-in presets label members (Rule
 * 01a11c09-cb79-744e-bbf6-ec38d6f159ba).
 */

/** Clause 01a11c09-a49b-78c7-9304-7b8239f8a8cf: `{ preset: { id, name } }` or `{ custom: true }`. */
export type MemberLabel =
	| Readonly<{ preset: Readonly<{ id: string; name: string }> }>
	| Readonly<{ custom: true }>

export type LabelPreset = Readonly<{ id: string; name: string; keys: readonly string[] }>

type LabeledMember = Readonly<{ kind: MemberKind; keys: readonly string[] }>

const CUSTOM: MemberLabel = Object.freeze({ custom: true as const })

function sameKeySet(left: readonly string[], right: ReadonlySet<string>): boolean {
	const unique = new Set(left)
	return unique.size === right.size && [...unique].every(key => right.has(key))
}

/**
 * The member's label among `presets` (file order):
 * - a human member gets the preset whose key set equals its keys (Rule 01a11c09-c86b-7526-a517-6220b027387a);
 * - an Agent gets the preset whose key set without its `humanOnly` keys equals the Agent's keys,
 *   and among several the one with the fewest `humanOnly` keys, then the earliest (Rule
 *   01a11c09-c8db-7236-87a1-5720487c486a);
 * - otherwise Custom (Rule 01a11c09-c94c-77f1-b8e0-b9594584c193).
 *
 * A preset holding a key unknown to this version labels nobody (Rule
 * 01a11c09-ca9b-7c86-9277-22b0397bee03), and the member's keys are compared as stored, so a
 * member holding an unknown key is Custom.
 */
export function memberLabel(member: LabeledMember, presets: readonly LabelPreset[] = BUILT_IN_ACCESS_PRESETS): MemberLabel {
	const held = new Set(member.keys)
	let best: { preset: LabelPreset; humanOnly: number } | undefined
	for (const preset of presets) {
		if (!preset.keys.every(isCatalogKey)) continue
		const compared = member.kind === 'agent' ? preset.keys.filter(key => !isHumanOnlyKey(key)) : preset.keys
		if (!sameKeySet(compared, held)) continue
		if (member.kind === 'human') return { preset: { id: preset.id, name: preset.name } }
		const humanOnly = new Set(preset.keys.filter(isHumanOnlyKey)).size
		if (!best || humanOnly < best.humanOnly) best = { preset, humanOnly }
	}
	return best ? { preset: { id: best.preset.id, name: best.preset.name } } : CUSTOM
}

/** The label as text: the preset's name, or `Custom`. */
export function memberLabelName(label: MemberLabel): string {
	return 'preset' in label ? label.preset.name : 'Custom'
}

/**
 * A role for the surfaces that still speak roles until they move to keys and labels (issue #142:
 * the session wire, the Members page and the MCP instructions): the highest built-in preset whose
 * keys, without `humanOnly` keys for an Agent, the member's granted keys all include, and
 * `viewer` when none does. The built-in presets are nested, so a member labeled with a built-in
 * preset gets that preset's `id`. It authorizes nothing: the server checks keys.
 */
export function compatibilityRole(member: LabeledMember): AccessRole {
	const held = new Set<string>(grantedKeys(member.kind, member.keys))
	const holds = (preset: BuiltInAccessPreset) => preset.keys.every(key => held.has(key) || (member.kind === 'agent' && isHumanOnlyKey(key)))
	for (const role of [...ACCESS_ROLES].reverse()) {
		if (member.kind === 'agent' && role === 'owner') continue
		if (holds(BUILT_IN_ACCESS_PRESETS.find(preset => preset.id === role)!)) return role
	}
	return 'viewer'
}
