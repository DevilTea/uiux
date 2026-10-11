import { describe, expect, it } from 'vitest'
import { HUMAN_ONLY_PERMISSION_KEYS, keysForRole, PERMISSION_KEYS } from '../src/application/access/keys'
import { applyPreset, catalogByDomain, keyChanges, keyDomain, keysNoHumanHolds, orderedKeys, toggleKey } from '../app/utils/member-keys'

/** The Members page key checklist's rules (issue #142, P5), without the page. */

const OWNER = keysForRole('human', 'owner')
const VIEWER = keysForRole('human', 'viewer')

describe('the key checklist', () => {
	it('groups the catalog by domain, in catalog order (Rule 01a11c09-ba80)', () => {
		const groups = catalogByDomain()
		expect(groups.map(group => group.domain)).toEqual(['workspace', 'history', 'product-kit', 'reviews', 'views', 'flows', 'locales', 'assets', 'settings', 'evidence', 'handoff', 'checkpoints', 'locks', 'presets', 'members'])
		for (const group of groups) {
			expect(group.keys.every(key => keyDomain(key) === group.domain)).toBe(true)
			expect(group.keys).toEqual(PERMISSION_KEYS.filter(key => group.keys.includes(key)))
		}
		expect(groups.find(group => group.domain === 'product-kit')!.keys).toEqual(['product-kit.source.read', 'product-kit.write', 'product-kit.compose'])
		expect(groups.find(group => group.domain === 'history')!.keys).toEqual(['history.read', 'history.restore'])
		expect(groups.flatMap(group => group.keys).sort()).toEqual([...PERMISSION_KEYS].sort())
	})

	it('checks a key with every requirement it needs, directly or through another key (Rule 01a11c09-baec)', () => {
		expect(toggleKey([], 'product-kit.compose', true, 'human')).toEqual(['workspace.read', 'product-kit.source.read', 'product-kit.write', 'product-kit.compose'])
		expect(toggleKey(VIEWER, 'reviews.promote', true, 'human')).toEqual([...VIEWER, 'reviews.write', 'reviews.promote'])
		// Unchecking removes only that key; the server refuses the incoherent set until it is fixed.
		expect(toggleKey(['workspace.read', 'reviews.write', 'reviews.promote'], 'reviews.write', false, 'human')).toEqual(['workspace.read', 'reviews.promote'])
	})

	it('never checks a humanOnly key for an Agent', () => {
		expect(toggleKey([], 'members.manage', true, 'agent')).toEqual(['workspace.read'])
		expect(toggleKey([], 'reviews.resolve', true, 'agent')).toEqual(['workspace.read', 'reviews.write'])
		expect(toggleKey([], 'members.manage', true, 'human')).toEqual(['workspace.read', 'members.manage'])
	})

	it('applies a preset as its keys now, without its humanOnly keys for an Agent (Rules 01a11c09-b8c6 and 01a11c74-26ef)', () => {
		expect(applyPreset(OWNER, VIEWER, 'human')).toEqual({ keys: OWNER, dropped: [] })
		const agent = applyPreset(OWNER, VIEWER, 'agent')
		expect(agent.keys).toEqual(keysForRole('agent', 'owner'))
		expect(agent.keys.some(key => (HUMAN_ONLY_PERMISSION_KEYS as readonly string[]).includes(key))).toBe(false)
		expect(agent.dropped).toEqual(['reviews.resolve', 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'])
	})

	it('keeps the unknown keys the member holds when a preset is applied (owner ruling of 2026-10-11 on PR #189)', () => {
		expect(applyPreset(VIEWER, ['future.capability', ...OWNER, 'other.thing'], 'human').keys).toEqual([...VIEWER, 'future.capability', 'other.thing'])
		expect(applyPreset(OWNER, ['future.capability'], 'agent').keys).toEqual([...keysForRole('agent', 'owner'), 'future.capability'])
	})

	it('sends a preset or an edit as the keys to grant and revoke against the member as loaded (owner ruling 1 of 2026-10-11 on PR #191)', () => {
		const loaded = [...VIEWER, 'future.capability']
		const applied = applyPreset(keysForRole('human', 'editor'), loaded, 'human').keys
		expect(keyChanges(loaded, applied)).toEqual({ grant: keysForRole('human', 'editor').filter(key => !VIEWER.includes(key)), revoke: VIEWER.filter(key => !keysForRole('human', 'editor').includes(key)) })
		// The unknown key the member holds is neither granted nor revoked.
		expect(keyChanges(loaded, applied).revoke).not.toContain('future.capability')
		expect(keyChanges(OWNER, applyPreset(VIEWER, OWNER, 'human').keys)).toEqual({ grant: [], revoke: OWNER.filter(key => !VIEWER.includes(key)) })
		expect(keyChanges(loaded, loaded)).toEqual({ grant: [], revoke: [] })
		expect(keyChanges(['workspace.read', 'views.write'], ['views.write', 'workspace.read'])).toEqual({ grant: [], revoke: [] })
	})

	it('orders a key set as the roster stores it', () => {
		expect(orderedKeys(['views.write', 'future.capability', 'workspace.read', 'views.write'])).toEqual(['workspace.read', 'views.write', 'future.capability'])
	})
})

describe('the notice of keys no person holds (Rule 01a11c09-bbc9)', () => {
	it('lists the catalog keys no human member holds; an Agent\'s keys do not count', () => {
		expect(keysNoHumanHolds([{ kind: 'human', keys: OWNER }])).toEqual([])
		expect(keysNoHumanHolds([
			{ kind: 'human', keys: keysForRole('human', 'editor') },
			{ kind: 'agent', keys: [...keysForRole('agent', 'editor'), 'future.capability'] },
		])).toEqual(['checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'])
		expect(keysNoHumanHolds([])).toEqual([...PERMISSION_KEYS])
	})
})
