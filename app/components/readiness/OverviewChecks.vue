<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TreeItem } from '@nuxt/ui'
import { resolveDiagnosticWidgetTarget } from '../../../src/preview/checks-navigation'
import { deriveWidgetTree, flattenWidgetTree } from '../../../src/preview/widget-tree'
import { useAccess } from '../../composables/useAccess'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import type { Diagnostic } from '../../composables/workbench-types'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import {
	catalogProblems,
	categoryOf,
	combineStates,
	filterFindings,
	FINDING_SEVERITIES,
	FINDING_SOURCES,
	GROUP_BYS,
	groupFindings,
	sectionFindings,
	translationReminders,
	type CheckState,
	type Finding,
	type FindingFilters,
	type FindingResource,
	type FindingSeverity,
	type FindingSource,
	type GroupBy,
	type ViewUsage,
} from '../../utils/checks'
import { flowPath, localeCellLocation, viewLocation } from '../../utils/workbench-routes'
import type { I18nResource } from '../../../src/domain/i18n/schema'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'
import { diagnosticText } from '../../utils/diagnostic-copy'
import { missingDefaultLocaleDiagnostic } from '../../../src/i18n/runtime'

/**
 * Overview › Checks (Part 5): one normalized findings surface for the Workspace, grouped
 * problem → resource → Widget. It runs only when asked ("Run Checks") and never lists Review
 * queues; those live in the Reviews inbox.
 *
 * Run Checks also runs the Product Kit Checks on the server (`POST /api/product-kit/checks`, issue
 * #141 Part 14 decision 7): registry problems, repeat capture, live versus fresh, and props and
 * emits. They take longer than the resource reads, so they report their own state per check, and
 * their findings join the list when they finish. They are non-blocking (Rule
 * 01a11bb1-a88c-7d78-8633-1c3b55588910): nothing here gates Preview, capture or Handoff. They need
 * `evidence.capture`, and their props and emits check `product-kit.source.read` (Clause
 * 01a11485-fa44-7b6a-99f8-de4e1e8edcfc): without the first, Run Checks never asks for them.
 *
 * Every finding keeps its origin (`source`), scope, check state and original severity (issue #95,
 * Rules 01a115cd-bb64-75c2-a7df-2c8dd338453d and 01a115cd-bb96-7131-99d9-a3882829590c). Each source
 * has a state of its own, so a source that was not run, is running or did not finish is never read
 * as zero findings. The findings are built here from reads the Workbench already makes (the
 * resource reads, `GET /api/preview/adapters` and the Product Kit checks); they are not a wire shape.
 */
const { t } = useI18n()
const access = useAccess()
const uiux = useUiuxClient()
const fmt = useWorkbenchFormat()
const feedback = useWorkbenchFeedback()
const { views, flows, workspace, workspaceFindingCount, missingDefaultLocale } = useWorkbench()

type ResourceRead = Readonly<{ key: string; revision: string; diagnostics?: readonly Diagnostic[]; resource?: Record<string, unknown> }>

const running = ref(false)
const lastRun = ref<Date>()
const resourceFindings = shallowRef<readonly Finding[]>([])
const translationFindings = shallowRef<readonly Finding[]>([])
const catalogFindings = shallowRef<readonly Finding[]>([])
const failures = shallowRef<readonly Readonly<{ name: string; error: FetchErrorDetails }>[]>([])

/** The sources this page reads itself; the Product Kit's state comes from its own checks. */
type ReadSource = 'validation' | 'translation' | 'catalog'
const readStates = ref<Record<ReadSource, CheckState>>({ validation: 'not_checked', translation: 'not_checked', catalog: 'not_checked' })
/** Catalog problems of the Adapter set or of entries no View uses: they stay on the Product Kit page. */
const catalogElsewhere = ref(0)
const catalogError = shallowRef<FetchErrorDetails>()

// Filters and grouping: Workbench presentation (Rule 01a115cd-bd13-778b-8a0a-b4d43cd98aa7).
const ALL = 'all'
const filterSource = ref<string>(ALL)
const filterCategory = ref<string>(ALL)
const filterSeverity = ref<string>(ALL)
const filterView = ref<string>(ALL)
const filterVariant = ref<string>(ALL)
const groupBy = ref<GroupBy>('problem')

async function read(kind: string, key: string): Promise<ResourceRead | undefined> {
	return uiux.readResource<ResourceRead>(kind, key)
}

