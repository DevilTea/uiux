import { describe, expect, it } from 'vitest'

import { createProductKitTracker } from '../app/composables/product-kit-tracker'
import type { LiveBatch } from '../app/composables/useLiveEvents'

const resync: LiveBatch = { resync: true, changes: [] }
const named = (revision: string): LiveBatch => ({ resync: false, changes: [{ kind: 'product-kit', key: 'product-kit', revision, removed: false }] })

describe('createProductKitTracker (Product Kit follow of the open Preview)', () => {
	it('counts a change between the Preview start and the first resync', async () => {
		let current = 'r1'
		const tracker = createProductKitTracker(async () => current)
		await tracker.startPreview()
		current = 'r2'
		expect(await tracker.moved(resync)).toBe(true)
		expect(await tracker.moved(resync)).toBe(false)
	})

	it('counts a change between the Preview start and the first named event', async () => {
		const tracker = createProductKitTracker(async () => 'r1')
		await tracker.startPreview()
		expect(await tracker.moved(named('r1'))).toBe(false)
		expect(await tracker.moved(named('r2'))).toBe(true)
	})

	it('treats a named event as a change when no baseline is known, and ignores unrelated batches', async () => {
		const tracker = createProductKitTracker(async () => { throw new Error('offline') })
		await tracker.startPreview()
		expect(await tracker.moved({ resync: false, changes: [{ kind: 'view', key: 'v', removed: false }] })).toBe(false)
		expect(await tracker.moved(resync)).toBe(false)
		expect(await tracker.moved(named('r1'))).toBe(true)
	})

	it('does not let a slow baseline read overwrite a newer revision or a newer Preview start', async () => {
		const reads: ((revision: string) => void)[] = []
		const tracker = createProductKitTracker(() => new Promise<string>(resolve => reads.push(resolve)))
		const first = tracker.startPreview()
		expect(await tracker.moved(named('r2'))).toBe(true)
		reads[0]!('r1')
		await first
		expect(await tracker.moved(named('r2'))).toBe(false)
		const second = tracker.startPreview()
		const third = tracker.startPreview()
		reads[1]!('stale')
		reads[2]!('r3')
		await Promise.all([second, third])
		expect(await tracker.moved(named('r3'))).toBe(false)
	})

	it('does not let a slow resync read of a superseded Preview overwrite the new baseline', async () => {
		const reads: ((revision: string) => void)[] = []
		const tracker = createProductKitTracker(() => new Promise<string>(resolve => reads.push(resolve)))
		const first = tracker.startPreview()
		reads[0]!('r1')
		await first
		const slowResync = tracker.moved(resync)
		const second = tracker.startPreview()
		reads[2]!('r2')
		await second
		reads[1]!('r1')
		expect(await slowResync).toBe(false)
		expect(await tracker.moved(named('r2'))).toBe(false)
	})
})
