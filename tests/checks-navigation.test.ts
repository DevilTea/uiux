import { describe, expect, it } from 'vitest'
import {
	resolveAllChecks,
	resolveDiagnosticWidgetTarget,
	type DiagnosticItem,
} from '../src/preview/checks-navigation'

describe('checks-navigation target resolution', () => {
	const knownIds = new Set(['root', 'btn-1', 'card-hero', 'slot-child'])
	const sampleIr = {
		id: 'root',
		type: 'RootShell',
		slots: {
			content: [
				{ id: 'card-hero', type: 'Card' },
				{ id: 'btn-1', type: 'Button' },
			],
		},
	}

	it('resolves /ir and /ir/ to root when root is known', () => {
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'invalid_root', path: '/ir', message: 'Root invalid' },
				sampleIr,
				knownIds,
			),
		).toBe('root')

		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'invalid_root', path: '/ir/', message: 'Root invalid' },
				sampleIr,
				knownIds,
			),
		).toBe('root')
	})

	it('resolves slot child by index path /ir/slots/content/0', () => {
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'missing_prop', path: '/ir/slots/content/0/props/title', message: 'Missing title' },
				sampleIr,
				knownIds,
			),
		).toBe('card-hero')

		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'missing_label', path: '/ir/slots/content/1/props/label', message: 'Missing label' },
				sampleIr,
				knownIds,
			),
		).toBe('btn-1')
	})

	it('resolves widget by explicit id reference in message or path', () => {
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'prop_error', path: '/something', message: 'Widget #btn-1 is invalid' },
				sampleIr,
				knownIds,
			),
		).toBe('btn-1')

		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'prop_error', path: '/something', message: 'Target "card-hero" has invalid spec' },
				sampleIr,
				knownIds,
			),
		).toBe('card-hero')
	})

	it('strictly returns undefined for unresolved locations and does not guess', () => {
		// Non-matching path and message
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'manifest_error', path: '/spec/name', message: 'Name is empty' },
				sampleIr,
				knownIds,
			),
		).toBeUndefined()

		// Slot index out of bounds
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'out_of_bounds', path: '/ir/slots/content/99', message: 'Invalid child' },
				sampleIr,
				knownIds,
			),
		).toBeUndefined()

		// Unknown widget id in message
		expect(
			resolveDiagnosticWidgetTarget(
				{ code: 'unknown_id', path: '/unmatched', message: 'Widget #ghost-widget missing' },
				sampleIr,
				knownIds,
			),
		).toBeUndefined()
	})

	it('resolves all checks while preserving ordering and keeping workspace diagnostics unanchored', () => {
		const viewDiags: DiagnosticItem[] = [
			{ code: 'v1', path: '/ir', message: 'Root warning' },
			{ code: 'v2', path: '/ir/slots/content/0', message: 'Hero warning' },
			{ code: 'v3', path: '/unknown', message: 'Unresolved view diagnostic' },
		]

		const wsDiags: DiagnosticItem[] = [
			{ code: 'w1', path: '/manifest/i18n', message: 'Default locale missing' },
			{ code: 'w2', path: '/manifest/adapters', message: 'Adapter invalid' },
		]

		const result = resolveAllChecks(viewDiags, wsDiags, sampleIr, knownIds)

		expect(result).toHaveLength(5)

		// Exact sequence preserved: View first, Workspace second
		expect(result[0]).toEqual({
			source: 'View',
			code: 'v1',
			path: '/ir',
			message: 'Root warning',
			resolvedWidgetId: 'root',
		})

		expect(result[1]).toEqual({
			source: 'View',
			code: 'v2',
			path: '/ir/slots/content/0',
			message: 'Hero warning',
			resolvedWidgetId: 'card-hero',
		})

		expect(result[2]).toEqual({
			source: 'View',
			code: 'v3',
			path: '/unknown',
			message: 'Unresolved view diagnostic',
			resolvedWidgetId: undefined,
		})

		expect(result[3]).toEqual({
			source: 'Workspace',
			code: 'w1',
			path: '/manifest/i18n',
			message: 'Default locale missing',
			resolvedWidgetId: undefined,
		})

		expect(result[4]).toEqual({
			source: 'Workspace',
			code: 'w2',
			path: '/manifest/adapters',
			message: 'Adapter invalid',
			resolvedWidgetId: undefined,
		})
	})
})
