import { describe, expect, it } from 'vitest'
import { BUILT_IN_ACCESS_PRESETS } from '../src/application/access/keys'
import type { MemberKind } from '../src/application/access/principal'
import type { AccessPreset } from '../src/domain/access-presets/schema'
import {
	holdersOf,
	memberUpdates,
	newPresetId,
	normalizePresetName,
	presetNameProblem,
	presetWithKeys,
	sameKeySet,
	unknownPresetKeys,
} from '../app/utils/access-presets'
import { presetKeys } from './support/access'

/** The Access presets page's rules (issue #142, P7), without the page. */

const PRESETS: AccessPreset[] = BUILT_IN_ACCESS_PRESETS.map(preset => ({ id: preset.id, name: preset.name, keys: [...preset.keys] }))
const VIEWER = presetKeys('viewer')
const REVIEWER = presetKeys('reviewer')
const EDITOR = presetKeys('editor')

const member = (id: string, kind: MemberKind, keys: readonly string[]) => ({ id, nickname: id, kind, keys: [...keys] })

describe('the inline checks of a preset edit', () => {
	it('finds the other preset with an equal key set, compared as sets with unknown keys (Rule 01a11c09-ce14)', () => {
		expect(presetWithKeys(PRESETS, [...REVIEWER].reverse())?.id).toBe('reviewer')
		// The preset being edited is not its own duplicate.
		expect(presetWithKeys(PRESETS, REVIEWER, 1)).toBeUndefined()
		expect(presetWithKeys(PRESETS, [...REVIEWER, 'future.key'])).toBeUndefined()
		expect(sameKeySet(['a.b', 'a.b', 'c.d'], ['c.d', 'a.b'])).toBe(true)
	})

	it('judges names after NFC and trimming, ignoring case, and refuses control and format characters', () => {
		expect(normalizePresetName('  Café ')).toBe('Café')
		expect(presetNameProblem(PRESETS, '   ')).toBe('empty')
		expect(presetNameProblem(PRESETS, 'x'.repeat(41))).toBe('tooLong')
		expect(presetNameProblem(PRESETS, 'x'.repeat(40))).toBeUndefined()
		expect(presetNameProblem(PRESETS, 'QA​')).toBe('control')
		expect(presetNameProblem(PRESETS, 'Q‮A')).toBe('control')
		expect(presetNameProblem(PRESETS, ' custom ')).toBe('custom')
		expect(presetNameProblem(PRESETS, ' editor')).toBe('taken')
		// Renaming a preset to its own name in another case is no clash.
		expect(presetNameProblem(PRESETS, 'EDITOR', 2)).toBeUndefined()
	})

	it('gives a new preset a free slug id', () => {
		expect(newPresetId('Design QA', PRESETS)).toBe('design-qa')
		expect(newPresetId('Editor', PRESETS)).toBe('editor-2')
		expect(newPresetId('審閱者', PRESETS)).toBe('preset')
		expect(newPresetId('Café crème', PRESETS)).toBe('cafe-creme')
		expect(newPresetId('preset', [...PRESETS, { id: 'preset', name: 'P', keys: [] }])).toBe('preset-2')
	})

	it('flags the keys this version does not know (Rule 01a11c09-ca9b)', () => {
		expect(unknownPresetKeys({ keys: [...VIEWER, 'future.key'] })).toEqual(['future.key'])
		expect(unknownPresetKeys(PRESETS[0]!)).toEqual([])
	})
})

describe('the members on this host after an edit', () => {
	const members = [
		member('ann', 'human', REVIEWER),
		member('bob', 'human', EDITOR),
		member('bot', 'agent', presetKeys('reviewer', 'agent')),
		member('odd', 'human', [...REVIEWER, 'future.key']),
	]
	const reviewer = PRESETS[1]!

	it('counts the holders of the old key set by the label rules, an Agent without the humanOnly keys (Rule 01a11c09-ce86)', () => {
		expect(holdersOf(reviewer, members).map(item => item.id)).toEqual(['ann', 'bot'])
		// A preset holding a key unknown to this version is held by nobody.
		expect(holdersOf({ ...reviewer, keys: [...reviewer.keys, 'future.key'] }, members)).toEqual([])
	})

	it('gives each holder the new keys as grant and revoke deltas, an Agent without humanOnly keys (Rule 01a11c33-2761)', () => {
		const next = [...REVIEWER.filter(key => key !== 'checkpoints.create'), 'locks.force-release']
		const updates = memberUpdates(next, holdersOf(reviewer, members))
		expect(updates.map(update => [update.member.id, update.grant, update.revoke])).toEqual([
			['ann', ['locks.force-release'], ['checkpoints.create']],
			['bot', [], ['checkpoints.create']],
		])
	})

	it('keeps the unknown keys a member holds and leaves out a member whose keys would not change', () => {
		const odd = member('odd', 'human', [...VIEWER, 'future.key'])
		expect(memberUpdates(REVIEWER, [odd])).toEqual([{ member: odd, grant: REVIEWER.filter(key => !VIEWER.includes(key)), revoke: [] }])
		expect(memberUpdates(REVIEWER, [member('ann', 'human', REVIEWER)])).toEqual([])
	})
})
