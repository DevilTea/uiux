import { describe, expect, it } from 'vitest'
import { isSubmittable, submissionBody } from '../app/utils/review-submission'

describe('human Submit for review (R12)', () => {
	const view = { key: '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1', revision: 'r_abc' }

	it('needs a change domain and a piece of Evidence', () => {
		expect(isSubmittable({ changeDomains: [], evidence: ['sha256:1'] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['  '], evidence: ['sha256:1'] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['Spec'], evidence: [] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['Spec'], evidence: ['sha256:1'] })).toBe(true)
	})

	it('names the anchored View at its current revision and references formal captures', () => {
		expect(submissionBody({ changeDomains: [' Spec', 'Spec', 'i18n'], evidence: ['sha256:1', 'sha256:1'], reason: '  check the copy ' }, view, 'r_thread')).toEqual({
			expectedRevision: 'r_thread',
			changeDomains: ['Spec', 'i18n'],
			resources: [{ identity: { kind: 'view', key: view.key }, revision: 'r_abc' }],
			evidenceRefs: [{ kind: 'formal_capture', evidence: 'sha256:1' }],
			reason: 'check the copy',
		})
	})

	it('omits an empty note', () => {
		expect(submissionBody({ changeDomains: ['IR'], evidence: ['sha256:2'], reason: '  ' }, view, 'r_t')).not.toHaveProperty('reason')
	})
})
