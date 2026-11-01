import { describe, expect, it } from 'vitest'
import { MAX_RESOURCE_DISCOVERY_LIMIT } from '../src/application/dto/resource-discovery'
import { listAllResources, LIST_ALL_MAX_PAGES, type ResourceListPage, type ResourceLister } from '../app/utils/list-all-resources'

type Call = Readonly<{ kinds: readonly string[]; options: Readonly<{ limit?: number; cursor?: string; detail?: 'summary' | 'expanded' }> | undefined }>

/** A fake client serving `pages` in order by cursor (`undefined` = first page); a page past the end throws. */
function fakeClient(pages: readonly ResourceListPage<number>[], failAt?: number): ResourceLister & { calls: Call[] } {
	const calls: Call[] = []
	return {
		calls,
		listResources: (async (kinds: readonly string[], options?: Call['options']) => {
			calls.push({ kinds, options })
			const index = options?.cursor ? Number(options.cursor.replace('c', '')) : 0
			if (index === failAt) throw new Error('page failed')
			const page = pages[index]
			if (!page) throw new Error('no such page')
			return page
		}) as ResourceLister['listResources'],
	}
}

/** `count` pages of `size` items each; every page but the last carries the next cursor. */
function pagesOf(count: number, size: number): ResourceListPage<number>[] {
	return Array.from({ length: count }, (_, index) => ({
		items: Array.from({ length: size }, (_, offset) => index * size + offset),
		...(index < count - 1 ? { nextCursor: `c${index + 1}` } : {}),
	}))
}

describe('listAllResources', () => {
	it('follows nextCursor across pages, in order, at the largest page size', async () => {
		const client = fakeClient(pagesOf(3, MAX_RESOURCE_DISCOVERY_LIMIT))
		const result = await listAllResources<number>(client, ['view'])
		expect(result.complete).toBe(true)
		expect(result.items).toHaveLength(3 * MAX_RESOURCE_DISCOVERY_LIMIT)
		expect(result.items).toEqual(Array.from({ length: 3 * MAX_RESOURCE_DISCOVERY_LIMIT }, (_, index) => index))
		expect(client.calls.map(call => call.options?.cursor)).toEqual([undefined, 'c1', 'c2'])
		for (const call of client.calls) {
			expect(call.kinds).toEqual(['view'])
			expect(call.options?.limit).toBe(MAX_RESOURCE_DISCOVERY_LIMIT)
		}
	})

	it('stops after the first page when it carries no cursor', async () => {
		const client = fakeClient([{ items: [1, 2] }])
		expect(await listAllResources<number>(client, ['asset'])).toEqual({ items: [1, 2], complete: true })
		expect(client.calls).toHaveLength(1)
	})

	it('returns an empty list for a kind with no resources', async () => {
		expect(await listAllResources<number>(fakeClient([{ items: [] }]), ['flow'])).toEqual({ items: [], complete: true })
	})

	it('stops at the page bound and reports the list incomplete', async () => {
		const client = fakeClient(pagesOf(LIST_ALL_MAX_PAGES + 5, 2))
		const result = await listAllResources<number>(client, ['review'])
		expect(client.calls).toHaveLength(LIST_ALL_MAX_PAGES)
		expect(result.complete).toBe(false)
		expect(result.items).toHaveLength(LIST_ALL_MAX_PAGES * 2)
	})

	it('honors a caller page bound, and a list that ends exactly on the bound is complete', async () => {
		const bounded = fakeClient(pagesOf(4, 1))
		expect(await listAllResources<number>(bounded, ['view'], { maxPages: 2 })).toEqual({ items: [0, 1], complete: false })
		expect(bounded.calls).toHaveLength(2)
		const exact = fakeClient(pagesOf(2, 1))
		expect(await listAllResources<number>(exact, ['view'], { maxPages: 2 })).toEqual({ items: [0, 1], complete: true })
	})

	it('passes `detail` on every page', async () => {
		const client = fakeClient(pagesOf(2, 1))
		await listAllResources<number>(client, ['view'], { detail: 'expanded' })
		expect(client.calls.map(call => call.options?.detail)).toEqual(['expanded', 'expanded'])
	})

	it('rejects when a page read fails, so each caller keeps its own error behavior', async () => {
		await expect(listAllResources<number>(fakeClient(pagesOf(3, 1), 0), ['view'])).rejects.toThrow('page failed')
		await expect(listAllResources<number>(fakeClient(pagesOf(3, 1), 1), ['view'])).rejects.toThrow('page failed')
	})
})
