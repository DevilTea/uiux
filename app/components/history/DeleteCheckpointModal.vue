<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n, useToast } from '#imports'
import type { VersionListItem } from '../../../src/application/services/history-service'
import { forgetVersionRecord, notifyHistoryChanged } from '../../composables/useVersionHistory'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * The explicit confirmation of the Activity timeline's Delete row action (Rule
 * 01a11e0d-da2f-718f-b3c3-acf2f11fb683): `DELETE /api/history/checkpoints/:id` runs only after
 * Delete is pressed here; focus starts on Cancel. A record this build cannot read is never deleted
 * (owner ruling https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18835031): the
 * server's `history.record_invalid` refusal is explained in place, without another Delete.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ version?: VersionListItem }>()
const emit = defineEmits<{ deleted: [id: string] }>()
const { t } = useI18n()
const toast = useToast()

const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')
/** Focus starts on Cancel, the safe choice; the dialog's own autofocus would land on its close button. */
function focusCancel(event: Event): void {
	event.preventDefault()
	cancelButton.value?.$el?.focus()
}

const deleting = ref(false)
const error = shallowRef<FetchErrorDetails>()
const invalidRecord = computed(() => error.value?.code === 'history.record_invalid')
const name = computed(() => props.version?.name ?? '')

watch(open, (value) => { if (value) error.value = undefined })

async function confirm(): Promise<void> {
	const version = props.version
	if (!version || deleting.value) return
	deleting.value = true
	error.value = undefined
	try {
		await $fetch(`/api/history/checkpoints/${encodeURIComponent(version.id)}`, { method: 'DELETE' })
		forgetVersionRecord(version.id)
		open.value = false
		notifyHistoryChanged()
		emit('deleted', version.id)
		toast.add({ title: t('history.delete.deleted', { name: name.value }), color: 'success', icon: 'i-lucide-check' })
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('history.delete.failed'))
	}
	finally {
		deleting.value = false
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('history.delete.title')"
    :dismissible="!deleting"
    :content="{ onOpenAutoFocus: focusCancel }"
  >
    <template #body>
      <div
        class="space-y-3"
        data-delete-checkpoint-dialog
      >
        <p class="text-sm text-default">
          {{ t('history.delete.body', { name }) }}
        </p>
        <UAlert
          v-if="invalidRecord"
          color="warning"
          variant="subtle"
          icon="i-lucide-file-warning"
          :title="t('history.invalid.notDeletable')"
          :description="t('history.invalid.explanation')"
          data-delete-invalid
        />
        <UAlert
          v-else-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="error.message"
          role="alert"
        >
          <template #description>
            <WbErrorDescription
              :headline="error.message"
              :diagnostics="error.diagnostics"
              :status-code="error.statusCode"
            />
          </template>
        </UAlert>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          ref="cancelButton"
          color="neutral"
          variant="outline"
          :disabled="deleting"
          :label="t('common.cancel')"
          data-delete-cancel
          @click="open = false"
        />
        <UButton
          v-if="!invalidRecord"
          color="error"
          variant="soft"
          icon="i-lucide-trash-2"
          :loading="deleting"
          :label="t('history.delete.confirm')"
          data-delete-confirm
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
