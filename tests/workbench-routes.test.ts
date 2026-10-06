import { describe, expect, it } from 'vitest'
import { parseThread, parseViewPanel, parseViewRouteContext, sameQuery, viewLocation, viewQuery } from '../app/utils/workbench-routes'
import { memberInitials } from '../app/utils/member-initials'

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

describe('Member initials', () => {
	it('derives initials from a roster nickname or a recorded display name', () => {
		expect(memberInitials('Mei Lin')).toBe('ML')
		expect(memberInitials('  jordan  ')).toBe('JO')
		expect(memberInitials('林美')).toBe('林')
		expect(memberInitials('mei.lin')).toBe('ML')
		expect(memberInitials('claude-wt-a')).toBe('CA')
		expect(memberInitials('')).toBe('')
	})
})
