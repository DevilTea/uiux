<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TreeItem } from '@nuxt/ui'
import { resolveDiagnosticWidgetTarget } from '../../../src/preview/checks-navigation'
import { deriveWidgetTree, flattenWidgetTree } from '../../../src/preview/widget-tree'
import { useAccess } from '../../composables/useAccess'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import type { Diagnostic } from '../../composables/workbench-types'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { groupFindings, type Finding, type FindingResource } from '../../utils/readiness'
import { flowPath, viewLocation } from '../../utils/workbench-routes'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'
import { diagnosticText } from '../../utils/diagnostic-copy'

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
 */
const { t } = useI18n()
const access = useAccess()
const uiux = useUiuxClient()
const fmt = useWorkbenchFormat()
const { views, flows, workspaceFindingCount } = useWorkbench()

type ResourceRead = Readonly<{ key: string; revision: string; diagnostics?: readonly Diagnostic[]; resource?: Record<string, unknown> }>

const running = ref(false)
const lastRun = ref<Date>()
const resourceFindings = shallowRef<readonly Finding[]>([])
const failures = shallowRef<readonly Readonly<{ name: string; error: FetchErrorDetails }>[]>([])
const category = ref('all')

async function read(kind: string, key: string): Promise<ResourceRead | undefined> {
	return uiux.readResource<ResourceRead>(kind, key)
}

