<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TreeItem } from '@nuxt/ui'
import { resolveDiagnosticWidgetTarget } from '../../../src/preview/checks-navigation'
import { deriveWidgetTree, flattenWidgetTree } from '../../../src/preview/widget-tree'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import type { Diagnostic } from '../../composables/workbench-types'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { groupFindings, type Finding, type FindingResource } from '../../utils/readiness'
import { flowPath, viewLocation } from '../../utils/workbench-routes'

/**
 * Overview › Checks (Part 5): one normalized findings surface for the Workspace, grouped
 * problem → resource → Widget. It runs only when asked ("Run Checks") and never lists Review
 * queues; those live in the Reviews inbox.
 */
const { t } = useI18n()
const uiux = useUiuxClient()
const fmt = useWorkbenchFormat()
const { views, flows, workspaceFindingCount } = useWorkbench()

type ResourceRead = Readonly<{ key: string; revision: string; diagnostics?: readonly Diagnostic[]; resource?: Record<string, unknown> }>

const running = ref(false)
const lastRun = ref<Date>()
const findings = shallowRef<readonly Finding[]>([])
const failures = shallowRef<readonly Readonly<{ name: string; error: FetchErrorDetails }>[]>([])
const category = ref('all')

async function read(kind: string, key: string): Promise<ResourceRead | undefined> {
	return uiux.readResource<ResourceRead>(kind, key)
}

/** Reads each resource once, in small batches, and keeps every finding it reports. */
async function runChecks(): Promise<void> {
	if (running.value) return
	running.value = true
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
	findings.value = collected
	failures.value = failed
	lastRun.value = new Date()
	running.value = false
}

const categories = computed(() => {
	const set = new Set(groupFindings(findings.value).map(group => group.category))
	return [{ label: t('checks.allCategories'), value: 'all' }, ...[...set].sort().map(value => ({ label: value, value }))]
})

const groups = computed(() => groupFindings(findings.value).filter(group => category.value === 'all' || group.category === category.value))

const RESOURCE_ICON: Record<FindingResource['kind'], string> = {
	workspace: 'i-lucide-settings-2',
	view: 'i-lucide-app-window',
	flow: 'i-lucide-workflow',
	locale: 'i-lucide-globe',
	asset: 'i-lucide-image',
}

type CheckTreeItem = TreeItem & { id: string; level: 'problem' | 'resource' | 'finding'; code?: string; count?: number; detail?: string; mono?: boolean; action?: string; children?: CheckTreeItem[] }

function open(finding: Finding): void {
	const { resource } = finding
	if (resource.kind === 'view') void navigateTo(viewLocation(resource.key, finding.widgetId ? { widget: finding.widgetId, panel: 'inspect' } : { panel: 'readiness' }))
	else if (resource.kind === 'flow') void navigateTo(flowPath(resource.key))
	else if (resource.kind === 'locale') void navigateTo('/workspace/locales')
	else if (resource.kind === 'asset') void navigateTo('/workspace/assets')
	else void navigateTo('/workspace/settings')
}

const items = computed<CheckTreeItem[]>(() => groups.value.map(group => ({
	id: `problem:${group.code}`,
	level: 'problem',
	label: group.message,
	code: group.code,
	count: group.resources.length,
	icon: 'i-lucide-triangle-alert',
	defaultExpanded: true,
	children: group.resources.map(({ resource, findings: list }) => ({
		id: `resource:${group.code}:${resource.kind}:${resource.key}`,
		level: 'resource',
		label: resource.name,
		icon: RESOURCE_ICON[resource.kind],
		defaultExpanded: true,
		children: list.map((finding, index) => ({
			id: `finding:${group.code}:${resource.kind}:${resource.key}:${index}`,
			level: 'finding',
			label: finding.widgetId ? `${finding.widgetType ? `${finding.widgetType} · ` : ''}#${finding.widgetId}` : finding.message,
			mono: !!finding.widgetId,
			detail: finding.widgetId ? finding.message : finding.path,
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
      :description="failure.error.message"
    />

    <div
      v-if="running && !lastRun"
      class="space-y-2"
    >
      <USkeleton
        v-for="index in 4"
        :key="index"
        class="h-7 w-full"
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
