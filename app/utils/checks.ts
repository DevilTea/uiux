import type { I18nResource } from '../../src/domain/i18n/schema'
import { inspectTranslationResources } from '../../src/i18n/runtime'

/**
 * Pure helpers of Overview › Checks (Feature "Checks", Rule 01a115cd-bb33-70a8-a09f-999e06ce38ed
 * and its neighbors, issue #95). A finding is a Workbench view model: it is built in the browser
 * from reads the Workbench already makes, so nothing here is a wire shape. The page keeps each
 * finding's origin (`source`), scope (`resource`, Variant, Widget), check state and original
 * severity, and never merges sources into one warning type.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * Where a finding comes from. `validation` is the structural and schema findings each canonical
 * resource read returns; `translation` the empty and whitespace-only reminders of the Locale
 * files; `catalog` the Catalog problems of entries a View uses; `product-kit` the Product Kit
 * findings. The Preview's translation warnings and Runtime errors are sources of their own when
 * they are gathered (issue #95, follow-up).
 */
export const FINDING_SOURCES = ['validation', 'translation', 'catalog', 'product-kit'] as const
export type FindingSource = typeof FINDING_SOURCES[number]

/** A finding's own severity: an `error` is a problem that breaks or blocks, a `warning` a reminder or non-blocking finding. */
export const FINDING_SEVERITIES = ['error', 'warning'] as const
export type FindingSeverity = typeof FINDING_SEVERITIES[number]

/**
 * The Workbench's severity derivation, no wire change (owner ruling 3 of Discussion #241,
 * issue #349): resource-read diagnostics (structural and schema, including the missing default
 * Locale) and Catalog problems are errors; translation reminders and Product Kit findings are
 * warnings. The single place that fixes these values: every finding takes its severity from here.
 */
export const SOURCE_SEVERITY: Readonly<Record<FindingSource, FindingSeverity>> = {
	validation: 'error',
	catalog: 'error',
	translation: 'warning',
	'product-kit': 'warning',
}

/** The severity a finding of this source lists with. */
export function severityOf(source: FindingSource): FindingSeverity {
	return SOURCE_SEVERITY[source]
}

const VARIANT_PATH = /^\/variants\/([^/]+)(?:\/|$)/

/**
 * The Variant a View diagnostic concerns, from its `path` prefix `/variants/<name>` (the JSON
 * Pointer the View schema writes, with `~1` and `~0` escapes undone); none for any other path.
 */
export function variantOfPath(path: string): string | undefined {
	const match = VARIANT_PATH.exec(path)
	return match ? unescapePointer(match[1]!) : undefined
}

/**
 * The check state of a source (Rule 01a115cd-bb96-7131-99d9-a3882829590c): not yet checked,
 * checking, completed (with or without findings), and failed or incomplete. An unrun source is
 * never zero findings.
 */
export const CHECK_STATES = ['not_checked', 'checking', 'completed', 'incomplete', 'failed'] as const
export type CheckState = typeof CHECK_STATES[number]

export type FindingResource = Readonly<{ kind: 'workspace' | 'view' | 'flow' | 'locale' | 'asset' | 'product-kit'; key: string; name: string }>

export type Finding = Readonly<{
	code: string
	message: string
	path: string
	resource: FindingResource
	source: FindingSource
	severity: FindingSeverity
	/** The state of the finding's source when it was listed; `incomplete` marks a source that did not finish. */
	checkState: CheckState
	/** The Widget a View finding resolves to; never guessed. */
	widgetId?: string
	/** The resolved Widget's type, for the blueprint label. */
	widgetType?: string
	/** The Variant a Product Kit capture finding concerns; absent for the base state. */
	variantName?: string
	/** The registry component a Product Kit finding concerns. */
	component?: string
	/** A translation reminder's Locale and key: they open its cell in the translation table. */
	locale?: string
	translationKey?: string
	/**
	 * Splits one code into separate problems: findings of one code group together only while they
	 * share this identity (a Catalog problem is one entry's, not every entry's with that code).
	 */
	problem?: string
	/**
	 * The group's plain sentence, in place of the first message under its code; and, for a finding
	 * that has no code (the props and emits check, which Discussion #139 gives no code, with `code`
	 * empty), the key it groups by.
	 */
	group?: Readonly<{ key: string; title: string }>
}>

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { error: 0, warning: 1 }
const KIND_RANK: Readonly<Record<FindingResource['kind'], number>> = { workspace: 0, view: 1, flow: 2, locale: 3, asset: 4, 'product-kit': 5 }

