import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearPreviewBundleCache } from '../src/server/preview-bundler'
import { readSelectedWorkspaceWidgetCatalog } from '../src/server/widget-catalog'
import { writeCurrentWorkspace } from './support/workspace-layout'

const temporaryRoots: string[] = []
afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function adapterSource(fields: unknown): string {
	return `
import { createWidgetPlugin, createWidgetValueContract } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';

const TRANSLATION_RESULT = createWidgetValueContract('deviltea.uiux/translation-result@1');
const STRING = createWidgetValueContract('deviltea.uiux/string@1');

export const labelPlugin = createWidgetPlugin('Label')
  .description('A translatable label')
  .interfaces()
  .config({
    description: 'The label\\'s Config',
    schema: { type: 'object', required: ['titleKey'], properties: { titleKey: { type: 'string', description: 'The message key' }, image: { type: 'object' } }, additionalProperties: false },
    validate: (input) => input === null || (typeof input === 'object' && !Array.isArray(input)),
    resolve: (raw) => ({ titleKey: raw?.titleKey ?? null }),
  })
  .properties(p => p
    .titleResult({ valueContract: TRANSLATION_RESULT, compute: () => ({ text: 'Hello', warnings: [] }) })
    .title({ valueContract: STRING, compute: () => 'Hello' }))
  .events(events => events.pressed({ description: 'Pressed' }))
  .done();

export const LabelRenderer = defineComponent({ name: 'LabelRenderer', setup: () => () => h('span', 'Label') });

export const manifest = {
  id: 'label-adapter',
  apiVersion: '1',
  widgetPlugins: [labelPlugin],
  catalog: { widgets: { Label: {
    i18n: { fields: ${JSON.stringify(fields)} },
    assetFields: { image: { acceptedMediaTypes: ['image/png'], acceptedCategories: ['illustration'] } },
  } } },
  renderers: [{ type: 'Label', component: LabelRenderer }],
  providers: [],
};
`
}

async function workspace(fields: unknown): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-widget-catalog-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name)).catch(() => undefined)
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [{ moduleSpecifier: './adapters/label.mjs' }], viewports: {}, themes: {} })
	await writeFile(join(root, 'kit', 'adapters', 'label.mjs'), adapterSource(fields))
	return root
}

describe('readSelectedWorkspaceWidgetCatalog (Rule 01a17443-6b37-797e-963c-282f2ec400a7)', () => {
	it('lists each Widget type with its plugin declarations and Catalog entry', async () => {
		const root = await workspace({ title: { configField: 'titleKey', params: { n: 'title' } } })
		const result = await readSelectedWorkspaceWidgetCatalog(root)
		expect(result.state).toBe('valid')
		if (result.state !== 'valid') return
		const label = result.entries.find(entry => entry.type === 'Label')!
		expect(label).toMatchObject({
			adapterIndex: 0,
			adapterId: 'label-adapter',
			description: 'A translatable label',
			config: { description: 'The label\'s Config', schema: { required: ['titleKey'], properties: { titleKey: { type: 'string' } } } },
			properties: [{ name: 'titleResult', valueContractId: 'deviltea.uiux/translation-result@1' }, { name: 'title', valueContractId: 'deviltea.uiux/string@1' }],
			events: [{ name: 'pressed', description: 'Pressed' }],
			// The omitted Property names are resolved the way the Adapter check resolves them.
			i18n: [{ authorField: 'title', configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'title', params: { n: 'title' } }],
			assetFields: [{ field: 'image', acceptedMediaTypes: ['image/png'], acceptedCategories: ['illustration'] }],
		})
	})

	it('still lists the entries of a set whose Catalog has a problem, so the problem shows against its entry', async () => {
		const root = await workspace({ title: { configField: 'missing' } })
		const result = await readSelectedWorkspaceWidgetCatalog(root)
		expect(result).toMatchObject({ state: 'valid', entries: [{ type: 'Label' }] })
	})

	it('has no list for a Workspace whose Adapters do not resolve', async () => {
		const root = await workspace({})
		await writeFile(join(root, 'kit', 'adapters', 'label.mjs'), 'export const manifest = 1;')
		expect(await readSelectedWorkspaceWidgetCatalog(root)).toEqual({ state: 'unavailable' })
	})
})
