<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n, useToast } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { classifyAcknowledgedWriteAnswer, DELETE_ROUTES, failureOf, type DeletableKind } from '../../utils/impact-acknowledge'
import type { ReceivedImpact } from '../../utils/version-restore'
import ImpactList from './ImpactList.vue'
import WbErrorDescription from './WbErrorDescription.vue'

/**
 * "Delete" for a View, UX Flow or authored Asset (Rule 01a1144e-50dd-7b92-aa5e-e175e34bf424; Clause
 * 01a172ce-ebcc-7a79-8103-ff5339409948). Opening the dialog reads the resource's current revision,
 * the `expectedRevision` of the write, so a change made after the dialog opened conflicts instead of
 * being deleted over. The first request carries no acknowledgement: with a non-empty impact the server
 * deletes nothing and the dialog lists the impact by group (Rule 01a172ce-31eb-7b81-afd6-ddd6855cc30e),
 * deleting only after the explicit "Delete anyway", which resends with `acknowledgeImpact: true`.
 * Nothing that refers to the resource is changed; the references report as dangling afterwards.
 * Focus starts on Cancel; each later state moves focus to its own text so it is read out.
 */
const props = defineProps<{
	kind: DeletableKind
	resourceKey: string
	/** The resource's display name. */
	name: string
}>()
const emit = defineEmits<{ deleted: [] }>()

const { t, locale } = useI18n()
const toast = useToast()
const uiux = useUiuxClient()
const workbench = useWorkbench()

type Stage = 'confirm' | 'impact' | 'conflict' | 'locked' | 'refused'
const open = ref(false)
const stage = ref<Stage>('confirm')
const reading = ref(false)
const submitting = ref(false)
/** The revision the write expects; `undefined` until read. */
const expectedRevision = ref<string>()
const impacts = shallowRef<readonly ReceivedImpact[]>([])
const error = shallowRef<FetchErrorDetails>()
const refusedStatus = ref<'invalid' | 'not_found' | 'blocked' | 'denied' | 'failed'>('failed')
const readFailed = ref(false)

const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')
const stageRegion = useTemplateRef<HTMLElement>('stageRegion')

const dialogTitle = computed(() => stage.value === 'impact' ? t('deleteResource.impact.title') : t(`deleteResource.title.${props.kind}`))
const lockUntil = computed(() => {
	const expiresAt = error.value?.lock ? Date.parse(error.value.lock.expiresAt) : Number.NaN
	return Number.isFinite(expiresAt)
		? new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(expiresAt))
		: '–'
})

function focusCancel(event: Event): void {
	event.preventDefault()
	cancelButton.value?.$el?.focus()
}

function enter(next: Stage): void {
	stage.value = next
	void nextTick(() => stageRegion.value?.focus())
}

async function readCurrent(): Promise<void> {
	reading.value = true
	readFailed.value = false
	expectedRevision.value = undefined
	try {
		const read = await uiux.readResource<{ revision?: string }>(props.kind, props.resourceKey)
		if (read?.revision) {
			expectedRevision.value = read.revision
			return
		}
		error.value = undefined
		refusedStatus.value = 'not_found'
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('deleteResource.readFailed', { name: props.name }))
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
	void readCurrent()
}

/** Back to the confirmation with the newest revision, after a conflict or a lease. */
async function reload(): Promise<void> {
	error.value = undefined
	impacts.value = []
	stage.value = 'confirm'
	void workbench.refreshAll()
	await readCurrent()
	if (stage.value === 'confirm') void nextTick(() => cancelButton.value?.$el?.focus())
}

