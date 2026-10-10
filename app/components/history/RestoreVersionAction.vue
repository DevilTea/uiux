<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n, useToast } from '#imports'
import type { VersionRecord } from '../../../src/domain/history/schema'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { notifyHistoryChanged, readVersionRecord, useVersionDiff } from '../../composables/useVersionHistory'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { CURRENT_COMPARE, type HistoryResourceRef } from '../../utils/version-history'
import { classifyRestoreAnswer, groupImpacts, matchesCurrent, shortId, type ImpactGroup, type ReceivedImpact } from '../../utils/version-restore'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * "Restore this version" on a resource's diff (Rule 01a11a5e-18f2-7991-8f7d-aa4c8015d14a; offered
 * by the caller only on a desktop layout to an Editor or above, Rule 01a11a5e-1bfa-71e9-9611-152b5b665379).
 *
 * Opening the dialog reads the resource's current revision, the `expectedRevision` of the write
 * (`null` when the resource no longer exists, owner ruling 3 of
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439), so a change made
 * after the dialog opened conflicts instead of being overwritten (Rule 01a11a5e-1520-…). Restore
 * sends `POST /api/history/versions/:id/restore`; with a non-empty impact list the server writes
 * nothing (Rule 01a11a5e-16f7-…) and the dialog lists the impact by group (Rules 01a11a5e-174b-…
 * and 17a0-…), writing only after the explicit "Restore anyway", which resends with
 * `acknowledgeImpact: true`. A conflict offers to reload the revision; a lease names its holder;
 * other refusals are explained with their diagnostics. Focus starts on Cancel; each later state
 * moves focus to its own text so it is read out.
 *
 * Opening the dialog also compares the version with the current state for this resource. When the
 * resource already matches the version, a restore would change nothing yet still form a version of
 * its own, so the dialog says so and offers no Restore; the server has no refusal for this case
 * (Clause 01a11a5e-2768-76ad-b02a-e15f50f91268), so the guard is the Workbench's alone. Compared
 * with its parent (`afterChange`), the version restored is still the selected one: its content right
 * after that change, never the content before it (Rule 01a11a5e-18f2-…, owner decision on PR #166).
 *
 * A restore forms a version of its own naming its source (Rules 01a11a5e-14ce-… and
 * 01a11e0d-d911-…), so on success every timeline and the Workbench's resources are read again.
 */
const props = defineProps<{
	resource: HistoryResourceRef
	/** The version restored from: the comparison's selected version (`restoreSourceVersion`). */
	versionId: string
	/** The resource's display name. */
	resourceName: string
	/** The comparison is with the version's parent: the dialog says the content restored is the one after that change. */
	afterChange?: boolean
}>()

const { t, locale } = useI18n()
const toast = useToast()
const uiux = useUiuxClient()
const workbench = useWorkbench()
const labels = useHistoryLabels()

type Stage = 'confirm' | 'impact' | 'conflict' | 'locked' | 'refused'
const open = ref(false)
const stage = ref<Stage>('confirm')
const reading = ref(false)
const submitting = ref(false)
/** The revision the write expects; `null` when the resource does not exist; `undefined` until read. */
const expectedRevision = ref<string | null>()
const impacts = shallowRef<readonly ReceivedImpact[]>([])
const error = shallowRef<FetchErrorDetails>()
const refusedStatus = ref<'invalid' | 'not_found' | 'blocked' | 'denied' | 'failed'>('failed')
const record = shallowRef<VersionRecord>()
/** The current revision could not be read: the refusal offers to read it again. */
const readFailed = ref(false)

const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')
const stageRegion = useTemplateRef<HTMLElement>('stageRegion')

/** The version compared with the current state, for this resource alone, while the dialog is open. */
const match = useVersionDiff(() => ({ from: props.versionId, to: CURRENT_COMPARE }), {
	resources: () => [props.resource],
	detail: 'summary',
	enabled: open,
})
/** `true` when the resource already matches the version; `undefined` while unknown. A failed comparison blocks nothing: the server decides. */
const unchanged = computed(() => {
	if (match.loading.value) return undefined
	if (match.error.value || !match.result.value) return match.error.value ? false : undefined
	return matchesCurrent(match.result.value.summary, props.resource)
})

const versionName = computed(() => record.value ? labels.versionTitle(record.value) : t('history.restore.thisVersion'))
const versionTime = computed(() => record.value ? labels.dateTime(record.value.at) : '')
const missing = computed(() => expectedRevision.value === null)
/** What the restore writes: the version's content, said as "right after this change" when compared with its parent. */
const summaryText = computed(() => {
	const params = { resource: props.resourceName, version: versionName.value, time: versionTime.value }
	if (props.afterChange) return versionTime.value ? t('history.restore.bodyAfterChange', params) : t('history.restore.bodyAfterChangeNoTime', params)
	return versionTime.value ? t('history.restore.body', params) : t('history.restore.bodyNoTime', params)
})
const groups = computed(() => groupImpacts(impacts.value))
const dialogTitle = computed(() => stage.value === 'impact' ? t('history.restore.impact.title') : t('history.restore.title'))

/** Focus starts on Cancel, the safe choice; the dialog's own autofocus would land on its close button. */
function focusCancel(event: Event): void {
	event.preventDefault()
	cancelButton.value?.$el?.focus()
}

/** A later state replaces the buttons that had focus, so focus moves to that state's text. */
function enter(next: Stage): void {
	stage.value = next
	void nextTick(() => stageRegion.value?.focus())
}

async function readCurrent(): Promise<void> {
	reading.value = true
	readFailed.value = false
	expectedRevision.value = undefined
	try {
		const read = await uiux.readResource<{ revision?: string }>(props.resource.kind, props.resource.key)
		expectedRevision.value = read?.revision ?? null
		return
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('history.restore.readFailed', { resource: props.resourceName }))
		refusedStatus.value = 'failed'
		readFailed.value = true
	}
	finally {
		reading.value = false
	}
	enter('refused')
}