/** Reads each resource once, in small batches, and keeps every finding it reports. */
async function runChecks(): Promise<void> {
	if (running.value) return
	running.value = true
	readStates.value = { validation: 'checking', translation: 'checking', catalog: 'checking' }
	catalogError.value = undefined
	if (!kitRunning.value && canRunKitChecks.value) void runKitChecks()
	const collected: Finding[] = []
	const localeResources = new Map<string, I18nResource>()
	const localeStates: CheckState[] = []
	const usage: ViewUsage[] = []
	let usageComplete = true
	const failed: { name: string; error: FetchErrorDetails }[] = []
	// A resource read's diagnostics are structural and schema findings: each one stops that resource from
	// being used as authored, so they are errors. The missing default Locale is the same kind of error.
	const push = (resource: FindingResource, diagnostics: readonly Diagnostic[] | undefined, widgetFor?: (diagnostic: Diagnostic) => string | undefined, types?: ReadonlyMap<string, string>) => {
		for (const diagnostic of diagnostics ?? []) {
			const widgetId = widgetFor?.(diagnostic)
			const widgetType = widgetId ? types?.get(widgetId) : undefined
			collected.push({ code: diagnostic.code, message: diagnostic.message, path: diagnostic.path, resource, source: 'validation', severity: 'error', checkState: 'completed', ...(widgetId ? { widgetId } : {}), ...(widgetType ? { widgetType } : {}) })
		}
	}
	type Job = Readonly<{ kind: FindingResource['kind']; key: string; name: string }>
	let assetsListed = true
	const [localePage, assets] = await Promise.all([
		uiux.listResources<{ key: string }>(['locale'], { limit: 100 }).catch(() => undefined),
		uiux.listResources<{ key: string; summary?: { name?: string } }>(['asset'], { limit: 100 }).then(page => page.items).catch(() => { assetsListed = false; return [] }),
	])
	const locales = localePage?.items ?? []
	const jobs: Job[] = [
		{ kind: 'workspace', key: 'workspace', name: t('checks.resource.workspace') },
		...views.value.map(view => ({ kind: 'view' as const, key: view.key, name: view.summary.name || t('common.unnamed') })),
		...flows.value.map(flow => ({ kind: 'flow' as const, key: flow.key, name: flow.summary.name || t('common.unnamed') })),
		...locales.map(locale => ({ kind: 'locale' as const, key: locale.key, name: locale.key })),
		...assets.map(asset => ({ kind: 'asset' as const, key: asset.key, name: asset.summary?.name || asset.key })),
	]
	for (let index = 0; index < jobs.length; index += 4) {
		await Promise.all(jobs.slice(index, index + 4).map(async (job) => {
			try {
				const result = await read(job.kind, job.key)
				if (!result) return
				const resource: FindingResource = { kind: job.kind, key: job.key, name: job.name }
				// Rule 01a115cd-b2ad-7989-8faa-07d48bc8ee30: a default Locale without its Locale file is a
				// Workspace error, listed on that Locale. Only a Locale list that was read can show it missing.
				const defaultLocale = job.kind === 'workspace' ? (result.resource?.i18n as { defaultLocale?: unknown } | undefined)?.defaultLocale : undefined
				if (localePage && typeof defaultLocale === 'string' && !locales.some(locale => locale.key === defaultLocale))
					push({ kind: 'locale', key: defaultLocale, name: defaultLocale }, [missingDefaultLocaleDiagnostic(defaultLocale)])
				if (job.kind === 'locale') {
					// A Locale file with schema diagnostics is not a translation source: its reminders are not read.
					if (result.diagnostics?.length || !result.resource) localeStates.push('incomplete')
					else { localeResources.set(job.key, result.resource as I18nResource); localeStates.push('completed') }
				}
				if (job.kind !== 'view') {
					push(resource, result.diagnostics)
					return
				}
				const ir = result.resource?.ir
				const tree = ir ? deriveWidgetTree(ir) : undefined
				const flat = tree?.status === 'valid' ? flattenWidgetTree(tree.root) : []
				const types = new Map(flat.map(widget => [widget.id, widget.type] as const))
				// A View whose Widgets cannot be derived cannot be said to use or not use a Catalog entry.
				if (tree?.status === 'valid') usage.push({ resource, widgets: flat.map(widget => ({ id: widget.id, type: widget.type })) })
				else usageComplete = false
				push(resource, result.diagnostics, diagnostic => resolveDiagnosticWidgetTarget(diagnostic, ir, new Set(types.keys())), types)
			}
			catch (cause) {
				failed.push({ name: job.name, error: describeFetchError(cause, t('checks.readFailed')) })
				if (job.kind === 'locale') localeStates.push('failed')
				if (job.kind === 'view') usageComplete = false
			}
		}))
	}
	const readState: CheckState = failed.length === 0 && localePage && assetsListed ? 'completed' : failed.length === jobs.length ? 'failed' : 'incomplete'
	const validationFindings = collected.map(finding => ({ ...finding, checkState: readState }))

	// Translation reminders: the empty and whitespace-only values of the Locale files that were read.
	const translationState: CheckState = !localePage ? 'failed' : localeStates.length ? combineStates(localeStates) : 'completed'
	const reminders = translationReminders(localeResources, workspace.value?.resource?.i18n?.defaultLocale ?? '', translationState)

	// Catalog problems of entries a View uses: the Adapter set's own report, attributed through the Views read above.
	let catalogState: CheckState = 'failed'
	let catalog: readonly Finding[] = []
	let elsewhere = 0
	try {
		const response = await api<{ state: 'valid' | 'invalid'; diagnostics: readonly Diagnostic[]; warnings?: readonly Diagnostic[] }>('/api/preview/adapters')
		// A valid set whose server-side check could not run is not a clean result: the Preview checks it when it loads.
		catalogState = usageComplete && !response.warnings?.length ? 'completed' : 'incomplete'
		const problems = catalogProblems(response.diagnostics ?? [], usage, catalogState)
		catalog = problems.findings
		elsewhere = problems.elsewhere
	}
	catch (cause) {
		catalogError.value = describeFetchError(cause, t('checks.catalog.failed'))
	}

	resourceFindings.value = validationFindings
	translationFindings.value = reminders
	catalogFindings.value = catalog
	catalogElsewhere.value = elsewhere
	readStates.value = { validation: readState, translation: translationState, catalog: catalogState }
	failures.value = failed
	lastRun.value = new Date()
	running.value = false
}