/** Reads each resource once, in small batches, and keeps every finding it reports. */
async function runChecks(): Promise<void> {
	if (running.value) return
	running.value = true
	if (!kitRunning.value && canRunKitChecks.value) void runKitChecks()
	const collected: Finding[] = []
	const failed: { name: string; error: FetchErrorDetails }[] = []
	const push = (resource: FindingResource, diagnostics: readonly Diagnostic[] | undefined, widgetFor?: (diagnostic: Diagnostic) => string | undefined, types?: ReadonlyMap<string, string>) => {
		for (const diagnostic of diagnostics ?? []) {
			const widgetId = widgetFor?.(diagnostic)
			const widgetType = widgetId ? types?.get(widgetId) : undefined
			collected.push({ code: diagnostic.code, message: diagnostic.message, path: diagnostic.path, resource, ...(widgetId ? { widgetId } : {}), ...(widgetType ? { widgetType } : {}) })
		}
	}
	type Job = Readonly<{ kind: FindingResource['kind']; key: string; name: string }>
	const [locales, assets] = await Promise.all([
		uiux.listResources<{ key: string }>(['locale'], { limit: 100 }).then(page => page.items).catch(() => []),
		uiux.listResources<{ key: string; summary?: { name?: string } }>(['asset'], { limit: 100 }).then(page => page.items).catch(() => []),
	])
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
				if (job.kind !== 'view') {
					push(resource, result.diagnostics)
					return
				}
				const ir = result.resource?.ir
				const tree = ir ? deriveWidgetTree(ir) : undefined
				const types = new Map(tree?.status === 'valid' ? flattenWidgetTree(tree.root).map(widget => [widget.id, widget.type] as const) : [])
				push(resource, result.diagnostics, diagnostic => resolveDiagnosticWidgetTarget(diagnostic, ir, new Set(types.keys())), types)
			}
			catch (cause) {
				failed.push({ name: job.name, error: describeFetchError(cause, t('checks.readFailed')) })
			}
		}))
	}
	resourceFindings.value = collected
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
	return {
		code: finding.code ?? '',
		message: finding.message,
		path: finding.path,
		resource,
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
	return [...resourceFindings.value, ...kit]
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

const categories = computed(() => {
	const set = new Set(groupFindings(findings.value).map(group => group.category))
	return [{ label: t('checks.allCategories'), value: 'all' }, ...[...set].sort().map(value => ({ label: value, value }))]
})

const groups = computed(() => groupFindings(findings.value).filter(group => category.value === 'all' || group.category === category.value))

const RESOURCE_ICON: Record<FindingResource['kind'], string> = {
	'product-kit': 'i-lucide-package',
	workspace: 'i-lucide-settings-2',
	view: 'i-lucide-app-window',
	flow: 'i-lucide-workflow',
	locale: 'i-lucide-globe',
	asset: 'i-lucide-image',
}

type CheckTreeItem = TreeItem & { id: string; level: 'problem' | 'resource' | 'finding'; code?: string; count?: number; detail?: string; mono?: boolean; action?: string; children?: CheckTreeItem[] }

function open(finding: Finding): void {
	const { resource } = finding
	if (resource.kind === 'view') void navigateTo(viewLocation(resource.key, { ...(finding.variantName ? { variant: finding.variantName } : {}), ...(finding.widgetId ? { widget: finding.widgetId, panel: 'inspect' } : { panel: 'readiness' }) }))
	else if (resource.kind === 'product-kit') void navigateTo('/workspace/product-kit')
	else if (resource.kind === 'flow') void navigateTo(flowPath(resource.key))
	else if (resource.kind === 'locale') void navigateTo('/workspace/locales')
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

const items = computed<CheckTreeItem[]>(() => groups.value.map(group => ({
	id: `problem:${group.key}`,
	level: 'problem',
	label: group.title ?? diagnosticText(group),
	code: group.code,
	count: group.resources.length,
	icon: 'i-lucide-triangle-alert',
	defaultExpanded: true,
	children: group.resources.map(({ resource, findings: list }) => ({
		id: `resource:${group.key}:${resource.kind}:${resource.key}`,
		level: 'resource',
		label: resource.name,
		icon: RESOURCE_ICON[resource.kind],
		defaultExpanded: true,
		children: list.map((finding, index) => ({
			id: `finding:${group.key}:${resource.kind}:${resource.key}:${index}`,
			level: 'finding',
			label: finding.widgetId ? `${finding.widgetType ? `${finding.widgetType} · ` : ''}#${finding.widgetId}` : group.code ? diagnosticText(finding) : finding.message,
			mono: !!finding.widgetId,
			detail: finding.widgetId ? findingDetail(finding) : finding.path,
			action: finding.widgetId ? t('checks.openWidget') : t('checks.open'),
			icon: finding.widgetId ? 'i-lucide-crosshair' : 'i-lucide-arrow-up-right',
			onSelect: () => open(finding),
		})),
	})),
})))
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
        <template v-else-if="lastRun">{{ t('checks.lastRun', { time: fmt.time(lastRun), n: findings.length }, findings.length) }}</template>
        <template v-else>{{ t('checks.notRun', workspaceFindingCount) }}</template>
      </span>
      <USelect
        v-if="lastRun && findings.length"
        v-model="category"
        :items="categories"
        :aria-label="t('checks.category')"
        class="ms-auto w-44"
      />
    </div>

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
      v-else-if="!findings.length"
      icon="i-lucide-circle-check"
      variant="naked"
      :title="t('checks.clean')"
      :description="t('checks.cleanDescription')"
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
          :class="(item as CheckTreeItem).level === 'problem' ? 'text-warning' : 'text-muted'"
        />
      </template>
      <template #item-label="{ item }">
        <span
          v-if="(item as CheckTreeItem).level === 'problem'"
          class="flex min-w-0 flex-wrap items-baseline gap-x-2"
        >
          <span class="font-mono text-xs text-warning">{{ (item as CheckTreeItem).code }}</span>
          <span class="text-highlighted">{{ item.label }}</span>
        </span>
        <span
          v-else-if="(item as CheckTreeItem).level === 'finding'"
          class="flex min-w-0 flex-col items-start text-start"
          :data-check-finding="item.id"
        >
          <span :class="(item as CheckTreeItem).mono ? 'font-mono text-xs text-highlighted' : 'text-default'">{{ item.label }}</span>
          <span
            v-if="(item as CheckTreeItem).detail"
            class="truncate text-xs text-muted"
            :class="(item as CheckTreeItem).mono ? '' : 'font-mono'"
          >{{ (item as CheckTreeItem).detail }}</span>
        </span>
        <span
          v-else
          class="text-default"
        >{{ item.label }}</span>
      </template>
      <template #item-trailing="{ item, expanded }">
        <span
          v-if="(item as CheckTreeItem).level === 'problem'"
          class="ms-auto shrink-0 text-xs text-muted tabular-nums"
        >{{ t('checks.resourceCount', (item as CheckTreeItem).count ?? 0) }}</span>
        <UIcon
          v-if="(item as CheckTreeItem).level !== 'finding'"
          name="i-lucide-chevron-down"
          class="size-4 shrink-0 text-dimmed transition-transform"
          :class="[(item as CheckTreeItem).level === 'resource' ? 'ms-auto' : '', expanded ? 'rotate-180' : '']"
        />
        <span
          v-else-if="(item as CheckTreeItem).level === 'finding'"
          class="ms-auto inline-flex shrink-0 items-center gap-0.5 text-xs text-muted"
        >{{ (item as CheckTreeItem).action }}<UIcon
          name="i-lucide-chevron-right"
          class="size-3.5"
        /></span>
      </template>
    </UTree>
  </div>
</template>
