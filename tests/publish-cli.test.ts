import { describe, expect, it } from 'vitest'

import { assertSeparatePublicationPaths, parsePublishArguments } from '../bin/publish.mjs'

describe('uiux publish CLI', () => {
	it('parses required and optional publication arguments without depending on argument order', () => {
		expect(parsePublishArguments([
			'--base', '/uiux/',
			'--workspace', './design',
			'--source-revision', 'abc123',
			'--out', './.pages',
		])).toEqual({
			workspace: './design',
			out: './.pages',
			base: '/uiux/',
			sourceRevision: 'abc123',
		})
	})

	it('rejects missing values and unknown flags', () => {
		expect(parsePublishArguments(['--workspace', './design'])).toBeUndefined()
		expect(parsePublishArguments(['--workspace', './design', '--out'])).toBeUndefined()
		expect(parsePublishArguments(['--workspace', './design', '--out', './.pages', '--wat', '1'])).toBeUndefined()
	})

	it('rejects publication outputs that overlap the Workspace or contain the UIUX package root', () => {
		expect(() => assertSeparatePublicationPaths('/project/design', '/project/design')).toThrow(/separate/)
		expect(() => assertSeparatePublicationPaths('/project/design', '/project/design/site')).toThrow(/separate/)
		expect(() => assertSeparatePublicationPaths('/project/design', '/project')).toThrow(/separate/)
		expect(() => assertSeparatePublicationPaths('/external/workspace', '/project', '/project')).toThrow(/package root/)
		expect(() => assertSeparatePublicationPaths('/external/workspace', '/', '/project')).toThrow()
		expect(() => assertSeparatePublicationPaths('/project/design', '/project/publication', '/project')).not.toThrow()
	})
})
