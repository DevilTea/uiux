import {
	PERMISSION_KEYS,
	isCatalogKey,
	isHumanOnlyKey,
	keyRequirements,
	keysOfPreset,
	type PermissionKey,
} from '../../src/application/access/keys'
import type { MemberKind } from '../../src/application/access/principal'

/**
 * The Members page key checklist's rules (Discussion #140, decision 12), pure so they can be
 * tested without the page. Keys are permission key names; the catalog is the one this UIUX
 * version owns (Clause 01a11c09-a26e-73bb-9a29-eed40aae37bd).
 */

export type KeyDomain = Readonly<{ domain: string; keys: readonly PermissionKey[] }>

/** A key's domain: its first `.`-separated segment (Clause 01a11c09-a200-754a-ac85-48b52dfe7bdc). */
export function keyDomain(key: string): string {
	return key.slice(0, key.indexOf('.'))
}

/** The catalog grouped by domain, domains and keys in catalog order (Rule 01a11c09-ba80-7bef-96fe-4a4bae3ab528). */
export function catalogByDomain(): readonly KeyDomain[] {
	const groups = new Map<string, PermissionKey[]>()
	for (const key of PERMISSION_KEYS) {
		const domain = keyDomain(key)
		groups.set(domain, [...(groups.get(domain) ?? []), key])
	}
	return [...groups].map(([domain, keys]) => ({ domain, keys }))
}

/** A key set as the roster stores it: catalog keys in catalog order, then unknown keys as held. */
export function orderedKeys(keys: Iterable<string>): string[] {
	const unique = [...new Set(keys)]
	const held = new Set(unique)
	return [...PERMISSION_KEYS.filter(key => held.has(key)), ...unique.filter(key => !isCatalogKey(key))]
}

/** A key and every key it requires, directly or through another requirement. */
function withRequirements(key: PermissionKey): PermissionKey[] {
	const out = new Set<PermissionKey>()
	const visit = (next: PermissionKey) => {
		if (out.has(next)) return
		out.add(next)
		for (const requirement of keyRequirements(next)) visit(requirement)
	}
	visit(key)
	return [...out]
}

/**
 * Checks or unchecks one key. Checking a key also checks its requirements (Rule
 * 01a11c09-baec-71e2-b578-6efd9ee7ec98); an Agent never gets a `humanOnly` key, so the checklist
 * disables those and this ignores them. Unchecking removes only that key: a key that needed it is
 * then flagged, and the server refuses the set (`access.key_requires`) until it is coherent.
 */
export function toggleKey(keys: readonly string[], key: PermissionKey, checked: boolean, kind: MemberKind): string[] {
	if (!checked) return keys.filter(item => item !== key)
	const added = withRequirements(key).filter(item => kind === 'human' || !isHumanOnlyKey(item))
	return orderedKeys([...keys, ...added])
}

/**
 * Applying a preset: its keys as they are now, without its `humanOnly` keys for an Agent (Rules
 * 01a11c09-b8c6-741e-b3b7-97f4840985c5 and 01a11c74-26ef-7894-9b2c-2714f487aeb8), plus the keys
 * this UIUX version does not know that the member holds, which a preset never replaces (owner
 * ruling of 2026-10-11 on PR #189, Rule 01a11c09-b7ec-786f-9723-eda32404d421). `dropped` names the
 * preset's `humanOnly` keys an Agent does not get.
 */
export function applyPreset(presetKeys: readonly string[], current: readonly string[], kind: MemberKind): Readonly<{ keys: string[]; dropped: string[] }> {
	const copied = keysOfPreset(kind, presetKeys)
	return {
		keys: orderedKeys([...copied, ...current.filter(key => !isCatalogKey(key))]),
		dropped: presetKeys.filter(key => !copied.includes(key)),
	}
}

/**
 * The catalog keys that no human member holds (Rule 01a11c09-bbc9-721f-903c-27c615692624), in
 * catalog order. An Agent's keys do not count.
 */
export function keysNoHumanHolds(members: readonly Readonly<{ kind: MemberKind; keys: readonly string[] }>[]): PermissionKey[] {
	const held = new Set(members.filter(member => member.kind === 'human').flatMap(member => member.keys))
	return PERMISSION_KEYS.filter(key => !held.has(key))
}