function show(): void {
	stage.value = 'confirm'
	impacts.value = []
	error.value = undefined
	open.value = true
	void readVersionRecord(props.versionId).then((read) => { record.value = read.version }).catch(() => undefined)
	void readCurrent()
}

/** Back to the confirmation with the newest revision, after a conflict or a lease. */
async function reload(): Promise<void> {
	error.value = undefined
	impacts.value = []
	stage.value = 'confirm'
	void workbench.refreshAll()
	void match.load()
	await readCurrent()
	if (stage.value === 'confirm') void nextTick(() => cancelButton.value?.$el?.focus())
}

async function restore(acknowledgeImpact: boolean): Promise<void> {
	if (submitting.value || reading.value || expectedRevision.value === undefined || unchanged.value !== false) return
	submitting.value = true
	error.value = undefined
	let status: number | undefined
	let body: unknown
	try {
		body = await $fetch(`/api/history/versions/${encodeURIComponent(props.versionId)}/restore`, {
			method: 'POST',
			body: { resource: { kind: props.resource.kind, key: props.resource.key }, expectedRevision: expectedRevision.value, ...(acknowledgeImpact ? { acknowledgeImpact: true } : {}) },
		})
		status = 200
	}
	catch (cause) {
		const failure = cause as { statusCode?: number; status?: number; data?: unknown }
		status = failure.statusCode ?? failure.status
		body = failure.data
		error.value = describeFetchError(cause, t('history.restore.refused.failed'))
		if (status === undefined) {
			refusedStatus.value = 'failed'
			submitting.value = false
			enter('refused')
			return
		}
	}
	submitting.value = false
	const answer = classifyRestoreAnswer(status, body)
	switch (answer.state) {
		case 'restored':
			open.value = false
			notifyHistoryChanged()
			void workbench.refreshAll()
			toast.add({
				title: t(answer.created ? 'history.restore.recreated' : 'history.restore.restored', { resource: props.resourceName, version: versionName.value }),
				color: 'success',
				icon: 'i-lucide-history',
			})
			return
		case 'impact':
			impacts.value = answer.impacts
			enter('impact')
			return
		case 'conflict':
			enter('conflict')
			return
		case 'locked':
			enter('locked')
			return
		case 'refused':
			refusedStatus.value = answer.status
			error.value = describeFetchError({ statusCode: status, data: body }, t(`history.restore.refused.${answer.status}`))
			enter('refused')
	}
}

const lockUntil = computed(() => {
	const expiresAt = error.value?.lock ? Date.parse(error.value.lock.expiresAt) : Number.NaN
	return Number.isFinite(expiresAt)
		? new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(expiresAt))
		: '–'
})

// ----- Impact items -----------------------------------------------------------------------------