async function remove(acknowledgeImpact: boolean): Promise<void> {
	if (submitting.value || reading.value || expectedRevision.value === undefined) return
	submitting.value = true
	error.value = undefined
	let status: number | undefined
	let body: unknown
	try {
		body = await $fetch(`/api/${DELETE_ROUTES[props.kind]}/${encodeURIComponent(props.resourceKey)}`, {
			method: 'DELETE',
			body: { expectedRevision: expectedRevision.value, ...(acknowledgeImpact ? { acknowledgeImpact: true } : {}) },
		})
		status = 200
	}
	catch (cause) {
		({ status, body } = failureOf(cause))
		error.value = describeFetchError(cause, t('deleteResource.refused.failed'))
		if (status === undefined) {
			refusedStatus.value = 'failed'
			submitting.value = false
			enter('refused')
			return
		}
	}
	submitting.value = false
	const answer = classifyAcknowledgedWriteAnswer(status, body)
	switch (answer.state) {
		case 'done':
			open.value = false
			void workbench.refreshAll()
			toast.add({ title: t('deleteResource.deleted', { name: props.name }), color: 'success', icon: 'i-lucide-trash-2' })
			emit('deleted')
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
			error.value = describeFetchError({ statusCode: status, data: body }, t(`deleteResource.refused.${answer.status}`))
			enter('refused')
	}
}
</script>

<template>
  <span class="inline-flex">
    <KitButton
      size="xs"
      variant="ghost"
      icon="trash-2"
      :label="t('deleteResource.action')"
      :aria-label="t('deleteResource.actionNamed', { name })"
      aria-haspopup="dialog"
      class="text-error!"
      data-delete-resource
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
          ref="stageRegion"
          tabindex="-1"
          class="space-y-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--ui-primary)"
          data-delete-dialog
          :data-stage="stage"
        >
          <p
            v-if="stage === 'confirm'"
            class="text-sm text-default"
          >
            {{ t(`deleteResource.body.${kind}`, { name }) }}
          </p>

          <template v-else-if="stage === 'impact'">
            <p class="text-sm text-default">
              {{ t('deleteResource.impact.body', { name }) }}
            </p>
            <p class="text-xs font-medium text-muted">
              {{ t('history.restore.impact.count', impacts.length) }}
            </p>
            <ImpactList :impacts="impacts" />
          </template>

          <UAlert
            v-else-if="stage === 'conflict'"
            color="warning"
            variant="subtle"
            icon="i-lucide-git-compare-arrows"
            role="alert"
            :title="t('deleteResource.conflict.title', { name })"
            :description="t('deleteResource.conflict.body')"
            data-delete-conflict
          />

          <UAlert
            v-else-if="stage === 'locked'"
            color="warning"
            variant="subtle"
            icon="i-lucide-lock"
            role="alert"
            :title="t('deleteResource.locked.title', { nickname: error?.lock?.holder.nickname ?? '?', name, time: lockUntil })"
            :description="t('deleteResource.locked.body')"
            data-delete-locked
          />

          <UAlert
            v-else
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            role="alert"
            :title="t(`deleteResource.refused.${refusedStatus}`)"
            :data-delete-refused="refusedStatus"
            :data-code="error?.code"
          >
            <template #description>
              <WbErrorDescription
                :headline="t(`deleteResource.refused.${refusedStatus}`)"
                :lead="error?.message"
                :diagnostics="error?.diagnostics ?? []"
                :status-code="error?.statusCode"
              />
            </template>
          </UAlert>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <KitButton
            ref="cancelButton"
            variant="outline"
            :disabled="submitting"
            :label="stage === 'confirm' || stage === 'impact' ? t('common.cancel') : t('common.close')"
            data-delete-cancel
            @click="open = false"
          />
          <KitButton
            v-if="stage === 'confirm'"
            variant="danger"
            icon="trash-2"
            :loading="submitting"
            :disabled="reading || expectedRevision === undefined"
            :label="t('deleteResource.confirm')"
            data-delete-confirm
            @click="remove(false)"
          />
          <KitButton
            v-else-if="stage === 'impact'"
            variant="danger"
            icon="trash-2"
            :loading="submitting"
            :label="t('deleteResource.impact.confirm')"
            data-delete-acknowledge
            @click="remove(true)"
          />
          <KitButton
            v-else-if="stage === 'conflict' || stage === 'locked' || (stage === 'refused' && readFailed)"
            variant="primary"
            icon="refresh-cw"
            :loading="reading"
            :label="stage === 'conflict' ? t('deleteResource.conflict.reload') : t('common.retry')"
            data-delete-reload
            @click="reload"
          />
        </div>
      </template>
    </UModal>
  </span>
</template>
