import { describe, expect, it } from 'vitest'
import {
	catalogEntryOf,
	catalogProblems,
	categoryOf,
	combineStates,
	compareFindings,
	filterFindings,
	groupFindings,
	sectionFindings,
	SOURCE_SEVERITY,
	severityOf,
	unsettledSources,
	translationReminders,
	variantOfPath,
	type Finding,
	type FindingResource,
	type ViewUsage,
} from '../app/utils/checks'
import { localeCellLocation, parseLocaleCell } from '../app/utils/workbench-routes'

/**
 * Overview › Checks findings (issue #95): the order, the filters, the grouping, the check states,
 * the translation reminders and the Catalog problems. They are Workbench view models built from
 * reads the Workbench already makes; none of them is a wire shape.
 */

const checkout: FindingResource = { kind: 'view', key: 'view-checkout', name: 'Checkout' }
const account: FindingResource = { kind: 'view', key: 'view-account', name: 'Account' }
const workspace: FindingResource = { kind: 'workspace', key: 'workspace', name: 'Workspace settings' }
const french: FindingResource = { kind: 'locale', key: 'fr-FR', name: 'fr-FR' }

function finding(overrides: Partial<Finding> & Pick<Finding, 'code'>): Finding {
	return { message: overrides.code, path: '/', resource: workspace, source: 'validation', severity: 'error', checkState: 'completed', ...overrides }
}

describe('default order (Rule 01a115cd-bd48-7c10-82fc-827d5e8e5ba8)', () => {
	it('orders by severity, then code, then a stable View and Widget location', () => {
		const list: Finding[] = [
			finding({ code: 'i18n.empty_translation', severity: 'warning', resource: french, source: 'translation', translationKey: 'a' }),
			finding({ code: 'view.zeta', resource: checkout, widgetId: 'w2' }),
			finding({ code: 'view.zeta', resource: account, widgetId: 'w9' }),
			finding({ code: 'view.zeta', resource: checkout, widgetId: 'w1' }),
			finding({ code: 'schema.alpha', resource: workspace }),
			finding({ code: 'kit.registry', severity: 'warning', resource: { kind: 'product-kit', key: 'kit', name: 'Product Kit' }, source: 'product-kit' }),
		]
		const sorted = [...list].sort(compareFindings)
		expect(sorted.map(item => [item.severity, item.code, item.resource.name, item.widgetId ?? ''])).toEqual([
			['error', 'schema.alpha', 'Workspace settings', ''],
			['error', 'view.zeta', 'Account', 'w9'],
			['error', 'view.zeta', 'Checkout', 'w1'],
			['error', 'view.zeta', 'Checkout', 'w2'],
			['warning', 'i18n.empty_translation', 'fr-FR', ''],
			['warning', 'kit.registry', 'Product Kit', ''],
		])
	})

	it('lists groups in that order whatever order the findings arrive in', () => {
		const list: Finding[] = [
			finding({ code: 'i18n.empty_translation', severity: 'warning', resource: french, source: 'translation' }),
			finding({ code: 'view.zeta', resource: checkout }),
			finding({ code: 'schema.alpha' }),
		]
		expect(groupFindings(list).map(group => [group.code, group.severity])).toEqual([['schema.alpha', 'error'], ['view.zeta', 'error'], ['i18n.empty_translation', 'warning']])
		expect(groupFindings([...list].reverse()).map(group => group.code)).toEqual(['schema.alpha', 'view.zeta', 'i18n.empty_translation'])
	})
})

describe('grouping problem → resource → Widget', () => {
	it('groups findings by code, then resource, in the default order', () => {
		const groups = groupFindings([
			finding({ code: 'schema.unknown_prop', resource: checkout, widgetId: 'promo' }),
			finding({ code: 'i18n.invalid_key', resource: workspace }),
			finding({ code: 'schema.unknown_prop', resource: checkout, widgetId: 'cta' }),
		])
		expect(groups.map(group => [group.code, group.category, group.count])).toEqual([['i18n.invalid_key', 'i18n', 1], ['schema.unknown_prop', 'schema', 2]])
		expect(groups[1]!.resources).toHaveLength(1)
		expect(groups[1]!.resources[0]!.findings.map(item => item.widgetId)).toEqual(['cta', 'promo'])
	})

	it('keeps a finding without a code in the group it names', () => {
		const group = { key: 'props_emits', title: 'Component declares no props or emits' }
		const groups = groupFindings([
			finding({ code: '', source: 'product-kit', severity: 'warning', group, resource: { kind: 'product-kit', key: 'A', name: 'A' } }),
			finding({ code: '', source: 'product-kit', severity: 'warning', group, resource: { kind: 'product-kit', key: 'B', name: 'B' } }),
		])
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({ code: '', title: group.title, category: 'kit', count: 2 })
	})

	it('splits one code into the problems its findings name', () => {
		const groups = groupFindings([
			finding({ code: 'adapter.x', problem: '/adapters/0/manifest/catalog/widgets/A' }),
			finding({ code: 'adapter.x', problem: '/adapters/0/manifest/catalog/widgets/B' }),
			finding({ code: 'adapter.x', problem: '/adapters/0/manifest/catalog/widgets/A', resource: checkout }),
		])
		expect(groups.map(group => group.count)).toEqual([2, 1])
	})
})