// ---- Product Kit Checks -----------------------------------------------------------------------

type KitCheck = 'registry' | 'repeat_capture' | 'live_versus_fresh' | 'props_emits'
const KIT_CHECKS: readonly KitCheck[] = ['registry', 'repeat_capture', 'live_versus_fresh', 'props_emits']
type KitCheckSummary = Readonly<{ state: 'completed' | 'incomplete' | 'failed'; checked: number; unchecked: number; diagnostics: readonly Diagnostic[] }>
type KitFinding = Readonly<{ check: KitCheck; code?: string; path: string; message: string; component?: string; viewId?: string; variantName?: string; widgetId?: string; widgetType?: string }>
type KitChecksResponse =
	| Readonly<{ status: 'completed' | 'incomplete'; checks: Readonly<Record<KitCheck, KitCheckSummary>>; findings: readonly KitFinding[] }>
	| Readonly<{ status: 'not_applicable'; diagnostics: readonly Diagnostic[] }>

const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>
const kitRunning = ref(false)
const canRunKitChecks = computed(() => access.can('evidence.capture'))
const canReadKitSource = computed(() => access.can('product-kit.source.read'))
const kitResult = shallowRef<KitChecksResponse>()
const kitError = shallowRef<FetchErrorDetails>()

async function runKitChecks(): Promise<void> {
	kitRunning.value = true
	kitError.value = undefined
	try {
		kitResult.value = await api<KitChecksResponse>('/api/product-kit/checks', { method: 'POST' })
	}
	catch (cause) {
		kitResult.value = undefined
		kitError.value = describeFetchError(cause, t('checks.kit.failed'))
	}
	finally {
		kitRunning.value = false
	}
}

/** A Product Kit finding as a Checks finding: on its View when it has one, else on the Product Kit. */
function kitFinding(finding: KitFinding): Finding {
	const view = finding.viewId ? views.value.find(entry => entry.key === finding.viewId) : undefined
	const resource: FindingResource = finding.viewId
		? { kind: 'view', key: finding.viewId, name: view?.summary.name || finding.viewId }
		: { kind: 'product-kit', key: finding.component ?? 'product-kit', name: finding.component ?? t('checks.kit.resource') }
	const summary = kitResult.value && 'checks' in kitResult.value ? kitResult.value.checks[finding.check] : undefined
	return {
		code: finding.code ?? '',
		message: finding.message,
		path: finding.path,
		resource,
		// Product Kit findings are non-blocking (Rule 01a11bb1-a88c-7d78-8633-1c3b55588910).
		source: 'product-kit',
		severity: 'warning',
		checkState: summary?.state ?? 'completed',
		...(finding.widgetId ? { widgetId: finding.widgetId } : {}),
		...(finding.widgetType ? { widgetType: finding.widgetType } : {}),
		...(finding.variantName ? { variantName: finding.variantName } : {}),
		...(finding.component ? { component: finding.component } : {}),
		// A capture finding's group reads the catalog sentence for its code; the check's own message,
		// which names the View and Widget, stays on the finding. The props and emits check has no code.
		// A registry finding groups by its code as any resource finding does.
		...(finding.check === 'registry' ? {} : { group: { key: finding.check, title: finding.code ? diagnosticText({ code: finding.code }) : t(`checks.kit.groups.${finding.check}`) } }),
	}
}

const findings = computed<readonly Finding[]>(() => {
	const kit = kitResult.value && 'findings' in kitResult.value ? kitResult.value.findings.map(kitFinding) : []
	return [...resourceFindings.value, ...translationFindings.value, ...catalogFindings.value, ...kit]
})

/**
 * One row per Product Kit check: its state, or the run's state while none has finished. Without
 * `evidence.capture` every row says which key it needs; an incomplete props and emits row without
 * `product-kit.source.read` names that key.
 */
