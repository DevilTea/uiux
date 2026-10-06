<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { focusFirstProblem } from '../../utils/focus-problem'
import WbDiagnosticList from '../workbench/WbDiagnosticList.vue'

/** `create_flow` from the Workbench: a name and the View of the entry step. */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ (e: 'created', flowId: string): void }>()

const { t } = useI18n()
const workbench = useWorkbench()
const feedback = useWorkbenchFeedback()
const formId = useId()

const state = reactive({ name: '', viewId: '' })
const creating = ref(false)
const failure = ref<FetchErrorDetails>()

watch(open, (isOpen) => {
	if (!isOpen) return
	state.name = ''
	state.viewId = workbench.lastViewId() && workbench.views.value.some(view => view.key === workbench.lastViewId())
		? workbench.lastViewId()!
		: workbench.views.value[0]?.key ?? ''
	failure.value = undefined
})

const viewItems = computed(() => workbench.views.value.map(view => ({ label: view.summary.name || view.key, value: view.key })))
const viewSearch = computed(() => ({ placeholder: t('flows.inspector.searchViews') }))

function validate(values: Partial<typeof state>) {
	const errors: Array<{ name: string; message: string }> = []
	if (!values.name?.trim()) errors.push({ name: 'name', message: t('flows.create.nameRequired') })
	if (!values.viewId) errors.push({ name: 'viewId', message: t('flows.create.viewRequired') })
	return errors
}

function newUuid(): string {
	return crypto.randomUUID()
}

async function submit(): Promise<void> {
	if (creating.value) return
	creating.value = true
	failure.value = undefined
	const entryStepId = newUuid()
	try {
		const result = await $fetch<{ key: string }>('/api/flows', {
			method: 'POST',
			body: {
				name: state.name.trim(),
				entryStepId,
				steps: { [entryStepId]: { target: { viewId: state.viewId }, transitions: [] } },
			},
		})
		open.value = false
		feedback.success(t('flows.create.created'))
		await workbench.refreshCounts()
		emit('created', result.key)
	}
	catch (cause) {
		failure.value = describeFetchError(cause, t('flows.create.failed'))
		void focusFirstProblem('[role="dialog"]')
	}
	finally {
		creating.value = false
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('flows.create.title')"
    :description="t('flows.create.description')"
  >
    <template #body>
      <UForm
        :id="formId"
        :state="state"
        :validate="validate"
        class="space-y-4"
        @submit="submit"
      >
        <UFormField
          name="name"
          :label="t('flows.inspector.name')"
          required
        >
          <UInput
            v-model="state.name"
            :placeholder="t('flows.create.namePlaceholder')"
            class="w-full"
            autofocus
          />
        </UFormField>
        <UFormField
          name="viewId"
          :label="t('flows.create.firstView')"
          :help="viewItems.length ? undefined : t('flows.create.noViews')"
          required
        >
          <USelectMenu
            v-model="state.viewId"
            :items="viewItems"
            value-key="value"
            :search-input="viewSearch"
            :placeholder="t('flows.addStep.viewPlaceholder')"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="failure.message"
        >
          <template
            v-if="failure.diagnostics.length"
            #description
          >
            <WbDiagnosticList
              :diagnostics="failure.diagnostics"
              :status-code="failure.statusCode"
            />
          </template>
        </UAlert>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="open = false"
        />
        <UButton
          type="submit"
          :form="formId"
          color="primary"
          variant="solid"
          :loading="creating"
          :label="t('flows.create.submit')"
        />
      </div>
    </template>
  </UModal>
</template>
