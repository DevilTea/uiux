import { describe, expect, it } from 'vitest'
import { parseThread, parseViewPanel, parseViewRouteContext, sameQuery, viewLocation, viewQuery } from '../app/utils/workbench-routes'
import { reviewerInitials } from '../app/composables/useReviewerIdentity'

describe('Workbench deep-link contract', () => {
	it('carries only explicit render context in the query', () => {
		expect(viewQuery({ variant: '', locale: 'zh-TW', viewport: 'tablet', theme: 'light', widget: 'root' }))
			.toEqual({ locale: 'zh-TW', viewport: 'tablet', theme: 'light' })
		expect(viewLocation('7f3d', { variant: 'compact', widget: 'cta', thread: 't1', panel: 'spec' }))
			.toEqual({ path: '/views/7f3d', query: { variant: 'compact', widget: 'cta', thread: 't1', panel: 'spec' } })
	})

	it('round-trips a deep link and defaults the Widget to the RootShell', () => {
		const query = { variant: 'compact', locale: 'zh-TW', viewport: 'tablet', theme: 'light', thread: 'abc', panel: 'readiness' }
		expect(parseViewRouteContext(query)).toEqual({ variant: 'compact', locale: 'zh-TW', viewport: 'tablet', theme: 'light', widget: 'root' })
		expect(parseThread(query)).toBe('abc')
		expect(parseViewPanel(query)).toBe('readiness')
		expect(parseViewPanel({ panel: 'nonsense' })).toBeUndefined()
		expect(parseViewRouteContext({ locale: ['en-US', 'zh-TW'] }).locale).toBe('en-US')
	})

	it('compares queries without order or empty values', () => {
		expect(sameQuery({ a: '1', b: '2' }, { b: '2', a: '1', c: '' })).toBe(true)
		expect(sameQuery({ a: '1' }, { a: '2' })).toBe(false)
	})
})

describe('Reviewer initials', () => {
	it('derives initials from a local display name', () => {
		expect(reviewerInitials('Mei Lin')).toBe('ML')
		expect(reviewerInitials('  jordan  ')).toBe('JO')
		expect(reviewerInitials('林美')).toBe('林')
		expect(reviewerInitials('')).toBe('')
	})
})