describe('filters and grouping dimensions (Rule 01a115cd-bd13-778b-8a0a-b4d43cd98aa7)', () => {
	const list: Finding[] = [
		finding({ code: 'schema.a', resource: checkout }),
		finding({ code: 'adapter.b', resource: account, source: 'catalog', widgetId: 'w' }),
		finding({ code: 'i18n.empty_translation', severity: 'warning', resource: french, source: 'translation' }),
		finding({ code: 'kit.live', severity: 'warning', resource: checkout, source: 'product-kit', variantName: 'compact' }),
		finding({ code: '', severity: 'warning', resource: { kind: 'product-kit', key: 'C', name: 'C' }, source: 'product-kit', group: { key: 'props_emits', title: 't' } }),
	]

	it('filters by source, category, severity, View and Variant, all of which must match', () => {
		expect(filterFindings(list, { source: 'catalog' }).map(item => item.code)).toEqual(['adapter.b'])
		expect(filterFindings(list, { category: 'i18n' }).map(item => item.code)).toEqual(['i18n.empty_translation'])
		expect(filterFindings(list, { category: 'kit' }).map(item => item.source)).toEqual(['product-kit', 'product-kit'])
		expect(filterFindings(list, { severity: 'error' })).toHaveLength(2)
		expect(filterFindings(list, { view: 'view-checkout' }).map(item => item.code)).toEqual(['schema.a', 'kit.live'])
		expect(filterFindings(list, { variant: 'compact' }).map(item => item.code)).toEqual(['kit.live'])
		expect(filterFindings(list, { view: 'view-checkout', severity: 'warning' }).map(item => item.code)).toEqual(['kit.live'])
		expect(filterFindings(list, {})).toHaveLength(list.length)
		expect(categoryOf(list[4]!)).toBe('kit')
	})

	it('has no Variant for a finding off the Product Kit capture checks, and a View filter names Views only', () => {
		expect(filterFindings(list, { view: 'fr-FR' })).toEqual([])
		expect(filterFindings(list, { variant: 'missing' })).toEqual([])
	})

	it('sections findings by source, severity or View in a stable order; problem is one section', () => {
		expect(sectionFindings(list, 'problem').map(section => section.findings.length)).toEqual([5])
		expect(sectionFindings(list, 'source').map(section => section.value)).toEqual(['validation', 'translation', 'catalog', 'product-kit'])
		expect(sectionFindings(list, 'severity').map(section => [section.value, section.findings.length])).toEqual([['error', 2], ['warning', 3]])
		// Account sorts before Checkout; findings off a View come last.
		expect(sectionFindings(list, 'view').map(section => section.value)).toEqual(['view-account', 'view-checkout', ''])
	})
})

describe('check states (Rule 01a115cd-bb96-7131-99d9-a3882829590c)', () => {
	it('is not checked while no part has run, never completed', () => {
		expect(combineStates([])).toBe('not_checked')
		expect(combineStates(['not_checked', 'not_checked'])).toBe('not_checked')
	})

	it('is checking while any part is, completed only when every part is', () => {
		expect(combineStates(['completed', 'checking'])).toBe('checking')
		expect(combineStates(['completed', 'completed'])).toBe('completed')
	})

	it('is failed when no part finished and incomplete when some did not', () => {
		expect(combineStates(['failed', 'failed'])).toBe('failed')
		expect(combineStates(['completed', 'failed'])).toBe('incomplete')
		expect(combineStates(['completed', 'incomplete'])).toBe('incomplete')
		expect(combineStates(['not_checked', 'completed'])).toBe('incomplete')
	})
})

