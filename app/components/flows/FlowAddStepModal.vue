<script setup lang="ts">
import { computed, reactive, useId, watch } from 'vue'
import { useI18n } from '#imports'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import { useWorkbench } from '../../composables/useWorkbench'
import { orderSteps } from '../../utils/flow-graph'

/**
 * Adds a step together with the transition that reaches it, so the draft never gains an unreachable
 * step (Discussion #6, item 8). The trigger is the source Widget plus its declared Event name.
 */
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ fromStepId?: string }>()
const emit = defineEmits<{
	(e: 'added', stepId: string): void
	/** After the dialog has closed and returned focus, so the page can move focus to the new step. */
	(e: 'settled', stepId: string): void
}>()

const { t } = useI18n()
const editor = injectFlowEditor()
const workbench = useWorkbench()
const formId = useId()
const BASE_VARIANT = '__uiux_base_variant__'

const state = reactive({ fromStepId: '', widgetId: '', event: '', viewId: '', variant: BASE_VARIANT })

watch(open, (isOpen) => {
	if (!isOpen) return
	const draft = editor.draft.value
	state.fromStepId = props.fromStepId && draft?.steps[props.fromStepId] ? props.fromStepId : draft?.entryStepId ?? ''
	state.widgetId = ''
	state.event = ''
	state.viewId = ''
	state.variant = BASE_VARIANT
})

const fromItems = computed(() => {
	const draft = editor.draft.value
	if (!draft) return []
	return orderSteps(draft).order.map((id, index) => ({ label: t('flows.inspector.stepOption', { n: index + 1, step: editor.stepLabel(id) }), value: id }))
})

const fromViewId = computed(() => editor.draft.value?.steps[state.fromStepId]?.target.viewId ?? '')
const widgetItems = computed(() => [...editor.viewWidgets(fromViewId.value)].map(([id, type]) => ({ label: `#${id}`, description: type, value: id })))
const viewItems = computed(() => workbench.views.value.map(view => ({ label: view.summary.name || view.key, value: view.key })))
const variantItems = computed(() => [
	{ label: t('ctx.base'), value: BASE_VARIANT },
	...editor.viewVariants(state.viewId).map(name => ({ label: name, value: name })),
])

watch(() => state.fromStepId, () => { state.widgetId = '' })
watch(() => state.viewId, (viewId) => {
	state.variant = BASE_VARIANT
	editor.requestViewFacts(viewId)
})

function validate(values: Partial<typeof state>) {
	const errors: Array<{ name: string; message: string }> = []
	if (!values.widgetId) errors.push({ name: 'widgetId', message: t('flows.addStep.widgetRequired') })
	if (!values.event?.trim()) errors.push({ name: 'event', message: t('flows.addStep.eventRequired') })
	if (!values.viewId) errors.push({ name: 'viewId', message: t('flows.addStep.viewRequired') })
	return errors
}

function submit(): void {
	const stepId = editor.addStep({
		fromStepId: state.fromStepId,
		trigger: { widgetId: state.widgetId, event: state.event.trim() },
		viewId: state.viewId,
		...(state.variant !== BASE_VARIANT ? { variantName: state.variant } : {}),
	})
	if (!stepId) return
	addedStepId = stepId
	open.value = false
	emit('added', stepId)
}

let addedStepId: string | undefined
function onAfterLeave(): void {
	if (addedStepId) emit('settled', addedStepId)
	addedStepId = undefined
}

const widgetSearch = computed(() => ({ placeholder: t('flows.inspector.searchWidgets') }))
const viewSearch = computed(() => ({ placeholder: t('flows.inspector.searchViews') }))
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('flows.addStep.title')"
    :description="t('flows.addStep.description')"
    @after:leave="onAfterLeave"
  >
    <template #body>
      <UForm
        :id="formId"
        :state="state"
        :validate="validate"
        :validate-on="['change']"
        class="space-y-4"
        @submit="submit"
      >
        <fieldset class="space-y-3">
          <legend class="mb-2 text-xs font-medium text-muted">
            {{ t('flows.addStep.trigger') }}
          </legend>
          <UFormField
            name="fromStepId"
            :label="t('flows.addStep.from')"
          >
            <USelect
              v-model="state.fromStepId"
              :items="fromItems"
              class="w-full"
            />
          </UFormField>
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField
              name="widgetId"
              :label="t('flows.inspector.widget')"
              required
            >
              <USelectMenu
                v-model="state.widgetId"
                :items="widgetItems"
                value-key="value"
                :search-input="widgetSearch"
                :placeholder="t('flows.inspector.widgetPlaceholder')"
                class="w-full"
                :ui="{ base: 'font-mono', itemLabel: 'font-mono text-xs', itemDescription: 'text-xs' }"
              />
            </UFormField>
            <UFormField
              name="event"
              :label="t('flows.inspector.event')"
              required
            >
              <UInput
                v-model="state.event"
                :placeholder="t('flows.inspector.eventPlaceholder')"
                class="w-full"
                :ui="{ base: 'font-mono' }"
              />
            </UFormField>
          </div>
        </fieldset>
        <USeparator />
        <fieldset class="space-y-3">
          <legend class="mb-2 text-xs font-medium text-muted">
            {{ t('flows.addStep.newStep') }}
          </legend>
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField
              name="viewId"
              :label="t('flows.inspector.view')"
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
            <UFormField
              name="variant"
              :label="t('ctx.variant')"
            >
              <USelectMenu
                v-model="state.variant"
                :items="variantItems"
                value-key="value"
                :search-input="false"
                :disabled="!state.viewId"
                class="w-full"
              />
            </UFormField>
          </div>
        </fieldset>
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
          icon="i-lucide-plus"
          :label="t('flows.addStep.submit')"
        />
      </div>
    </template>
  </UModal>
</template>