function viewName(id: unknown): string {
	return typeof id === 'string' ? labels.resourceName({ kind: 'view', key: id }) : '?'
}
function flowName(id: unknown): string {
	return typeof id === 'string' ? labels.resourceName({ kind: 'flow', key: id }) : '?'
}
function text(value: unknown): string {
	return typeof value === 'string' ? value : '?'
}
function threads(ids: unknown): string {
	return Array.isArray(ids) ? ids.map(id => shortId(String(id))).join(t('common.listSeparator')) : ''
}

/** One impact item as a sentence; IDs are shortened, the full value is in the item's `title`. */
function describeImpact(item: ReceivedImpact): string {
	const value = item as Readonly<Record<string, unknown>>
	const anchor = (value.anchor ?? {}) as Readonly<Record<string, unknown>>
	switch (item.category) {
		case 'review_anchor_invalidated':
			return t('history.restore.impact.item.anchorInvalidated', { thread: shortId(text(value.reviewId)), widget: text(anchor.widgetId), view: viewName(anchor.viewId) })
		case 'review_anchor_revalidated':
			return t('history.restore.impact.item.anchorRevalidated', { thread: shortId(text(value.reviewId)), widget: text(anchor.widgetId), view: viewName(anchor.viewId) })
		case 'i18n_reference_dangling':
			return t('history.restore.impact.item.textKey', { key: text(value.i18nKey), view: viewName(value.viewId) })
		case 'asset_reference_dangling':
			return t('history.restore.impact.item.asset', { asset: labels.resourceName({ kind: 'asset', key: text(value.assetId) }), view: viewName(value.viewId) })
		case 'flow_step_widget_missing':
			return t('history.restore.impact.item.flowStep', { flow: flowName(value.flowId), step: text(value.stepId), widgets: Array.isArray(value.widgetIds) ? value.widgetIds.join(t('common.listSeparator')) : '', view: viewName(value.viewId) })
		case 'submission_revision_not_current':
		case 'submission_revision_current': {
			const resource = (value.resource ?? {}) as Readonly<Record<string, unknown>>
			const named = { kind: text(resource.kind), key: text(resource.key) }
			return t(item.category === 'submission_revision_current' ? 'history.restore.impact.item.submissionCurrent' : 'history.restore.impact.item.submissionNotCurrent', {
				thread: shortId(text(value.reviewId)),
				kind: labels.kindLabel(named.kind),
				resource: labels.resourceName(named),
			})
		}
		case 'render_key_removed': {
			const ids = Array.isArray(value.reviewIds) ? value.reviewIds : []
			const key = value.dimension === 'theme' ? 'history.restore.impact.item.themeRemoved' : 'history.restore.impact.item.viewportRemoved'
			return `${t(key, { key: text(value.key) })} ${ids.length ? t('history.restore.impact.item.namedBy', { threads: threads(ids) }, ids.length) : t('history.restore.impact.item.namedByNone')}`
		}
		case 'evidence_stale':
			return typeof value.viewId === 'string'
				? t('history.restore.impact.item.evidenceForView', { evidence: shortId(text(value.evidence)), view: viewName(value.viewId) })
				: t('history.restore.impact.item.evidence', { evidence: shortId(text(value.evidence)) })
		default:
			return t('history.restore.impact.item.other', { category: item.category })
	}
}

/** The full identifiers an item names, for its tooltip. */
function impactIds(item: ReceivedImpact): string | undefined {
	const value = item as Readonly<Record<string, unknown>>
	const ids = [value.reviewId, value.evidence, ...(Array.isArray(value.reviewIds) ? value.reviewIds : [])].filter((id): id is string => typeof id === 'string')
	return ids.length ? ids.join(', ') : undefined
}

function groupLabel(group: ImpactGroup): string {
	return t(`history.restore.impact.group.${group}`)
}
</script>