describe('unsettled sources (Rule 01a115cd-bb96-7131-99d9-a3882829590c)', () => {
	it('lists every source that is not completed, so none reads as clean while it is unchecked or still running', () => {
		expect(unsettledSources({ validation: 'completed', translation: 'completed' })).toEqual([])
		expect(unsettledSources({ validation: 'completed', 'product-kit': 'checking', catalog: 'failed', runtime: 'not_checked', translation: 'incomplete' }))
			.toEqual(['product-kit', 'catalog', 'runtime', 'translation'])
	})
})

describe('translation reminders (Rule 01a115cd-bdb2-7de2-abb9-54f592539471)', () => {
	const resources = new Map<string, Record<string, string>>([
		['en-US', { greeting: 'Hello', blank: '', 'a/b': ' \t', fine: 'x' }],
		['fr-FR', { greeting: '', other: '   ' }],
	])

	it('lists each empty and whitespace-only value by Locale, key and type, as a warning on its Locale', () => {
		const reminders = translationReminders(resources, 'en-US', 'completed')
		expect(reminders.map(item => [item.locale, item.translationKey, item.code])).toEqual([
			['en-US', 'a/b', 'i18n.whitespace_only_translation'],
			['en-US', 'blank', 'i18n.empty_translation'],
			['fr-FR', 'greeting', 'i18n.empty_translation'],
			['fr-FR', 'other', 'i18n.whitespace_only_translation'],
		])
		expect(reminders.every(item => item.source === 'translation' && item.severity === 'warning' && item.checkState === 'completed')).toBe(true)
		expect(reminders[0]!.resource).toEqual({ kind: 'locale', key: 'en-US', name: 'en-US' })
	})

	it('never turns a missing default Locale file into a reminder, and carries the source state it was given', () => {
		const reminders = translationReminders(new Map<string, Record<string, string>>([['fr-FR', { a: '' }]]), 'en-US', 'incomplete')
		expect(reminders.map(item => item.code)).toEqual(['i18n.empty_translation'])
		expect(reminders[0]!.checkState).toBe('incomplete')
		expect(translationReminders(new Map(), 'en-US')).toEqual([])
	})

	it('addresses the cell in the translation table by Locale and key', () => {
		const location = localeCellLocation('fr-FR', 'a/b')
		expect(location).toEqual({ path: '/workspace/locales', query: { locale: 'fr-FR', key: 'a/b' } })
		expect(parseLocaleCell(location.query)).toEqual({ locale: 'fr-FR', key: 'a/b' })
		expect(parseLocaleCell({ locale: 'fr-FR' })).toBeUndefined()
		expect(parseLocaleCell({})).toBeUndefined()
	})
})