const kitRows = computed(() => KIT_CHECKS.map((check) => {
	const result = kitResult.value
	const summary = result && 'checks' in result ? result.checks[check] : undefined
	const state = !canRunKitChecks.value
		? 'not_permitted'
		: kitRunning.value ? 'checking' : summary?.state ?? (result?.status === 'not_applicable' ? 'not_applicable' : kitError.value ? 'failed' : 'not_run')
	const requiredKey = state === 'not_permitted' ? 'evidence.capture' : check === 'props_emits' && state === 'incomplete' && !canReadKitSource.value ? 'product-kit.source.read' : undefined
	return { check, state, requiredKey, checked: summary?.checked ?? 0, unchecked: summary?.unchecked ?? 0, diagnostics: summary?.diagnostics ?? [] }
}))

const KIT_STATE_ICON: Record<string, string> = {
	checking: 'i-lucide-loader-circle',
	completed: 'i-lucide-circle-check',
	incomplete: 'i-lucide-circle-dashed',
	failed: 'i-lucide-circle-x',
	not_applicable: 'i-lucide-circle-minus',
	not_permitted: 'i-lucide-lock',
	not_run: 'i-lucide-circle',
}

// ---- Sources and their check states ------------------------------------------------------------

/** The sources the page lists, with what each one reports. The Preview's translation warnings and Runtime errors are not gathered yet. */
type SourceId = FindingSource | 'preview-translation' | 'runtime'
type SourceRow = Readonly<{ id: SourceId; state: CheckState; count: number; note?: string; requiredKey?: string }>

const SOURCE_STATE_ICON: Record<CheckState, string> = {
	not_checked: 'i-lucide-circle',
	checking: 'i-lucide-loader-circle',
	completed: 'i-lucide-circle-check',
	incomplete: 'i-lucide-circle-dashed',
	failed: 'i-lucide-circle-x',
}

/** The Product Kit source as one state: its checks' own states, or why they did not run. */
const kitState = computed<CheckState>(() => {
	if (kitRunning.value) return 'checking'
	const result = kitResult.value
	if (result && 'checks' in result) return result.status
	if (result?.status === 'not_applicable') return 'completed'
	return kitError.value ? 'failed' : 'not_checked'
})

const sourceRows = computed<readonly SourceRow[]>(() => {
	const countOf = (source: FindingSource): number => findings.value.filter(finding => finding.source === source).length
	const read = readStates.value
	const failedCatalog = catalogError.value?.message
	return [
		{ id: 'validation', state: read.validation, count: countOf('validation') },
		{ id: 'translation', state: read.translation, count: countOf('translation') },
		{
			id: 'catalog',
			state: read.catalog,
			count: countOf('catalog'),
			...(failedCatalog ? { note: failedCatalog } : catalogElsewhere.value ? { note: t('checks.sources.catalogElsewhere', catalogElsewhere.value) } : {}),
		},
		{ id: 'product-kit', state: kitState.value, count: countOf('product-kit'), ...(!canRunKitChecks.value ? { requiredKey: 'evidence.capture' } : {}) },
		{ id: 'preview-translation', state: 'not_checked', count: 0, note: t('checks.sources.notGathered') },
		{ id: 'runtime', state: 'not_checked', count: 0, note: t('checks.sources.notGathered') },
	]
})

/** A run that left a source failed or incomplete never reads as a clean one. */
const unfinished = computed(() => lastRun.value && sourceRows.value.some(row => row.state === 'failed' || row.state === 'incomplete'))

// ---- Filters, grouping and order -------------------------------------------------------------

const filters = computed<FindingFilters>(() => ({
	...(filterSource.value !== ALL ? { source: filterSource.value as FindingSource } : {}),
	...(filterCategory.value !== ALL ? { category: filterCategory.value } : {}),
	...(filterSeverity.value !== ALL ? { severity: filterSeverity.value as FindingSeverity } : {}),
	...(filterView.value !== ALL ? { view: filterView.value } : {}),
	...(filterVariant.value !== ALL ? { variant: filterVariant.value } : {}),
}))
const filtered = computed(() => filterFindings(findings.value, filters.value))
const filterActive = computed(() => Object.keys(filters.value).length > 0)

