import { describe, expect, it } from 'vitest'
import {
	catalogEntryOf,
	catalogProblems,
	categoryOf,
	combineStates,
	compareFindings,
	filterFindings,
	groupFindings,
	previewReportTruncated,
	previewSourceStates,
	previewTranslationFindings,
	unevaluatedCount,
	runtimeErrorFindings,
	sectionFindings,
	SOURCE_SEVERITY,
	severityOf,
	unsettledSources,
	translationReminders,
	variantOfPath,
	type Finding,
	type FindingResource,
	type PreviewFindingText,
	type ViewUsage,
} from '../app/utils/checks'
import type { LivePreviewChecks } from '../src/preview/checks-reports'
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
	it('lists read diagnostics, Catalog problems and Runtime errors as errors, reminders, Preview translation warnings and Product Kit findings as warnings', () => {
		expect(SOURCE_SEVERITY).toEqual({ validation: 'error', catalog: 'error', translation: 'warning', 'product-kit': 'warning', 'preview-translation': 'warning', runtime: 'error' })
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

describe('the findings of the live Preview (issue #347)', () => {
	const text: PreviewFindingText = {
		warning: warning => `warning:${warning.code}:${warning.key}`,
		runtimeReason: reason => `reason:${reason}`,
	}
	const input = { resource: checkout, widgetTypes: new Map([['b1', 'Button'], ['b2', 'Button']]), text }
	const missing = (key: string) => ({ code: 'missing-translation', key, requestedLocale: 'ja-JP', fallbackLocale: 'en-US' }) as const
	const report = (overrides: Partial<LivePreviewChecks> = {}): LivePreviewChecks => ({
		runtimeGenerationId: 'g', viewId: 'view-checkout', runtimeContextVersion: 1, sequence: 1, translationWarnings: [], runtimeErrors: [], ...overrides,
	})

	it('attributes a warning to its View, Variant, Widget and result Property, as a warning of its own source', () => {
		const [item] = previewTranslationFindings(report({ variantId: 'Quiet', translationWarnings: [{ widgetId: 'b1', resultProperty: 'labelResult', warning: missing('cta') }] }), input)
		expect(item).toMatchObject({
			code: 'i18n.missing_translation', source: 'preview-translation', severity: 'warning', checkState: 'completed',
			resource: checkout, variantName: 'Quiet', widgetId: 'b1', widgetType: 'Button', property: 'labelResult',
		})
		expect(severityOf('preview-translation')).toBe('warning')
	})

	// Rule 01a115cd-b91d-7230-9041-b56ff70b814b: the Catalog mapping names the Catalog field of the result Property.
	it('attributes a warning to the Catalog field of its result Property through the Catalog mapping', () => {
		const catalogFields = new Map([['Button', new Map([['labelResult', 'label']])]])
		const warnings = [{ widgetId: 'b1', resultProperty: 'labelResult', warning: missing('cta') }, { widgetId: 'b1', resultProperty: 'titleResult', warning: missing('cta') }]
		const [named, unmapped] = previewTranslationFindings(report({ translationWarnings: warnings }), { ...input, catalogFields })
		expect(named).toMatchObject({ widgetType: 'Button', property: 'labelResult', catalogField: 'label' })
		// A Property the Catalog does not map is not guessed.
		expect(unmapped!.catalogField).toBeUndefined()
		expect(previewTranslationFindings(report({ translationWarnings: warnings }), input)[0]!.catalogField).toBeUndefined()
	})

	it('groups by code, then key and missing parameter, each group listing its Widget and Property occurrences in order', () => {
		const list = previewTranslationFindings(report({ translationWarnings: [
			{ widgetId: 'b2', resultProperty: 'labelResult', warning: missing('cta') },
			{ widgetId: 'b1', resultProperty: 'titleResult', warning: missing('cta') },
			{ widgetId: 'b1', resultProperty: 'labelResult', warning: missing('cta') },
			{ widgetId: 'b1', resultProperty: 'labelResult', warning: missing('other') },
			{ widgetId: 'b1', resultProperty: 'labelResult', warning: { code: 'missing-parameter', key: 'hi', requestedLocale: 'ja-JP', parameter: 'name' } },
			{ widgetId: 'b2', resultProperty: 'labelResult', warning: { code: 'missing-parameter', key: 'hi', requestedLocale: 'ja-JP', parameter: 'count' } },
		] }), input)
		const groups = groupFindings(list)
		expect(groups.map(group => [group.code, group.count]).sort()).toEqual([['i18n.missing_parameter', 1], ['i18n.missing_parameter', 1], ['i18n.missing_translation', 1], ['i18n.missing_translation', 3]])
		const cta = groups.find(group => group.code === 'i18n.missing_translation' && group.count === 3)!
		expect(cta.resources[0]!.findings.map(item => [item.widgetId, item.property])).toEqual([['b1', 'labelResult'], ['b1', 'titleResult'], ['b2', 'labelResult']])
		// A missing parameter is one problem per parameter.
		expect(groups.filter(group => group.code === 'i18n.missing_parameter')).toHaveLength(2)
		// The same problem in another Widget or Property stays a separate occurrence of one group, never merged away.
		expect(list.filter(item => item.problem === JSON.stringify(['cta', null]))).toHaveLength(3)
	})

	it('lists a load error without a Widget and a failed Property with one, as errors that group by reason', () => {
		const list = runtimeErrorFindings(report({ runtimeErrors: [
			{ reason: 'runtime.adapter_invalid', detail: 'adapter.bundle_invalid /adapters: No mount.' },
			{ reason: 'runtime.property_failed', widgetId: 'b1', detail: 'label: failed' },
		] }), input)
		expect(list.map(item => [item.source, item.severity, item.code, item.widgetId])).toEqual([
			['runtime', 'error', 'runtime.adapter_invalid', undefined], ['runtime', 'error', 'runtime.property_failed', 'b1'],
		])
		expect(list[1]).toMatchObject({ widgetType: 'Button', message: 'label: failed' })
		expect(groupFindings(list).map(group => group.title)).toEqual(['reason:runtime.adapter_invalid', 'reason:runtime.property_failed'])
	})

	it('lists nothing for an empty report, and the Variant filter reaches its findings', () => {
		expect(previewTranslationFindings(report(), input)).toEqual([])
		expect(runtimeErrorFindings(report(), input)).toEqual([])
		const list = previewTranslationFindings(report({ variantId: 'Quiet', translationWarnings: [{ widgetId: 'b1', resultProperty: 'labelResult', warning: missing('cta') }] }), input)
		expect(filterFindings(list, { variant: 'Quiet' })).toHaveLength(1)
		expect(filterFindings(list, { source: 'runtime' })).toHaveLength(0)
	})
})

describe('the check states of the Preview sources (issue #95)', () => {
	const entry = { widgetId: 'b1', resultProperty: 'labelResult', catalogField: 'label', reason: 'The Property was not evaluated.' }
	const held = (overrides: Partial<LivePreviewChecks> = {}): LivePreviewChecks => ({
		runtimeGenerationId: 'g', viewId: 'view-checkout', runtimeContextVersion: 1, sequence: 1, translationWarnings: [], runtimeErrors: [], ...overrides,
	})

	it('follows the Preview until it has reported: not checked without one, checking until its report', () => {
		expect(previewSourceStates({ state: 'not_checked' })).toEqual({ translation: 'not_checked', runtime: 'not_checked' })
		expect(previewSourceStates({ state: 'checking' })).toEqual({ translation: 'checking', runtime: 'checking' })
	})

	it('is completed when the report says every declared Property was evaluated, and incomplete when it names one it did not', () => {
		expect(previewSourceStates({ state: 'completed', report: held({ coverage: { complete: true, unevaluated: [] } }) })).toEqual({ translation: 'completed', runtime: 'completed' })
		expect(previewSourceStates({ state: 'completed', report: held({ coverage: { complete: false, unevaluated: [entry] } }) })).toEqual({ translation: 'incomplete', runtime: 'completed' })
	})

	it('is incomplete, never completed, for a report without coverage: a Preview with no Runtime to inspect has verified nothing', () => {
		expect(previewSourceStates({ state: 'completed', report: held() })).toEqual({ translation: 'incomplete', runtime: 'incomplete' })
	})

	it('is incomplete for the Runtime errors source when no Runtime was created, never completed with zero findings (issue #370)', () => {
		// A theme-incompatible Preview reports no Runtime error and no coverage: nothing ran.
		expect(previewSourceStates({ state: 'completed', report: held({ runtimeErrors: [], translationWarnings: [] }) }).runtime).toBe('incomplete')
		// A report with coverage came from a Runtime that was inspected, and lists every error it knows.
		expect(previewSourceStates({ state: 'completed', report: held({ coverage: { complete: true, unevaluated: [] } }) }).runtime).toBe('completed')
	})

	it('is failed for the translation source when the Preview could not evaluate, whatever the coverage says', () => {
		for (const reason of ['runtime.view_load_failed', 'runtime.adapter_invalid', 'runtime.adapter_unavailable', 'runtime.preview_blocked'])
			expect(previewSourceStates({ state: 'completed', report: held({ runtimeErrors: [{ reason }] }) })).toEqual({ translation: 'failed', runtime: 'failed' })
		// A Property that failed is an error to list, and its Property is counted as unevaluated, not a failed Preview.
		expect(previewSourceStates({ state: 'completed', report: held({ runtimeErrors: [{ reason: 'runtime.property_failed', widgetId: 'b1' }], coverage: { complete: false, unevaluated: [entry] } }) }))
			.toEqual({ translation: 'incomplete', runtime: 'completed' })
	})

	it('makes both sources incomplete when the report says it left entries out, whichever list was cut', () => {
		const complete = { complete: true, unevaluated: [] }
		for (const detail of ['3 runtime errors were left out.', '5 translation warnings were left out.', undefined])
			expect(previewSourceStates({ state: 'completed', report: held({ coverage: complete, runtimeErrors: [{ reason: 'runtime.report_truncated', ...(detail ? { detail } : {}) }] }) })).toEqual({ translation: 'incomplete', runtime: 'incomplete' })
	})

	it('reads the last report of a Preview that is closed as incomplete, never completed', () => {
		expect(previewSourceStates({ state: 'stale', report: held({ coverage: { complete: true, unevaluated: [] } }) })).toEqual({ translation: 'incomplete', runtime: 'incomplete' })
	})

	it('says whether a report was cut, so a count taken from it is a lower bound', () => {
		expect(previewReportTruncated(undefined)).toBe(false)
		expect(previewReportTruncated(held())).toBe(false)
		expect(previewReportTruncated(held({ runtimeErrors: [{ reason: 'runtime.report_truncated' }] }))).toBe(true)
	})

	it('counts the unevaluated Properties a report names', () => {
		expect(unevaluatedCount(undefined)).toBe(0)
		expect(unevaluatedCount(held())).toBe(0)
		expect(unevaluatedCount(held({ coverage: { complete: false, unevaluated: [entry, { ...entry, widgetId: 'b2' }] } }))).toBe(2)
	})
})
