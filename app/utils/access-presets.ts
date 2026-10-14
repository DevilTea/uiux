import { isCatalogKey } from '../../src/application/access/keys'
import { memberLabel, type LabelPreset } from '../../src/application/access/labels'
import type { MemberKind } from '../../src/application/access/principal'
import {
	ACCESS_PRESET_NAME_MAX_LENGTH,
	CUSTOM_LABEL_NAME,
	presetNameKey,
	type AccessPreset,
} from '../../src/domain/access-presets/schema'
import { applyPreset, keyChanges } from './member-keys'

/**
 * The Access presets page's rules (Feature 01a11c09-984a-7835-95ef-67164dd91746), pure so they can
 * be tested without the page. The server checks every write again (`update_access_presets`); these
 * let the page refuse a bad edit inline, before saving (Rule 01a11c09-ce14-7f47-bea9-9db3d283abf7).
 */

type HostMember = Readonly<{ id: string; nickname: string; kind: MemberKind; keys: readonly string[] }>

/** A preset name as the page writes it: NFC and trimmed (#140 owner rulings of 2026-10-12, ruling 4). */
export function normalizePresetName(name: string): string {
	return name.normalize('NFC').trim()
}

/** Two key sets compared as sets, keys unknown to this version included (Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74). */
export function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
	const a = new Set(left)
	const b = new Set(right)
	return a.size === b.size && [...a].every(key => b.has(key))
}

/** The first other preset whose key set equals `keys`: the write would be refused with `access.preset_duplicate`. */
export function presetWithKeys(presets: readonly AccessPreset[], keys: readonly string[], except?: number): AccessPreset | undefined {
	return presets.find((preset, index) => index !== except && sameKeySet(preset.keys, keys))
}

export type PresetNameProblem = 'empty' | 'tooLong' | 'control' | 'custom' | 'taken'

const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u

/**
 * What is wrong with a preset name, as Clause 01a11c09-a8c3-776f-bc9f-26c6513816f5 and the name
 * rule of Clause 01a11c09-a57d-7d3d-a46f-1e9512200f74 judge it, or `undefined`. `taken` compares
 * names as {@link presetNameKey} does, against every preset but the one at `except`.
 */
export function presetNameProblem(presets: readonly AccessPreset[], name: string, except?: number): PresetNameProblem | undefined {
	const written = normalizePresetName(name)
	if (written.length === 0) return 'empty'
	if ([...written].length > ACCESS_PRESET_NAME_MAX_LENGTH) return 'tooLong'
	if (CONTROL_OR_FORMAT_CHARACTER.test(written)) return 'control'
	if (presetNameKey(written) === presetNameKey(CUSTOM_LABEL_NAME)) return 'custom'
	if (presets.some((preset, index) => index !== except && presetNameKey(preset.name) === presetNameKey(written))) return 'taken'
	return undefined
}

/**
 * The `id` of a new preset: a slug of its name (lowercase letters and digits, words joined by single
 * hyphens), `preset` when the name has none of those, and a numbered suffix while another preset
 * has it. An id never changes after it is written.
 */
export function newPresetId(name: string, presets: readonly AccessPreset[]): string {
	const base = normalizePresetName(name).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48).replace(/-+$/u, '') || 'preset'
	const taken = new Set(presets.map(preset => preset.id))
	if (!taken.has(base)) return base
	for (let suffix = 2; ; suffix += 1) {
		const id = `${base}-${suffix}`
		if (!taken.has(id)) return id
	}
}

/** The keys of a preset that this UIUX version does not know (Rule 01a11c09-ca9b-7c86-9277-22b0397bee03). */
export function unknownPresetKeys(preset: Readonly<{ keys: readonly string[] }>): string[] {
	return preset.keys.filter(key => !isCatalogKey(key))
}

/**
 * The members on this host that hold a preset's key set: the members the preset labels when it is
 * compared alone, by the label rules (Rules 01a11c09-c86b-7526-a517-6220b027387a and
 * 01a11c09-c8db-7236-87a1-5720487c486a). For an Agent the preset's `humanOnly` keys do not count; a
 * preset holding a key unknown to this version is held by nobody.
 */
export function holdersOf<Member extends HostMember>(preset: LabelPreset, members: readonly Member[]): Member[] {
	return members.filter(member => 'preset' in memberLabel(member, [preset]))
}

export type MemberUpdate<Member extends HostMember> = Readonly<{ member: Member; grant: string[]; revoke: string[] }>

/**
 * The "also update these members" step (Rule 01a11c33-2761-7fab-b0e5-c0f1863cb638): each holder of
 * the preset's old key set gets its new keys, as applying the preset does (an Agent without its
 * `humanOnly` keys, unknown keys the member holds kept: owner rulings of 2026-10-08 and 2026-10-11),
 * sent as the keys to grant and revoke against the member as loaded (owner ruling 1 of 2026-10-11
 * on PR #191). A member whose keys would not change is left out.
 */
export function memberUpdates<Member extends HostMember>(newKeys: readonly string[], holders: readonly Member[]): MemberUpdate<Member>[] {
	return holders
		.map(member => ({ member, ...keyChanges(member.keys, applyPreset(newKeys, member.keys, member.kind).keys) }))
		.filter(update => update.grant.length > 0 || update.revoke.length > 0)
}