function options(label: string, values: readonly string[], text: (value: string) => string = value => value) {
	return [{ label, value: ALL }, ...values.map(value => ({ label: text(value), value }))]
}
const sourceOptions = computed(() => options(t('checks.allSources'), FINDING_SOURCES.filter(source => findings.value.some(finding => finding.source === source)), source => t(`checks.source.${source}`)))
const categoryOptions = computed(() => options(t('checks.allCategories'), [...new Set(findings.value.map(categoryOf))].sort()))
const severityOptions = computed(() => options(t('checks.allSeverities'), FINDING_SEVERITIES.filter(severity => findings.value.some(finding => finding.severity === severity)), severity => t(`checks.severity.${severity}`)))
const viewOptions = computed(() => {
	const viewsWithFindings = new Map(findings.value.filter(finding => finding.resource.kind === 'view').map(finding => [finding.resource.key, finding.resource.name]))
	return [{ label: t('checks.allViews'), value: ALL }, ...[...viewsWithFindings].sort(([, a], [, b]) => a.localeCompare(b)).map(([value, label]) => ({ label, value }))]
})
const variantOptions = computed(() => options(t('checks.allVariants'), [...new Set(findings.value.flatMap(finding => finding.variantName ? [finding.variantName] : []))].sort()))
const groupByOptions = computed(() => GROUP_BYS.map(value => ({ label: t(`checks.groupBy.${value}`), value })))

function clearFilters(): void {
	filterSource.value = ALL
	filterCategory.value = ALL
	filterSeverity.value = ALL
	filterView.value = ALL
	filterVariant.value = ALL
}

const RESOURCE_ICON: Record<FindingResource['kind'], string> = {
	'product-kit': 'i-lucide-package',
	workspace: 'i-lucide-settings-2',
	view: 'i-lucide-app-window',
	flow: 'i-lucide-workflow',
	locale: 'i-lucide-globe',
	asset: 'i-lucide-image',
}

type CheckTreeItem = TreeItem & {
	id: string
	level: 'section' | 'problem' | 'resource' | 'finding'
	code?: string
	severity?: FindingSeverity
	count?: number
	countKey?: string
	detail?: string
	meta?: Readonly<{ severity: FindingSeverity; source: FindingSource; state: CheckState; scope: string }>
	mono?: boolean
	action?: string
	children?: CheckTreeItem[]
}

/** The newest finding opened; an older request still checking its View never navigates. */
let openSequence = 0

/**
 * Follows a finding. A View finding first re-reads its View: the findings were read when Checks
 * ran, and the View may be gone since. Then Checks stays where it is and says so in a non-blocking
 * notice instead of opening a missing View (Rule 01a11658-1fde-7b27-ba6d-6de27224b90c). A read that
 * fails otherwise leaves the decision to the View page, as a deep link does. A translation reminder
 * opens its cell in the translation table (Rule 01a115cd-bdb2-7de2-abb9-54f592539471).
 */
async function open(finding: Finding): Promise<void> {
	const { resource } = finding
	const sequence = ++openSequence
	if (resource.kind === 'view') {
		let exists = true
		try { exists = !!await uiux.readResource('view', resource.key) }
		catch { /* unknown: the View page decides */ }
		if (sequence !== openSequence) return
		if (!exists) {
			feedback.notice(t('checks.viewGone.title'), t('checks.viewGone.description', { name: resource.name }))
			return
		}
		void navigateTo(viewLocation(resource.key, { ...(finding.variantName ? { variant: finding.variantName } : {}), ...(finding.widgetId ? { widget: finding.widgetId, panel: 'inspect' } : { panel: 'readiness' }) }))
	}
	else if (resource.kind === 'product-kit') void navigateTo('/workspace/product-kit')
	else if (resource.kind === 'flow') void navigateTo(flowPath(resource.key))
	else if (resource.kind === 'locale') void navigateTo(finding.translationKey !== undefined ? localeCellLocation(resource.key, finding.translationKey) : '/workspace/locales')
	else if (resource.kind === 'asset') void navigateTo('/workspace/assets')
	else void navigateTo('/workspace/settings')
}

/** A Widget finding's second line: its Variant and component, when a Product Kit check names them, then its sentence. */
function findingDetail(finding: Finding): string {
	const parts = [
		...(finding.variantName ? [t('checks.kit.variant', { name: finding.variantName })] : []),
		...(finding.component ? [t('checks.kit.component', { name: finding.component })] : []),
	]
	return parts.length ? parts.join(' · ') : diagnosticText(finding)
}

/** What a finding concerns: its resource kind, and its Variant when it names one. */
function findingScope(finding: Finding): string {
	const kind = t(`checks.scope.${finding.resource.kind}`)
	return finding.variantName ? `${kind} · ${t('checks.kit.variant', { name: finding.variantName })}` : kind
}

function findingLabel(finding: Finding, group: ReturnType<typeof groupFindings>[number]): string {
	if (finding.translationKey !== undefined) return finding.translationKey
	if (finding.widgetId) return `${finding.widgetType ? `${finding.widgetType} · ` : ''}#${finding.widgetId}`
	return group.code ? diagnosticText(finding) : finding.message
}