<template>
  <div>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-history"
      :label="t('history.restore.action')"
      :aria-label="t('history.restore.actionNamed', { resource: resourceName })"
      aria-haspopup="dialog"
      data-restore-version
      @click="show"
    />
    <UModal
      v-model:open="open"
      :title="dialogTitle"
      :dismissible="!submitting"
      :content="{ onOpenAutoFocus: focusCancel }"
    >
      <template #body>
        <div
          class="space-y-3"
          data-restore-dialog
          :data-stage="stage"
          :aria-busy="reading || submitting || undefined"
        >
          <div
            v-if="stage === 'confirm'"
            class="space-y-2 text-sm text-default"
          >
            <p
              v-if="unchanged"
              role="status"
              data-restore-unchanged
            >
              {{ t('history.restore.unchanged', { resource: resourceName }) }}
            </p>
            <template v-else>
              <p
                data-restore-summary
                :data-after-change="afterChange || undefined"
              >
                {{ summaryText }}
              </p>
              <p
                v-if="missing"
                data-restore-recreates
              >
                {{ resource.kind === 'view' ? t('history.restore.recreatesView') : t('history.restore.recreates') }}
              </p>
              <p
                v-else-if="resource.kind === 'view'"
                data-restore-decisions
              >
                {{ t('history.restore.keepsDecisions') }}
              </p>
              <p
                v-else-if="resource.kind === 'workspace'"
              >
                {{ t('history.restore.keepsSchema') }}
              </p>
              <p class="text-muted">
                {{ t('history.restore.impactNote') }}
              </p>
            </template>
            <USkeleton
              v-if="reading || unchanged === undefined"
              class="h-4 w-48"
              :aria-label="t('history.restore.reading')"
            />
          </div>

          <div
            v-else
            ref="stageRegion"
            tabindex="-1"
            class="space-y-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--ui-primary)"
          >
            <template v-if="stage === 'impact'">
              <p class="text-sm text-default">
                {{ t('history.restore.impact.body', { resource: resourceName, version: versionName }) }}
              </p>
              <p class="text-xs font-medium text-muted">
                {{ t('history.restore.impact.count', impacts.length) }}
              </p>
              <section
                v-for="entry in groups"
                :key="entry.group"
                class="space-y-1"
                :data-impact-group="entry.group"
              >
                <h3 class="text-xs font-medium text-highlighted">
                  {{ groupLabel(entry.group) }}
                </h3>
                <ul class="space-y-1">
                  <li
                    v-for="(item, index) in entry.items"
                    :key="index"
                    class="rounded-md border border-default px-2 py-1.5 text-xs text-default"
                    :title="impactIds(item)"
                    data-impact-item
                    :data-category="item.category"
                  >
                    {{ describeImpact(item) }}
                  </li>
                </ul>
              </section>
            </template>

            <UAlert
              v-else-if="stage === 'conflict'"
              color="warning"
              variant="subtle"
              icon="i-lucide-git-compare-arrows"
              role="alert"
              :title="t('history.restore.conflict.title', { resource: resourceName })"
              :description="t('history.restore.conflict.body')"
              data-restore-conflict
            />

            <UAlert
              v-else-if="stage === 'locked'"
              color="warning"
              variant="subtle"
              icon="i-lucide-lock"
              role="alert"
              :title="t('history.restore.locked.title', { nickname: error?.lock?.holder.nickname ?? '?', resource: resourceName, time: lockUntil })"
              :description="t('history.restore.locked.body')"
              data-restore-locked
            />

            <UAlert
              v-else
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              role="alert"
              :title="t(`history.restore.refused.${refusedStatus}`)"
              :data-restore-refused="refusedStatus"
              :data-code="error?.code"
            >
              <template #description>
                <WbErrorDescription
                  :headline="t(`history.restore.refused.${refusedStatus}`)"
                  :lead="error?.message"
                  :diagnostics="error?.diagnostics ?? []"
                  :status-code="error?.statusCode"
                />
              </template>
            </UAlert>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            ref="cancelButton"
            color="neutral"
            variant="outline"
            :disabled="submitting"
            :label="stage === 'confirm' || stage === 'impact' ? t('common.cancel') : t('common.close')"
            data-restore-cancel
            @click="open = false"
          />
          <UButton
            v-if="stage === 'confirm'"
            color="primary"
            variant="solid"
            icon="i-lucide-history"
            :loading="submitting"
            :disabled="reading || expectedRevision === undefined || unchanged !== false"
            :label="t('history.restore.confirm')"
            data-restore-confirm
            @click="restore(false)"
          />
          <UButton
            v-else-if="stage === 'impact'"
            color="primary"
            variant="solid"
            icon="i-lucide-history"
            :loading="submitting"
            :label="t('history.restore.impact.confirm')"
            data-restore-acknowledge
            @click="restore(true)"
          />
          <UButton
            v-else-if="stage === 'conflict' || stage === 'locked' || (stage === 'refused' && readFailed)"
            color="primary"
            variant="solid"
            icon="i-lucide-refresh-cw"
            :loading="reading"
            :label="stage === 'conflict' ? t('history.restore.conflict.reload') : t('common.retry')"
            data-restore-reload
            @click="reload"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
