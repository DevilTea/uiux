import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useReplyBases } from '../app/composables/useReplyBases'
import type { ThreadState } from '../app/utils/reply-conflict'

type Item = ThreadState & { revision: string }

/** The "updated by others" notice state of a reply draft (Rule 01a11485-f434-75ed-ab0a-e321468c8407, issue #294). */
function setup(initial: Item) {
	const item = ref<Item>(initial)
	const drafts = ref<Record<string, string>>({ t1: 'draft' })
	const bases = useReplyBases(drafts, id => (id === 't1' ? item.value : undefined))
	return { item, drafts, bases }
}

describe('useReplyBases updated / follow / acknowledge', () => {
	const open: Item = { revision: 'r1', messageCount: 2, status: 'open' }

	it('shows nothing while the thread is at the pinned revision', () => {
		expect(setup(open).bases.updated('t1')).toBeUndefined()
	})

	it('reports an edit by others as no new reply: a bare change', () => {
		const { item, bases } = setup(open)
		item.value = { ...open, revision: 'r2' }
		expect(bases.updated('t1')).toEqual({ newMessages: 0 })
	})

	it('reports new replies and a status change with its wording', () => {
		const { item, bases } = setup(open)
		item.value = { revision: 'r2', messageCount: 3, status: 'resolved', resolution: 'answered' }
		expect(bases.updated('t1')).toEqual({ newMessages: 1, status: 'resolved' })
		item.value = { revision: 'r3', messageCount: 2, status: 'resolved', resolution: 'wont-fix' }
		expect(bases.updated('t1')).toEqual({ newMessages: 0, status: 'dismissed' })
	})

	it.each([
		['edit', open, { messageCount: 2, status: 'open' }],
		['resolve', open, { messageCount: 2, status: 'resolved', resolution: 'answered' }],
		['reopen', { revision: 'r1', messageCount: 2, status: 'resolved', resolution: 'answered' }, { messageCount: 2, status: 'open' }],
	] as const)('an own %s with a pinned draft does not show the notice', async (_name, start, next) => {
		const { item, bases } = setup(start as Item)
		bases.follow('t1', 'r1', 'r2')
		// Before the re-read lands the thread is still at the old revision.
		expect(bases.updated('t1')).toBeUndefined()
		item.value = { revision: 'r2', ...next } as Item
		// The very tick the new revision shows: no flash, and the pin has moved.
		expect(bases.updated('t1')).toBeUndefined()
		expect(bases.get('t1')?.revision).toBe('r2')
		bases.settle('t1')
		await nextTick()
		expect(bases.updated('t1')).toBeUndefined()
		item.value = { ...item.value, revision: 'r3', messageCount: 3 }
		expect(bases.updated('t1')).toEqual({ newMessages: 1 })
	})

	it('follows when the thread already shows the new revision', () => {
		const { item, bases } = setup(open)
		item.value = { ...open, revision: 'r2' }
		bases.follow('t1', 'r1', 'r2')
		expect(bases.get('t1')?.revision).toBe('r2')
		expect(bases.updated('t1')).toBeUndefined()
	})

	it('does not hide a later change by others, nor follow a pin on another revision', () => {
		const { item, bases } = setup(open)
		bases.follow('t1', 'r1', 'r2')
		item.value = { ...open, revision: 'r9', messageCount: 3 }
		expect(bases.updated('t1')).toEqual({ newMessages: 1 })
		bases.follow('t1', 'r5', 'r9')
		expect(bases.get('t1')?.revision).toBe('r1')
	})

	it('drops a followed move whose re-read never showed', () => {
		const { item, bases } = setup(open)
		bases.follow('t1', 'r1', 'r2')
		bases.settle('t1')
		item.value = { ...open, revision: 'r2' }
		expect(bases.updated('t1')).toEqual({ newMessages: 0 })
	})

	it('acknowledge aims the draft at the thread as shown and clears the notice', () => {
		const { item, bases } = setup(open)
		item.value = { revision: 'r2', messageCount: 3, status: 'open' }
		bases.acknowledge('t1')
		expect(bases.get('t1')).toEqual({ revision: 'r2', state: { messageCount: 3, status: 'open' } })
		expect(bases.updated('t1')).toBeUndefined()
	})

	it('acknowledge does nothing without a draft', () => {
		const { item, drafts, bases } = setup(open)
		drafts.value = {}
		item.value = { ...open, revision: 'r2' }
		bases.acknowledge('t1')
		expect(bases.get('t1')).toBeUndefined()
	})
})