describe('Catalog problems of used entries (Rules 01a115cd-be51-740b-8472-c08dc7138e3e, be84, beb7)', () => {
	const usage: ViewUsage[] = [
		{ resource: checkout, widgets: [{ id: 'root', type: 'RootShell' }, { id: 'pay', type: 'Button' }, { id: 'cancel', type: 'Button' }, { id: 'total', type: 'Text' }] },
		{ resource: account, widgets: [{ id: 'root', type: 'RootShell' }, { id: 'save', type: 'Button' }] },
	]
	const path = (type: string, rest = '') => `/adapters/0/manifest/catalog/widgets/${type}${rest}`

	it('reads the entry a diagnostic path names, if it names one', () => {
		expect(catalogEntryOf(path('Button', '/i18n/fields/label'))).toEqual({ adapterIndex: 0, widgetType: 'Button' })
		expect(catalogEntryOf('/adapters/2/manifest/catalog/widgets/A~1B')).toEqual({ adapterIndex: 2, widgetType: 'A/B' })
		expect(catalogEntryOf('/adapters/0/manifest/catalog/widgets')).toBeUndefined()
		expect(catalogEntryOf('/adapters/0/manifest/apiVersion')).toBeUndefined()
	})

	it('shows one problem once, expanding to each distinct View and then each distinct Widget', () => {
		const { findings, elsewhere } = catalogProblems([{ code: 'adapter.i18n_mapping_collision', path: path('Button', '/i18n/fields/label/text'), message: 'collides' }], usage)
		expect(elsewhere).toBe(0)
		const groups = groupFindings(findings)
		expect(groups).toHaveLength(1)
		expect(groups[0]!.resources.map(entry => [entry.resource.name, entry.findings.map(item => item.widgetId)])).toEqual([
			['Account', ['save']],
			['Checkout', ['cancel', 'pay']],
		])
		expect(findings.every(item => item.source === 'catalog' && item.severity === 'error' && item.widgetType === 'Button')).toBe(true)
	})

	it('keeps two problems of one code apart, one per entry', () => {
		const { findings } = catalogProblems([
			{ code: 'adapter.x', path: path('Button'), message: 'a' },
			{ code: 'adapter.x', path: path('Text'), message: 'b' },
		], usage)
		expect(groupFindings(findings).map(group => [group.first.widgetType, group.count])).toEqual([['Button', 3], ['Text', 1]])
	})

	it('leaves unused entries and problems of the Adapter set out of the findings', () => {
		const { findings, elsewhere } = catalogProblems([
			{ code: 'adapter.x', path: path('Unused'), message: 'unused entry' },
			{ code: 'adapter.duplicate_id', path: '/adapters/1/manifest/id', message: 'set level' },
		], usage)
		expect(findings).toEqual([])
		expect(elsewhere).toBe(2)
	})

	it('follows the current usage: an entry no View uses any more shows nothing', () => {
		const diagnostics = [{ code: 'adapter.x', path: path('Button'), message: 'a' }]
		expect(catalogProblems(diagnostics, usage).findings).toHaveLength(3)
		expect(catalogProblems(diagnostics, [{ resource: checkout, widgets: [{ id: 'root', type: 'RootShell' }] }]).findings).toEqual([])
	})

	it("never attributes a problem of one Adapter's entry to Widgets of the same type that another Adapter owns", () => {
		const diagnostics = [
			{ code: 'adapter.x', path: path('Button'), message: 'adapter 0' },
			{ code: 'adapter.x', path: '/adapters/1/manifest/catalog/widgets/Button', message: 'adapter 1' },
		]
		// Without the owner, the type is ambiguous: neither problem is attributed to a Widget.
		expect(catalogProblems(diagnostics, usage)).toMatchObject({ findings: [], elsewhere: 2 })
		// With the owner, only the owner's problem reaches the Widgets.
		const owned = catalogProblems(diagnostics, usage, 'completed', new Map([['Button', 1]]))
		expect(owned.elsewhere).toBe(1)
		expect(new Set(owned.findings.map(item => item.path))).toEqual(new Set(['/adapters/1/manifest/catalog/widgets/Button']))
	})
})

describe('severity derivation (issue #349, owner ruling 3 of Discussion #241)', () => {
	it('lists read diagnostics and Catalog problems as errors, reminders and Product Kit findings as warnings', () => {
		expect(SOURCE_SEVERITY).toEqual({ validation: 'error', catalog: 'error', translation: 'warning', 'product-kit': 'warning' })
		expect(severityOf('validation')).toBe('error')
	})

	it('gives every produced finding its source severity', () => {
		const reminders = translationReminders(new Map([['en-US', { 'a': '' } as never], ['fr-FR', { 'a': ' ' } as never]]), 'en-US')
		expect(reminders.length).toBeGreaterThan(0)
		for (const item of reminders) expect(item.severity).toBe(severityOf('translation'))
		const usage: ViewUsage[] = [{ resource: checkout, widgets: [{ id: 'w1', type: 'Button' }] }]
		const catalog = catalogProblems([{ code: 'adapter.x', path: '/adapters/0/manifest/catalog/widgets/Button/i18n', message: 'm' }], usage)
		expect(catalog.findings.map(item => item.severity)).toEqual(['error'])
	})
})

describe('Variant attribution of View diagnostics (issue #349)', () => {
	it('reads the Variant from the /variants/<name> path prefix', () => {
		expect(variantOfPath('/variants/error')).toBe('error')
		expect(variantOfPath('/variants/error/state/w1/value')).toBe('error')
	})

	it('undoes JSON Pointer escaping of ~1 and ~0', () => {
		expect(variantOfPath('/variants/a~1b/state')).toBe('a/b')
		expect(variantOfPath('/variants/a~0b')).toBe('a~b')
		expect(variantOfPath('/variants/~01/state')).toBe('~1')
	})

	it('attributes nothing for other paths', () => {
		expect(variantOfPath('/ir/slots/0')).toBeUndefined()
		expect(variantOfPath('/variants')).toBeUndefined()
		expect(variantOfPath('/variantsx/a')).toBeUndefined()
		expect(variantOfPath('/ir/variants/a')).toBeUndefined()
	})

	it('lets the Variant filter match an attributed finding', () => {
		const list = [finding({ code: 'view.bad', resource: checkout, variantName: 'error' }), finding({ code: 'view.bad', resource: checkout })]
		expect(filterFindings(list, { variant: 'error' })).toHaveLength(1)
	})
})
