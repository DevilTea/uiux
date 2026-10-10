<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n, useToast } from '#imports'
import { CHECKPOINT_NAME_MAX_LENGTH, CHECKPOINT_NOTE_MAX_LENGTH } from '../../../src/domain/history/constants'
import { isValidCheckpointNote, normalizeCheckpointName } from '../../../src/domain/history/schema'
import { useAccess } from '../../composables/useAccess'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { notifyHistoryChanged } from '../../composables/useVersionHistory'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { describeFetchError, isTransientError, type FetchErrorDetails } from '../../utils/fetch-error'
import { focusFirstProblem } from '../../utils/focus-problem'
import AuthoringErrorAlert from '../workspace/AuthoringErrorAlert.vue'

/**
 * Create Checkpoint (Rule 01a11a5e-0c71-78d1-9adb-14db6c67ab9c): a name of 1 to 120 characters and
 * an optional note of up to 2,000 (Clause 01a11a5e-2272-795d-8806-1dedf74f7e21), sent to
 * `POST /api/history/checkpoints`. A Checkpoint needs no edit lease, but the dialog warns while
 * another member holds one (Rule 01a11a5e-0cc5-7548-ab99-8894c2e0dce4): humans never hold leases,
 * so every lease listed is someone else's. A `503 history.boundary_failed` wrote nothing and is
 * offered again as is.
 */
const shell = useWorkbenchShell()
const open = shell.checkpointOpen
const { t } = useI18n()
const toast = useToast()
const access = useAccess()
const labels = useHistoryLabels()

const name = ref('')
const note = ref('')
const touched = ref(false)
const creating = ref(false)
const error = shallowRef<FetchErrorDetails>()
const retryable = computed(() => !!error.value && isTransientError(error.value))

let stopLocks: (() => void) | undefined
watch(open, (value) => {
	if (value) {
		name.value = ''
		note.value = ''
		touched.value = false
		error.value = undefined
		// Starting the watch reads the leases at once; a running watch read them at most 5 s ago.
		stopLocks ??= access.watchLocks()
	}
	else {
		stopLocks?.()
		stopLocks = undefined
	}
})
onBeforeUnmount(() => stopLocks?.())

const leases = computed(() => access.locks.value.filter(lease => Date.parse(lease.expiresAt) > Date.now()))

const nameError = computed(() => {
	if (!touched.value) return undefined
	if (!name.value.trim()) return t('history.checkpoint.nameRequired')
	if (!normalizeCheckpointName(name.value)) return t('history.checkpoint.nameTooLong', { max: CHECKPOINT_NAME_MAX_LENGTH })
	return undefined
})
const noteError = computed(() => isValidCheckpointNote(note.value) ? undefined : t('history.checkpoint.noteTooLong', { max: CHECKPOINT_NOTE_MAX_LENGTH }))

async function create(): Promise<void> {
	touched.value = true
	if (nameError.value || noteError.value) {
		void focusFirstProblem('[data-checkpoint-dialog]')
		return
	}
	if (creating.value) return
	creating.value = true
	error.value = undefined
	const checkpointName = normalizeCheckpointName(name.value)!
	try {
		await $fetch('/api/history/checkpoints', { method: 'POST', body: { name: checkpointName, ...(note.value.trim() ? { note: note.value } : {}) } })
		open.value = false
		notifyHistoryChanged()
		toast.add({ title: t('history.checkpoint.created', { name: checkpointName }), color: 'success', icon: 'i-lucide-flag' })
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('history.checkpoint.failed'))
	}
	finally {
		creating.value = false
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('history.checkpoint.title')"
    :description="t('history.checkpoint.description')"
  >
    <template #body>
      <form
        class="flex flex-col gap-4"
        novalidate
        data-checkpoint-dialog
        @submit.prevent="create"
      >
        <UAlert
          v-if="leases.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('history.checkpoint.leaseTitle')"
          data-checkpoint-lease-warning
        >
          <template #description>
            <p>{{ t('history.checkpoint.leaseBody') }}</p>
            <ul class="mt-1 space-y-0.5">
              <li
                v-for="lease in leases"
                :key="`${lease.kind}:${lease.key}`"
                class="flex flex-wrap items-center gap-x-1.5"
              >
                <UIcon
                  :name="lease.holder.kind === 'agent' ? 'i-lucide-bot' : 'i-lucide-user'"
                  class="size-3.5"
                />
                <span class="font-medium">{{ lease.holder.nickname }}</span>
                <span>{{ labels.kindLabel(lease.kind) }} · {{ labels.resourceName(lease) }}</span>
              </li>
            </ul>
          </template>
        </UAlert>
        <UFormField
          :label="t('history.checkpoint.name')"
          :help="t('history.checkpoint.nameHelp', { max: CHECKPOINT_NAME_MAX_LENGTH })"
          :error="nameError"
          required
        >
          <UInput
            v-model="name"
            autofocus
            :maxlength="CHECKPOINT_NAME_MAX_LENGTH + 20"
            :aria-invalid="!!nameError || undefined"
            class="w-full"
            data-checkpoint-name
            @blur="touched = true"
          />
        </UFormField>
        <UFormField
          :label="t('history.checkpoint.note')"
          :help="t('history.checkpoint.noteHelp', { max: CHECKPOINT_NOTE_MAX_LENGTH })"
          :error="noteError"
        >
          <UTextarea
            v-model="note"
            autoresize
            :rows="3"
            :maxrows="8"
            :aria-invalid="!!noteError || undefined"
            class="w-full"
            data-checkpoint-note
          />
        </UFormField>
        <UAlert
          v-if="error && retryable"
          color="warning"
          variant="subtle"
          icon="i-lucide-refresh-cw"
          :title="error.message"
          :description="t('history.checkpoint.retryable')"
          :actions="[{ label: t('common.retry'), size: 'xs', color: 'warning', variant: 'outline', loading: creating, onClick: () => { void create() } }]"
          data-checkpoint-retry
        />
        <AuthoringErrorAlert
          v-else-if="error"
          :title="t('history.checkpoint.failed')"
          :error="error"
          @close="error = undefined"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          @click="open = false"
        />
        <UButton
          color="primary"
          variant="solid"
          icon="i-lucide-flag"
          :loading="creating"
          :label="t('history.checkpoint.submit')"
          data-checkpoint-submit
          @click="create"
        />
      </div>
    </template>
  </UModal>
</template>