function problemItems(list: readonly Finding[], prefix: string): CheckTreeItem[] {
	return groupFindings(list).map((group) => {
		const catalog = group.first.source === 'catalog'
		const text = group.title ?? diagnosticText(group)
		return {
			id: `${prefix}problem:${group.key.replaceAll('\u0000', '|')}`,
			level: 'problem',
			label: catalog && group.first.widgetType ? t('checks.catalog.entry', { type: group.first.widgetType, text }) : text,
			code: group.code,
			severity: group.severity,
			count: group.resources.length,
			countKey: catalog ? 'checks.viewCount' : 'checks.resourceCount',
			icon: 'i-lucide-triangle-alert',
			defaultExpanded: true,
			children: group.resources.map(({ resource, findings: members }) => ({
				id: `${prefix}resource:${group.key.replaceAll('\u0000', '|')}:${resource.kind}:${resource.key}`,
				level: 'resource',
				label: resource.name,
				count: members.length,
				countKey: catalog ? 'checks.widgetCount' : 'checks.findingCount',
				icon: RESOURCE_ICON[resource.kind],
				defaultExpanded: true,
				children: members.map((finding, index) => ({
					id: `${prefix}finding:${group.key.replaceAll('\u0000', '|')}:${resource.kind}:${resource.key}:${index}`,
					level: 'finding',
					label: findingLabel(finding, group),
					mono: !!finding.widgetId || finding.translationKey !== undefined,
					detail: finding.widgetId ? findingDetail(finding) : finding.translationKey !== undefined ? diagnosticText(finding) : finding.path,
					meta: { severity: finding.severity, source: finding.source, state: finding.checkState, scope: findingScope(finding) },
					action: finding.translationKey !== undefined ? t('checks.openCell') : finding.widgetId ? t('checks.openWidget') : t('checks.open'),
					icon: finding.translationKey !== undefined ? 'i-lucide-table-cells-merge' : finding.widgetId ? 'i-lucide-crosshair' : 'i-lucide-arrow-up-right',
					onSelect: () => { void open(finding) },
				})),
			})),
		}
	})
}

const items = computed<CheckTreeItem[]>(() => sectionFindings(filtered.value, groupBy.value).flatMap((section) => {
	if (groupBy.value === 'problem') return problemItems(section.findings, '')
	const label = groupBy.value === 'source'
		? t(`checks.source.${section.value}`)
		: groupBy.value === 'severity'
			? t(`checks.severity.${section.value}`)
			: section.value ? section.findings[0]!.resource.name : t('checks.noView')
	return [{
		id: `section:${section.key}`,
		level: 'section' as const,
		label,
		count: section.findings.length,
		countKey: 'checks.findingCount',
		icon: groupBy.value === 'view' ? 'i-lucide-app-window' : groupBy.value === 'source' ? 'i-lucide-layers' : 'i-lucide-gauge',
		defaultExpanded: true,
		children: problemItems(section.findings, `${section.key}:`),
	}]
}))
</script>