/** The category of a diagnostic code: its first dotted segment (`schema`, `i18n`, `view`…). */
export function findingCategory(code: string): string {
	const index = code.indexOf('.')
	return index > 0 ? code.slice(0, index) : code
}

/** A finding's category: its code's first segment, or `kit` for a Product Kit finding without a code. */
export function categoryOf(finding: Pick<Finding, 'code'>): string {
	return finding.code ? findingCategory(finding.code) : 'kit'
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The default order (Rule 01a115cd-bd48-7c10-82fc-827d5e8e5ba8): severity, then code or category,
 * then a stable location: the resource (kind, name, key), Variant, Widget, Locale and key, path.
 */
export function compareFindings(a: Finding, b: Finding): number {
	return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
		|| compareText(a.code || a.group?.key || '', b.code || b.group?.key || '')
		|| compareText(a.problem ?? '', b.problem ?? '')
		|| KIND_RANK[a.resource.kind] - KIND_RANK[b.resource.kind]
		|| compareText(a.resource.name, b.resource.name)
		|| compareText(a.resource.key, b.resource.key)
		|| compareText(a.variantName ?? '', b.variantName ?? '')
		|| compareText(a.widgetId ?? '', b.widgetId ?? '')
		|| compareText(a.translationKey ?? '', b.translationKey ?? '')
		|| compareText(a.path, b.path)
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export type FindingFilters = Readonly<{
	source?: FindingSource
	category?: string
	severity?: FindingSeverity
	/** A View's key. */
	view?: string
	/** A Variant's name. */
	variant?: string
}>

/** Findings that match every filter that is set (Rule 01a115cd-bd13-778b-8a0a-b4d43cd98aa7). */
export function filterFindings(findings: readonly Finding[], filters: FindingFilters): Finding[] {
	return findings.filter(finding =>
		(!filters.source || finding.source === filters.source)
		&& (!filters.category || categoryOf(finding) === filters.category)
		&& (!filters.severity || finding.severity === filters.severity)
		&& (!filters.view || (finding.resource.kind === 'view' && finding.resource.key === filters.view))
		&& (!filters.variant || finding.variantName === filters.variant),
	)
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

export type FindingGroup = Readonly<{
	/** Empty for a group of findings without a code; `title` names it then. */
	code: string
	title?: string
	/** The group's key: the code, or the codeless group's own key. */
	key: string
	category: string
	/** The group's most severe finding's severity. */
	severity: FindingSeverity
	sources: readonly FindingSource[]
	/** The first message under this code, as the group's plain sentence. */
	message: string
	count: number
	/** The group's first finding, which names what a one-problem group is about (a Catalog entry's Widget type). */
	first: Finding
	resources: readonly Readonly<{ resource: FindingResource; findings: readonly Finding[] }>[]
}>

/**
 * Groups findings by problem (code, or the finding's own problem identity), then by resource, in
 * the default order: severity, then code, then location.
 */
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
	const groups = new Map<string, { key: string; code: string; title?: string; message: string; findings: Finding[] }>()
	for (const finding of [...findings].sort(compareFindings)) {
		const key = finding.code ? `${finding.code}${finding.problem ? `\u0000${finding.problem}` : ''}` : `group:${finding.group?.key ?? ''}`
		const group = groups.get(key) ?? { key, code: finding.code, ...(finding.group ? { title: finding.group.title } : {}), message: finding.message, findings: [] }
		group.findings.push(finding)
		groups.set(key, group)
	}
	return [...groups.values()].map((group) => {
		const resources = new Map<string, { resource: FindingResource; findings: Finding[] }>()
		for (const finding of group.findings) {
			const key = `${finding.resource.kind}:${finding.resource.key}`
			const entry = resources.get(key) ?? { resource: finding.resource, findings: [] }
			entry.findings.push(finding)
			resources.set(key, entry)
		}
		const first = group.findings[0]!
		return {
			key: group.key,
			code: group.code,
			...(group.title ? { title: group.title } : {}),
			category: categoryOf(first),
			severity: first.severity,
			sources: FINDING_SOURCES.filter(source => group.findings.some(finding => finding.source === source)),
			message: group.message,
			count: group.findings.length,
			first,
			resources: [...resources.values()],
		}
	})
}

export type GroupBy = 'problem' | 'source' | 'severity' | 'view'
export const GROUP_BYS: readonly GroupBy[] = ['problem', 'source', 'severity', 'view']

export type FindingSection = Readonly<{ key: string; value: string; findings: readonly Finding[] }>

/** Splits findings into the sections of one grouping dimension, in a stable order; `problem` is one section. */
export function sectionFindings(findings: readonly Finding[], by: GroupBy): FindingSection[] {
	if (by === 'problem') return [{ key: 'problem', value: '', findings }]
	const keyOf = (finding: Finding): string => by === 'source'
		? finding.source
		: by === 'severity'
			? finding.severity
			: finding.resource.kind === 'view' ? finding.resource.key : ''
	const sections = new Map<string, Finding[]>()
	for (const finding of findings) {
		const key = keyOf(finding)
		const list = sections.get(key)
		if (list) list.push(finding)
		else sections.set(key, [finding])
	}
	const rank = (value: string): number => by === 'source' ? FINDING_SOURCES.indexOf(value as FindingSource) : by === 'severity' ? SEVERITY_RANK[value as FindingSeverity] : 0
	return [...sections.entries()]
		.sort(([a], [b]) => by === 'view'
			? (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || compareText(nameOf(sections.get(a)![0]!), nameOf(sections.get(b)![0]!)) || compareText(a, b)
			: rank(a) - rank(b))
		.map(([value, list]) => ({ key: `${by}:${value}`, value, findings: list }))
}

function nameOf(finding: Finding): string {
	return finding.resource.name
}

// ---------------------------------------------------------------------------------------------
// Check states
// ---------------------------------------------------------------------------------------------

/**
 * One state out of the states of the parts a source is made of: checking while any part is,
 * completed only when every part is, failed when none finished, and incomplete otherwise. No
 * parts is not checked, never completed.
 */
export function combineStates(states: readonly CheckState[]): CheckState {
	if (!states.length || states.every(state => state === 'not_checked')) return 'not_checked'
	if (states.includes('checking')) return 'checking'
	if (states.every(state => state === 'completed')) return 'completed'
	if (states.every(state => state === 'failed')) return 'failed'
	return 'incomplete'
}

/** The sources whose state is not completed (failed, incomplete, checking or not checked), in the order given. */
export function unsettledSources(states: Readonly<Record<string, CheckState>>): string[] {
	return Object.entries(states).filter(([, state]) => state !== 'completed').map(([id]) => id)
}

// ---------------------------------------------------------------------------------------------
// Translation reminders (Rule 01a115cd-bdb2-7de2-abb9-54f592539471)
// ---------------------------------------------------------------------------------------------

export const TRANSLATION_REMINDER_CODES = ['i18n.empty_translation', 'i18n.whitespace_only_translation'] as const

/**
 * The empty and whitespace-only values of the read Locale files, by Locale, key and type: what
 * `inspectTranslationResources` reports, one finding each, on the Locale. A Locale is a resource
 * of its own, so a reminder never needs the default Locale to exist.
 */
export function translationReminders(
	resources: ReadonlyMap<string, I18nResource>,
	defaultLocale: string,
	checkState: CheckState = 'completed',
): Finding[] {
	const findings: Finding[] = []
	for (const item of inspectTranslationResources(defaultLocale, resources)) {
		if (!(TRANSLATION_REMINDER_CODES as readonly string[]).includes(item.diagnostic.code)) continue
		const [, , escapedLocale = '', escapedKey = ''] = item.diagnostic.path.split('/')
		const locale = unescapePointer(escapedLocale)
		const key = unescapePointer(escapedKey)
		findings.push({
			code: item.diagnostic.code,
			message: item.diagnostic.message,
			path: item.diagnostic.path,
			resource: { kind: 'locale', key: locale, name: locale },
			source: 'translation',
			severity: severityOf('translation'),
			checkState,
			locale,
			translationKey: key,
		})
	}
	return findings
}

function unescapePointer(value: string): string {
	return value.replaceAll('~1', '/').replaceAll('~0', '~')
}

// ---------------------------------------------------------------------------------------------
// Catalog problems (Rules 01a115cd-be51-740b-8472-c08dc7138e3e, be84, beb7)
// ---------------------------------------------------------------------------------------------

const CATALOG_ENTRY_PATH = /^\/adapters\/(\d+)\/manifest\/catalog\/widgets\/([^/]+)(?:\/|$)/

/** The Adapter and Widget type of the Catalog entry a diagnostic's path names; none for a problem of the Adapter set. */
export function catalogEntryOf(path: string): Readonly<{ adapterIndex: number; widgetType: string }> | undefined {
	const match = CATALOG_ENTRY_PATH.exec(path)
	return match ? { adapterIndex: Number(match[1]), widgetType: unescapePointer(match[2]!) } : undefined
}

export type ViewUsage = Readonly<{
	resource: FindingResource
	widgets: readonly Readonly<{ id: string; type: string }>[]
}>

export type CatalogProblems = Readonly<{
	findings: readonly Finding[]
	/** Problems of the Adapter set or of entries no View uses: they stay in Catalog management. */
	elsewhere: number
}>

/**
 * The Catalog problems of entries that at least one View uses. One problem (its code and entry
 * path) is one group; each of its findings is one Widget of one View that uses the entry, so the
 * group expands to each distinct View and then each distinct Widget. The Views and Widgets come
 * from the Views as they are now, without revalidating the Catalog.
 */
export function catalogProblems(
	diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[],
	usage: readonly ViewUsage[],
	checkState: CheckState = 'completed',
	/** Which Adapter owns each Widget type, when known: a problem of another Adapter's entry never reaches its Widgets. */
	owners?: ReadonlyMap<string, number>,
): CatalogProblems {
	const findings: Finding[] = []
	let elsewhere = 0
	// A type whose entries have problems in more than one Adapter cannot be attributed to a Widget without
	// the owner: the Widget resolves to one of them, and the diagnostic does not say which.
	const adaptersOfType = new Map<string, Set<number>>()
	for (const diagnostic of diagnostics) {
		const entry = catalogEntryOf(diagnostic.path)
		if (entry) adaptersOfType.set(entry.widgetType, (adaptersOfType.get(entry.widgetType) ?? new Set()).add(entry.adapterIndex))
	}
	for (const diagnostic of diagnostics) {
		const entry = catalogEntryOf(diagnostic.path)
		const owner = entry ? owners?.get(entry.widgetType) : undefined
		const attributable = !!entry && (owner !== undefined ? owner === entry.adapterIndex : (adaptersOfType.get(entry.widgetType)?.size ?? 0) <= 1)
		const used = entry && attributable ? usage.filter(view => view.widgets.some(widget => widget.type === entry.widgetType)) : []
		if (!entry || !used.length) { elsewhere += 1; continue }
		for (const view of used) {
			for (const widget of view.widgets.filter(item => item.type === entry.widgetType)) {
				findings.push({
					code: diagnostic.code,
					message: diagnostic.message,
					path: diagnostic.path,
					resource: view.resource,
					source: 'catalog',
					severity: severityOf('catalog'),
					checkState,
					widgetId: widget.id,
					widgetType: widget.type,
					problem: diagnostic.path,
				})
			}
		}
	}
	return { findings, elsewhere }
}
