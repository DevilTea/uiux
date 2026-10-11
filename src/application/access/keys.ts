import type { AccessRole, MemberKind } from './principal'

/**
 * Permission keys (Discussion #140, Part 15): the catalog UIUX owns, each key's `humanOnly` flag
 * and requirements, the key-name grammar, the built-in Access presets and the write key of each
 * resource kind. Authorization (`policy.ts`) checks a principal's keys against the keys each
 * operation needs. A member's keys are the ones its roster record stores (roster `version: 2`);
 * the upgrade of a `version: 1` roster maps each stored `role` through the built-in preset of
 * that `id`.
 */

/** Clause 01a11c09-a26e-73bb-9a29-eed40aae37bd: the permission key catalog, in catalog order. */
export const PERMISSION_KEYS = Object.freeze([
	'workspace.read',
	'history.read',
	'product-kit.source.read',
	'reviews.write',
	'reviews.submit',
	'reviews.promote',
	'reviews.resolve',
	'views.write',
	'flows.write',
	'locales.write',
	'assets.write',
	'settings.write',
	'product-kit.write',
	'product-kit.compose',
	'evidence.capture',
	'handoff.export',
	'checkpoints.create',
	'history.restore',
	'checkpoints.delete',
	'locks.force-release',
	'presets.manage',
	'members.manage',
] as const)
export type PermissionKey = typeof PERMISSION_KEYS[number]

/**
 * The catalog's `humanOnly` keys (same Clause). A `humanOnly` key takes effect only on a human
 * member's Workbench cookie session (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef).
 */