<template>
  <div
    class="space-y-4"
    data-overview-checks
  >
    <div class="flex flex-wrap items-center gap-2">
      <UButton
        color="primary"
        variant="solid"
        icon="i-lucide-play"
        :loading="running"
        data-run-checks
        @click="runChecks"
      >
        {{ t('checks.run') }}
      </UButton>
      <span
        class="text-sm text-muted"
        role="status"
      >
        <template v-if="running">{{ t('checks.running') }}</template>
        <template v-else-if="lastRun && unfinished">{{ t('checks.lastRunUnfinished', { time: fmt.time(lastRun), n: findings.length }, findings.length) }}</template>
        <template v-else-if="lastRun">{{ t('checks.lastRun', { time: fmt.time(lastRun), n: findings.length }, findings.length) }}</template>
        <template v-else>{{ t('checks.notRun', workspaceFindingCount) }}</template>
      </span>
    </div>

    <section
      class="rounded-lg border border-default p-3"
      data-check-sources
      :aria-label="t('checks.sources.title')"
    >
      <h3 class="text-sm font-medium text-highlighted">
        {{ t('checks.sources.title') }}
      </h3>
      <p class="mt-0.5 text-xs text-muted">
        {{ t('checks.sources.description') }}
      </p>
      <ul class="mt-2 space-y-1.5">
        <li
          v-for="row in sourceRows"
          :key="row.id"
          class="flex flex-wrap items-start gap-x-2 text-sm"
          :data-check-source="row.id"
          :data-check-source-state="row.state"
        >
          <UIcon
            :name="SOURCE_STATE_ICON[row.state]"
            class="mt-0.5 size-4 shrink-0"
            :class="[row.state === 'failed' ? 'text-error' : row.state === 'completed' ? 'text-success' : 'text-muted', row.state === 'checking' ? 'animate-spin' : '']"
          />
          <span class="text-default">{{ t(`checks.source.${row.id}`) }}</span>
          <span class="text-xs text-muted">{{ t(`checks.state.${row.state}`) }}</span>
          <span
            v-if="row.state === 'completed' || row.state === 'incomplete'"
            class="text-xs text-muted tabular-nums"
            data-check-source-count
          >{{ t('checks.findingCount', row.count) }}</span>
          <span
            v-if="row.note"
            class="text-xs text-muted"
          >{{ row.note }}</span>
          <span
            v-if="row.requiredKey && row.state === 'not_checked'"
            class="text-xs text-muted"
          >{{ t('access.requiresKey', { key: row.requiredKey }) }}</span>
        </li>
      </ul>
    </section>

    <div
      v-if="lastRun && findings.length"
      class="flex flex-wrap items-center gap-2"
      data-check-filters
    >
      <USelect
        v-model="groupBy"
        :items="groupByOptions"
        :aria-label="t('checks.groupBy.label')"
        class="w-40"
        data-check-group-by
      />
      <USelect
        v-model="filterSource"
        :items="sourceOptions"
        :aria-label="t('checks.sourceFilter')"
        class="w-40"
        data-check-filter="source"
      />
      <USelect
        v-model="filterCategory"
        :items="categoryOptions"
        :aria-label="t('checks.category')"
        class="w-40"
        data-check-filter="category"
      />
      <USelect
        v-model="filterSeverity"
        :items="severityOptions"
        :aria-label="t('checks.severityFilter')"
        class="w-40"
        data-check-filter="severity"
      />
      <USelect
        v-model="filterView"
        :items="viewOptions"
        :aria-label="t('checks.viewFilter')"
        class="w-48"
        data-check-filter="view"
      />
      <USelect
        v-if="variantOptions.length > 1"
        v-model="filterVariant"
        :items="variantOptions"
        :aria-label="t('checks.variantFilter')"
        class="w-40"
        data-check-filter="variant"
      />
      <UButton
        v-if="filterActive"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-filter-x"
        data-check-clear-filters
        @click="clearFilters"
      >
        {{ t('checks.clearFilters') }}
      </UButton>
    </div>

    <UAlert
      v-if="missingDefaultLocale"
      color="error"
      variant="subtle"
      icon="i-lucide-globe-lock"
      :title="t('checks.missingDefaultLocale.title')"
      :actions="[{ label: t('checks.missingDefaultLocale.action'), color: 'neutral', variant: 'outline', onClick: () => { void navigateTo('/workspace/locales') } }]"
      data-checks-persistent-error="i18n.missing_default_locale"
    >
      <template #description>
        <i18n-t
          keypath="checks.missingDefaultLocale.description"
          tag="p"
          scope="global"
        >
          <template #locale>
            <code class="font-mono">{{ missingDefaultLocale }}</code>
          </template>
        </i18n-t>
      </template>
    </UAlert>

    <UAlert
      v-for="failure in failures"
      :key="failure.name"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('checks.readFailedFor', { name: failure.name })"
    >
      <template #description>
        <WbErrorDescription
          :headline="t('checks.readFailedFor', { name: failure.name })"
          :lead="failure.error.message"
          :diagnostics="failure.error.diagnostics"
          :status-code="failure.error.statusCode"
        />
      </template>
    </UAlert>

    <section
      v-if="lastRun || running || kitRunning"
      class="rounded-lg border border-default p-3"
      data-kit-checks
      :aria-label="t('checks.kit.title')"
    >
      <h3 class="text-sm font-medium text-highlighted">
        {{ t('checks.kit.title') }}
      </h3>
      <p class="mt-0.5 text-xs text-muted">
        {{ t('checks.kit.description') }}
      </p>
      <ul class="mt-2 space-y-1.5">
        <li
          v-for="row in kitRows"
          :key="row.check"
          class="flex flex-wrap items-start gap-x-2 text-sm"
          :data-kit-check="row.check"
          :data-kit-check-state="row.state"
        >
          <UIcon
            :name="KIT_STATE_ICON[row.state]!"
            class="mt-0.5 size-4 shrink-0"
            :class="[row.state === 'failed' ? 'text-error' : row.state === 'completed' ? 'text-success' : 'text-muted', row.state === 'checking' ? 'animate-spin' : '']"
          />
          <span class="text-default">{{ t(`checks.kit.checks.${row.check}`) }}</span>
          <span class="text-xs text-muted">{{ t(`checks.kit.state.${row.state}`, { checked: row.checked, unchecked: row.unchecked }) }}</span>
          <span
            v-if="row.requiredKey"
            class="text-xs text-muted"
            :data-kit-check-required-key="row.requiredKey"
          >{{ t('access.requiresKey', { key: row.requiredKey }) }}</span>
          <ul
            v-if="row.diagnostics.length && row.state !== 'checking'"
            class="w-full ps-6 text-xs text-muted"
          >
            <li
              v-for="(diagnostic, index) in row.diagnostics.slice(0, 5)"
              :key="index"
            >
              {{ diagnosticText(diagnostic) }}
            </li>
          </ul>
        </li>
      </ul>
      <p
        v-if="kitError"
        class="mt-2 text-xs text-error"
        role="alert"
      >
        {{ kitError.message }}
      </p>
    </section>

    <div
      v-if="running && !lastRun"
      class="space-y-2"
    >
      <USkeleton
        v-for="index in 4"
        :key="index"
        class="h-7 w-full"
        :aria-label="t('common.loading')"
      />
    </div>

    <UEmpty
      v-else-if="!lastRun"
      icon="i-lucide-list-checks"
      variant="naked"
      :title="t('checks.notRunTitle')"
      :description="t('checks.notRunDescription')"
    />

    <UEmpty
      v-else-if="!findings.length && unfinished"
      icon="i-lucide-circle-dashed"
      variant="naked"
      :title="t('checks.unfinishedTitle')"
      :description="t('checks.unfinishedDescription')"
      data-checks-unfinished
    />

    <UEmpty
      v-else-if="!findings.length"
      icon="i-lucide-circle-check"
      variant="naked"
      :title="t('checks.clean')"
      :description="t('checks.cleanDescription')"
    />

    <UEmpty
      v-else-if="!items.length"
      icon="i-lucide-filter-x"
      variant="naked"
      :title="t('checks.noMatches')"
      :description="t('checks.noMatchesDescription')"
      :actions="[{ label: t('checks.clearFilters'), color: 'neutral', variant: 'outline', onClick: clearFilters }]"
      data-checks-no-matches
    />

    <UTree
      v-else
      :items="items"
      :get-key="item => item.id"
      :aria-label="t('checks.treeLabel')"
      :ui="{ link: 'min-h-8 items-start py-1', linkLabel: 'whitespace-normal' }"
      class="rounded-lg border border-default p-1"
      data-checks-tree
    >
      <template #item-leading="{ item }">
        <UIcon
          :name="item.icon!"
          class="mt-0.5 size-4 shrink-0"
          :class="(item as CheckTreeItem).level === 'problem' ? ((item as CheckTreeItem).severity === 'error' ? 'text-error' : 'text-warning') : 'text-muted'"
        />
      </template>
      <template #item-label="{ item }">
        <span
          v-if="(item as CheckTreeItem).level === 'problem'"
          class="flex min-w-0 flex-wrap items-baseline gap-x-2"
          :data-check-problem="(item as CheckTreeItem).code"
          :data-check-severity="(item as CheckTreeItem).severity"
        >
          <span
            class="font-mono text-xs"
            :class="(item as CheckTreeItem).severity === 'error' ? 'text-error' : 'text-warning'"
          >{{ (item as CheckTreeItem).code }}</span>
          <span class="text-highlighted">{{ item.label }}</span>
          <span class="text-xs text-muted">{{ t(`checks.severity.${(item as CheckTreeItem).severity}`) }}</span>
        </span>
        <span
          v-else-if="(item as CheckTreeItem).level === 'finding'"
          class="flex min-w-0 flex-col items-start text-start"
          :data-check-finding="item.id"
          :data-finding-source="(item as CheckTreeItem).meta?.source"
          :data-finding-severity="(item as CheckTreeItem).meta?.severity"
          :data-finding-state="(item as CheckTreeItem).meta?.state"
        >
          <span :class="(item as CheckTreeItem).mono ? 'font-mono text-xs text-highlighted' : 'text-default'">{{ item.label }}</span>
          <span
            v-if="(item as CheckTreeItem).detail"
            class="truncate text-xs text-muted"
            :class="(item as CheckTreeItem).mono ? '' : 'font-mono'"
          >{{ (item as CheckTreeItem).detail }}</span>
          <span
            v-if="(item as CheckTreeItem).meta"
            class="text-xs text-muted"
            data-check-finding-meta
          >{{ [t(`checks.severity.${(item as CheckTreeItem).meta!.severity}`), t(`checks.source.${(item as CheckTreeItem).meta!.source}`), (item as CheckTreeItem).meta!.scope, t(`checks.state.${(item as CheckTreeItem).meta!.state}`)].join(' · ') }}</span>
        </span>
        <span
          v-else
          class="text-default"
        >{{ item.label }}</span>
      </template>
      <template #item-trailing="{ item, expanded }">
        <span
          v-if="(item as CheckTreeItem).level !== 'finding'"
          class="ms-auto shrink-0 text-xs text-muted tabular-nums"
          data-check-count
        >{{ t((item as CheckTreeItem).countKey!, (item as CheckTreeItem).count ?? 0) }}</span>
        <UIcon
          v-if="(item as CheckTreeItem).level !== 'finding'"
          name="i-lucide-chevron-down"
          class="size-4 shrink-0 text-dimmed transition-transform"
          :class="expanded ? 'rotate-180' : ''"
        />
        <span
          v-else
          class="ms-auto inline-flex shrink-0 items-center gap-0.5 text-xs text-muted"
        >{{ (item as CheckTreeItem).action }}<UIcon
          name="i-lucide-chevron-right"
          class="size-3.5"
        /></span>
      </template>
    </UTree>
  </div>
</template>
