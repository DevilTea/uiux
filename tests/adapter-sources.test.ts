import { describe, expect, it } from 'vitest'
import type { AdapterManifest } from '../src/domain/adapters/schema'
import { isContainedSourcePath, validateAdapterSources } from '../src/domain/adapters/sources'

const manifestWith = (sources?: unknown) => ({
	id: 'acme',
	apiVersion: '1',
	widgetPlugins: [],
	catalog: { widgets: {} },
	renderers: [],
	providers: [],
	...(sources === undefined ? {} : { sources }),
}) as unknown as AdapterManifest

describe('Adapter manifest sources (Clauses 01a11a5a-4511-… and 01a11a5a-45a7-…)', () => {
	it('accepts a manifest without sources and a valid mapping of an owned Widget type', () => {
		expect(validateAdapterSources(manifestWith(), ['Badge']).ok).toBe(true)
		const mapping = {
			Badge: {
				semantic: { path: 'src/badge.ts' },
				renderer: { path: 'src/Badge.vue', package: '@acme/ds', embed: false },
				designSystem: { url: 'https://example.com/badge' },
				supporting: [{ path: 'docs/badge.md' }, { url: 'http://example.com/x' }],
			},
		}
		expect(validateAdapterSources(manifestWith(mapping), ['Badge']).ok).toBe(true)
	})

	it.each([
		['a Widget type the Adapter does not own', { Other: { semantic: { path: 'a' }, renderer: { path: 'b' } } }],
		['a missing renderer', { Badge: { semantic: { path: 'a' } } }],
		['an unknown slot', { Badge: { semantic: { path: 'a' }, renderer: { path: 'b' }, extra: { path: 'c' } } }],
		['a path leaving its root', { Badge: { semantic: { path: '../a' }, renderer: { path: 'b' } } }],
		['an absolute path', { Badge: { semantic: { path: '/etc/passwd' }, renderer: { path: 'b' } } }],
		['a url with a path', { Badge: { semantic: { url: 'https://example.com', path: 'a' }, renderer: { path: 'b' } } }],
		['a non-http url', { Badge: { semantic: { url: 'javascript:alert(1)' }, renderer: { path: 'b' } } }],
		['a malformed package', { Badge: { semantic: { path: 'a', package: '../x' }, renderer: { path: 'b' } } }],
		['a non-boolean embed', { Badge: { semantic: { path: 'a', embed: 'no' }, renderer: { path: 'b' } } }],
		['a supporting entry that is not a list', { Badge: { semantic: { path: 'a' }, renderer: { path: 'b' }, supporting: { path: 'c' } } }],
		['sources that is not an object', ['Badge']],
	])('refuses %s as adapter.invalid_sources', (_name, sources) => {
		const result = validateAdapterSources(manifestWith(sources), ['Badge'])
		expect(result.ok).toBe(false)
		expect(result.diagnostics.length).toBeGreaterThan(0)
	})

	it('judges a path contained only when it is relative and has no empty, dot or parent segment', () => {
		expect(isContainedSourcePath('a/b.ts')).toBe(true)
		for (const bad of ['', '/a', 'a//b', './a', 'a/../b', '..', 'a\\b', 'C:/a'])
			expect(isContainedSourcePath(bad), bad).toBe(false)
	})
})
