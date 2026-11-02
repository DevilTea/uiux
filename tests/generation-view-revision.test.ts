import { describe, expect, it } from 'vitest'
import { anchorGenerationView, anchorOnViewLoad } from '../app/utils/generation-view-revision'

/**
 * The revision of the View an open Preview generation renders (issue #52, Clause
 * 01a19ab9-d028-7bb9-a370-4736992852f5; the exact fix is issue #484): taken when the generation is
 * admitted, filled by the first load of the same View when it was not loaded then, and never moved by
 * a later edit that starts no new generation.
 */
const VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const OTHER = '11111111-1111-4111-8111-111111111111'

describe('the View revision a generation renders', () => {
	it('is the revision of the selected View when it is loaded at admission', () => {
		expect(anchorGenerationView(VIEW, { key: VIEW, revision: 'r1' })).toEqual({ viewId: VIEW, revision: 'r1' })
	})

	it('is unknown at admission when the View is not loaded, or another View is', () => {
		expect(anchorGenerationView(VIEW, undefined)).toEqual({ viewId: VIEW })
		expect(anchorGenerationView(VIEW, { key: OTHER, revision: 'r9' })).toEqual({ viewId: VIEW })
		expect(anchorGenerationView(undefined, { key: VIEW, revision: 'r1' })).toBeUndefined()
	})

	it('is filled by the first load of the same View', () => {
		expect(anchorOnViewLoad({ viewId: VIEW }, { key: VIEW, revision: 'r2' })).toEqual({ viewId: VIEW, revision: 'r2' })
	})

	it('is not filled by the load of another View or by no View', () => {
		expect(anchorOnViewLoad({ viewId: VIEW }, { key: OTHER, revision: 'r2' })).toEqual({ viewId: VIEW })
		expect(anchorOnViewLoad({ viewId: VIEW }, undefined)).toEqual({ viewId: VIEW })
		expect(anchorOnViewLoad(undefined, { key: VIEW, revision: 'r2' })).toBeUndefined()
	})

	it('never moves once known: a Spec-only edit changes the View revision but not the generation', () => {
		const anchor = { viewId: VIEW, revision: 'r1' }
		expect(anchorOnViewLoad(anchor, { key: VIEW, revision: 'r2' })).toBe(anchor)
	})
})
