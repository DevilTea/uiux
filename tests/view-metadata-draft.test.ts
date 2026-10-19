import { describe, expect, it } from 'vitest'

import { viewMetadataChange, viewMetadataDraftOf } from '../app/utils/view-metadata'

/**
 * The View page header's rename form (Rule 01a1537a-333f-7246-b39c-5feca6f4b3c7) sends only what
 * changed through `PUT /api/views/:id/metadata` (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85).
 */
describe('viewMetadataChange', () => {
	const tagged = { name: 'Checkout', feature: 'checkout' }

	it('starts the draft from the View, with an empty tag field for an untagged View', () => {
		expect(viewMetadataDraftOf(tagged)).toEqual({ name: 'Checkout', feature: 'checkout' })
		expect(viewMetadataDraftOf({ name: 'Checkout' })).toEqual({ name: 'Checkout', feature: '' })
	})

	it('sends nothing when nothing changed, white space around the values included', () => {
		expect(viewMetadataChange(tagged, { name: ' Checkout ', feature: 'checkout ' })).toBeUndefined()
		expect(viewMetadataChange({ name: 'Checkout' }, { name: 'Checkout', feature: '  ' })).toBeUndefined()
	})

	it('sends only the changed fields, the name trimmed', () => {
		expect(viewMetadataChange(tagged, { name: '  Pay  ', feature: 'checkout' })).toEqual({ name: 'Pay' })
		expect(viewMetadataChange(tagged, { name: 'Checkout', feature: 'payments' })).toEqual({ feature: 'payments' })
		expect(viewMetadataChange({ name: 'Checkout' }, { name: 'Pay', feature: 'payments' })).toEqual({ name: 'Pay', feature: 'payments' })
	})

	it('sends feature null when the tag field is emptied', () => {
		expect(viewMetadataChange(tagged, { name: 'Checkout', feature: '' })).toEqual({ feature: null })
		expect(viewMetadataChange(tagged, { name: 'Checkout', feature: '   ' })).toEqual({ feature: null })
	})
})