export const HUMAN_ONLY_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(['reviews.resolve', 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'])

/**
 * Clause 01a11c09-a2db-74bb-abb3-1b8e24682221: the keys each key requires. `workspace.read`
 * requires nothing; every key not listed here requires `workspace.read`.
 */
const KEY_REQUIREMENTS: Readonly<Partial<Record<PermissionKey, readonly PermissionKey[]>>> = Object.freeze({
	'workspace.read': [],
	'reviews.submit': ['reviews.write'],
	'reviews.promote': ['reviews.write'],
	'reviews.resolve': ['reviews.write'],
	'product-kit.write': ['product-kit.source.read'],
	'product-kit.compose': ['product-kit.write'],
	'checkpoints.create': ['history.read'],
	'history.restore': ['history.read'],
	'checkpoints.delete': ['history.read'],
})

export function keyRequirements(key: PermissionKey): readonly PermissionKey[] {
	return KEY_REQUIREMENTS[key] ?? ['workspace.read']
}

/** Clause 01a11c09-a200-754a-ac85-48b52dfe7bdc: a permission key name, `<domain>.<capability>`. */
export const PERMISSION_KEY_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/u

export function isPermissionKeyName(value: unknown): value is string {
	return typeof value === 'string' && PERMISSION_KEY_NAME_PATTERN.test(value)
}

export function isHumanOnlyKey(key: string): boolean {
	return (HUMAN_ONLY_PERMISSION_KEYS as readonly string[]).includes(key)
}

/** A key of the catalog this UIUX version owns. */
export function isCatalogKey(key: unknown): key is PermissionKey {
	return typeof key === 'string' && (PERMISSION_KEYS as readonly string[]).includes(key)
}

/**
 * The keys a member's stored key set grants: only catalog keys, since a key unknown to this UIUX
 * version grants nothing (Rule 01a11c09-b7ec-786f-9723-eda32404d421), and never a `humanOnly` key
 * for an Agent (Rule 01a11485-eac6-730b-b66b-309cc9efb169), whatever the roster file says. A key
 * set that lacks a requirement grants exactly the keys it lists (Rule
 * 01a11c09-b779-7f5f-ba47-170a584a09ce). In catalog order.
 */
export function grantedKeys(kind: MemberKind, stored: Iterable<string>): PermissionKey[] {
	const known = [...stored].filter(isCatalogKey)
	return inCatalogOrder(kind === 'agent' ? known.filter(key => !isHumanOnlyKey(key)) : known)
}

/**
 * The requirements (Clause 01a11c09-a2db-74bb-abb3-1b8e24682221) that a key set lacks, as
 * `{ key, missing }` pairs in catalog order; keys unknown to this version have no known
 * requirement.
 */
export function missingRequirements(keys: Iterable<string>): readonly Readonly<{ key: PermissionKey; missing: readonly PermissionKey[] }>[] {
	const held = new Set(keys)
	const gaps: { key: PermissionKey; missing: PermissionKey[] }[] = []
	for (const key of PERMISSION_KEYS) {
		if (!held.has(key)) continue
		const missing = keyRequirements(key).filter(requirement => !held.has(requirement))
		if (missing.length > 0) gaps.push({ key, missing })
	}
	return gaps
}

export type BuiltInAccessPreset = Readonly<{ id: AccessRole; name: string; keys: readonly PermissionKey[] }>

const VIEWER_KEYS: readonly PermissionKey[] = ['workspace.read', 'history.read', 'product-kit.source.read']
const REVIEWER_KEYS: readonly PermissionKey[] = [...VIEWER_KEYS, 'reviews.write', 'reviews.submit', 'reviews.promote', 'reviews.resolve', 'checkpoints.create']
const EDITOR_KEYS: readonly PermissionKey[] = [
	...REVIEWER_KEYS,
	'views.write',
	'flows.write',
	'locales.write',
	'assets.write',
	'settings.write',
	'product-kit.write',
	'product-kit.compose',
	'evidence.capture',
	'handoff.export',
	'history.restore',
]
const OWNER_KEYS: readonly PermissionKey[] = [...EDITOR_KEYS, 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage']

/** Clause 01a11c09-a930-7e31-bb0a-9e2bee79490c: the built-in Access presets, in order, keys in catalog order. */
export const BUILT_IN_ACCESS_PRESETS: readonly BuiltInAccessPreset[] = Object.freeze([
	{ id: 'viewer', name: 'Viewer', keys: inCatalogOrder(VIEWER_KEYS) },
	{ id: 'reviewer', name: 'Reviewer', keys: inCatalogOrder(REVIEWER_KEYS) },
	{ id: 'editor', name: 'Editor', keys: inCatalogOrder(EDITOR_KEYS) },
	{ id: 'owner', name: 'Owner', keys: inCatalogOrder(OWNER_KEYS) },
].map(preset => Object.freeze({ ...preset, keys: Object.freeze(preset.keys) })) as BuiltInAccessPreset[])

/**
 * Clause 01a11bb1-b427-777e-8175-fa24d61d434b: the roster upgrade maps a `role` to the keys of
 * the built-in Access preset with that `id`. An Agent never holds a `humanOnly` key (Rule
 * 01a11c09-b698-7ee3-861b-f02eaba61269), so an Agent's mapped set omits them.
 */
export function keysForRole(kind: MemberKind, role: AccessRole): readonly PermissionKey[] {
	const preset = BUILT_IN_ACCESS_PRESETS.find(item => item.id === role)!
	return kind === 'agent' ? preset.keys.filter(key => !isHumanOnlyKey(key)) : preset.keys
}

/**
 * Clause 01a11c09-a42a-7d6b-bb5e-01d7cf1ce2de: the write key of each resource kind, which a
 * lease of that kind (Rule 01a11c09-c125-752e-aa98-b4c063b2b7fb) and a restore of it (Rule
 * 01a11c09-c648-71be-a550-2ecabf12f5d0) need. `undefined` for a kind with no write key.
 */
const WRITE_KEY_BY_KIND: Readonly<Record<string, PermissionKey>> = Object.freeze({
	'view': 'views.write',
	'flow': 'flows.write',
	'locale': 'locales.write',
	'asset': 'assets.write',
	'workspace': 'settings.write',
	'product-kit': 'product-kit.write',
	'access-presets': 'presets.manage',
})

export function writeKeyForKind(kind: string): PermissionKey | undefined {
	return Object.hasOwn(WRITE_KEY_BY_KIND, kind) ? WRITE_KEY_BY_KIND[kind] : undefined
}

/** Unique keys in catalog order. */
export function inCatalogOrder(keys: Iterable<PermissionKey>): PermissionKey[] {
	const held = new Set(keys)
	return PERMISSION_KEYS.filter(key => held.has(key))
}
