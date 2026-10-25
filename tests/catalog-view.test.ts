import { describe, expect, it } from 'vitest'

import type { DescribedWidgetCatalogEntry } from '../src/preview/widget-catalog'
import { catalogView, configProperties, filterCatalogRows } from '../app/utils/catalog-view'

function entry(type: string, extra: Partial<DescribedWidgetCatalogEntry> = {}): DescribedWidgetCatalogEntry {
	return { adapterIndex: 0, adapterId: 'acme', type, description: `The ${type} Widget`, config: null, properties: [], state: [], events: [], i18n: [], assetFields: [], ...extra }
}
const view = (key: string, types: string[]) => ({
	resource: { kind: 'view' as const, key, name: key },
	widgets: types.map((type, index) => ({ id: `w${index}`, type })),
})
const problem = (path: string) => ({ code: 'adapter.x', path, message: 'no' })

describe('catalogView (Rules 01a17443-6b37-797e-963c-282f2ec400a7 and 01a17443-7bab-7b39-9c40-97216f67b582)', () => {
	it('lists which Views use each entry, with the number of its Widgets', () => {
		const result = catalogView([entry('Text'), entry('Badge')], [view('home', ['Text', 'Text']), view('about', ['Badge'])], true, [])
		expect(result.rows.map(row => [row.entry.type, row.usage, row.views.map(item => [item.resource.key, item.widgets])])).toEqual([
			['Text', 'used', [['home', 2]]],
			['Badge', 'used', [['about', 1]]],
		])
	})

	it('says an entry no View uses is unused only when every View was read', () => {
		expect(catalogView([entry('Text')], [view('home', ['Badge'])], true, []).rows[0]!.usage).toBe('unused')
		expect(catalogView([entry('Text')], [view('home', ['Badge'])], false, []).rows[0]!.usage).toBe('unknown')
		expect(catalogView([entry('Text')], [view('home', ['Text'])], false, []).rows[0]!.usage).toBe('used')
	})

	it('attaches each problem to its own Adapter and entry, and keeps the Adapter set\'s apart', () => {
		const text = problem('/adapters/0/manifest/catalog/widgets/Text/i18n/fields/label')
		const other = problem('/adapters/1/manifest/catalog/widgets/Text/assetFields/src')
		const set = problem('/adapters/0/id')
		const missing = problem('/adapters/0/manifest/catalog/widgets/Gone')
		const result = catalogView([entry('Text'), entry('Text', { adapterIndex: 1, adapterId: 'other' })], [], true, [text, other, set, missing])
		expect(result.rows.map(row => row.problems)).toEqual([[text], [other]])
		expect(result.setProblems).toEqual([set, missing])
	})

	it('filters by Adapter, type or description', () => {
		const rows = catalogView([entry('Text'), entry('Badge', { adapterId: 'zeta', description: 'A small label' })], [], true, []).rows
		expect(filterCatalogRows(rows, ' ').length).toBe(2)
		expect(filterCatalogRows(rows, 'ZETA').map(row => row.entry.type)).toEqual(['Badge'])
		expect(filterCatalogRows(rows, 'label').map(row => row.entry.type)).toEqual(['Badge'])
		expect(filterCatalogRows(rows, 'nothing')).toEqual([])
	})
})

describe('configProperties', () => {
	it('reads the top-level members of a Config schema', () => {
		expect(configProperties({
			type: 'object',
			required: ['label'],
			properties: { label: { type: 'string', description: 'Shown text' }, size: { enum: ['s', 'm'] }, any: { type: ['string', 'null'] }, ref: { $ref: '#/x' }, odd: 3 },
		})).toEqual([
			{ name: 'label', type: 'string', required: true, description: 'Shown text' },
			{ name: 'size', type: '"s" | "m"', required: false, description: '' },
			{ name: 'any', type: 'string | null', required: false, description: '' },
			{ name: 'ref', type: '#/x', required: false, description: '' },
			{ name: 'odd', type: '', required: false, description: '' },
		])
		expect(configProperties(true)).toEqual([])
		expect(configProperties(null)).toEqual([])
		expect(configProperties({ properties: [] })).toEqual([])
	})
})
