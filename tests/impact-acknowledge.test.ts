import { describe, expect, it } from 'vitest'

import { IMPACT_CATEGORIES } from '../src/domain/impact'
import { classifyAcknowledgedWriteAnswer, DELETE_ROUTES, failureOf } from '../app/utils/impact-acknowledge'
import { groupImpacts } from '../app/utils/version-restore'

/** The Workbench's reading of a write that may need the caller's acknowledgement (issue #75, Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34). */
describe('classifyAcknowledgedWriteAnswer', () => {
	it('reads a written result as done, a delete included', () => {
		expect(classifyAcknowledgedWriteAnswer(200, { status: 'updated' })).toEqual({ state: 'done', status: 'updated' })
		expect(classifyAcknowledgedWriteAnswer(200, { status: 'deleted', key: 'k' })).toEqual({ state: 'done', status: 'deleted' })
		expect(classifyAcknowledgedWriteAnswer(201, { status: 'created' })).toEqual({ state: 'done', status: 'created' })
	})

	it('tells the impact refusal from a revision conflict, which are both 409', () => {
		const impacts = [{ category: 'render_key_removed', dimension: 'viewport', key: 'tablet', reviewIds: [] }]
		expect(classifyAcknowledgedWriteAnswer(409, { status: 'impact_acknowledgement_required', key: 'workspace', impacts })).toEqual({ state: 'impact', impacts })
		expect(classifyAcknowledgedWriteAnswer(409, { status: 'impact_acknowledgement_required' })).toEqual({ state: 'impact', impacts: [] })
		expect(classifyAcknowledgedWriteAnswer(409, { status: 'conflict', currentRevision: 'r' })).toEqual({ state: 'conflict' })
	})

	it('reads a lease, a missing key and the other refusals', () => {
		expect(classifyAcknowledgedWriteAnswer(423, { status: 'locked' })).toEqual({ state: 'locked' })
		expect(classifyAcknowledgedWriteAnswer(403, { status: 'blocked', code: 'auth.scope_denied' })).toEqual({ state: 'refused', status: 'denied' })
		expect(classifyAcknowledgedWriteAnswer(422, { status: 'blocked' })).toEqual({ state: 'refused', status: 'blocked' })
		expect(classifyAcknowledgedWriteAnswer(404, { status: 'not_found' })).toEqual({ state: 'refused', status: 'not_found' })
		expect(classifyAcknowledgedWriteAnswer(400, { status: 'invalid' })).toEqual({ state: 'refused', status: 'invalid' })
		expect(classifyAcknowledgedWriteAnswer(500, undefined)).toEqual({ state: 'refused', status: 'failed' })
	})

	it('takes the status and body of a failed request', () => {
		expect(failureOf({ statusCode: 409, data: { status: 'conflict' } })).toEqual({ status: 409, body: { status: 'conflict' } })
		expect(failureOf({ status: 423 })).toEqual({ status: 423, body: undefined })
	})

	it('routes the delete of each kind to its collection', () => {
		expect(DELETE_ROUTES).toEqual({ view: 'views', flow: 'flows', asset: 'assets' })
	})
})

describe('the impact list groups', () => {
	it('places every category the analyzer lists in a group of its own, none under "other"', () => {
		const items = IMPACT_CATEGORIES.map(category => ({ category }))
		const groups = groupImpacts(items)
		expect(groups.some(entry => entry.group === 'other')).toBe(false)
		expect(groups.flatMap(entry => entry.items)).toHaveLength(IMPACT_CATEGORIES.length)
	})
})
