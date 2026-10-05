<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId } from 'vue'
import { useI18n } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'

interface FlowSummary {
	kind: 'flow'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string }
}


interface FlowTransition {
	trigger: { widgetId: string; event: string }
	targetStepId: string
}

interface FlowStep {
	target: { viewId: string; variantName?: string }
	transitions: FlowTransition[]
}

interface FlowResource {
	id: string
	name: string
	scenarioRef?: Record<string, unknown>
	entryStepId: string
	steps: Record<string, FlowStep>
}

interface FlowRead {
	kind: 'flow'
	key: string
	revision: string
	diagnostics: ReadonlyArray<{ code: string; path: string; message: string }>
	resource: FlowResource
}

const props = defineProps<{
	readOnly?: boolean
	availableViews?: ReadonlyArray<{ key: string; name?: string; summary?: { name?: string; feature?: string } }>
	currentViewId?: string
}>()

const uiux = useUiuxClient()
const { t } = useI18n()
const feedback = useWorkbenchFeedback()

const emit = defineEmits<{
	(e: 'selectView', viewId: string): void
	(e: 'changed'): void
}>()

const flows = ref<readonly FlowSummary[]>([])
const selectedFlowId = ref<string>('')
const selectedFlowData = ref<FlowRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const flowLoadSequence = ref(0)
const listError = ref<string>()
const detailError = ref<string>()
const saveError = ref<FetchErrorDetails>()

// Structured edit state
interface LocalStep {
	id: string
	viewId: string
	variantName: string
	transitions: Array<{ widgetId: string; event: string; targetStepId: string }>
}

const editName = ref('')
const editEntryStepId = ref('')
const localSteps = ref<LocalStep[]>([])
const saving = ref(false)
const conflict = ref(false)

function generateUuid(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0
			return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
		})
}

// Create modal / form
const createFormId = useId()
const isCreatingFlow = ref(false)
const createState = reactive({
	name: '',
	entryStepId: generateUuid(),
	viewId: '',
})
const createError = ref<FetchErrorDetails>()
const creating = ref(false)

function viewLabel(viewId: string): string {
	const view = props.availableViews?.find(item => item.key === viewId)
	if (!view) return t('flows.views.missing', { id: viewId })
	return view.summary?.name || view.name || view.key
}

/** View picker items; keeps an unknown current target visible instead of silently dropping it. */
function viewItems(currentViewId?: string) {
	const items = (props.availableViews ?? []).map(view => ({
		label: view.summary?.name || view.name || view.key,
		value: view.key,
	}))
	if (currentViewId && !items.some(item => item.value === currentViewId)) {
		items.push({ label: t('flows.views.missing', { id: currentViewId }), value: currentViewId })
	}
	return items
}

const stepItems = computed(() =>
	localSteps.value
		.filter(step => step.id)
		.map((step, index) => ({
			label: t('flows.steps.optionLabel', { n: index + 1, view: step.viewId ? viewLabel(step.viewId) : t('flows.views.none') }),
			description: step.id,
			value: step.id,
		})),
)

const flowItems = computed(() =>
	flows.value.map(flow => ({
		label: flow.summary.name || t('flows.list.unnamed'),
		value: flow.key,
		diagnosticCount: flow.diagnosticCount,
	})),
)

const viewSearchInput = computed(() => ({ placeholder: t('flows.views.search') }))

async function fetchFlows() {
	loadingList.value = true
	listError.value = undefined
	try {
		const res = await uiux.listResources<FlowSummary>(['flow'], { limit: 100 })
		flows.value = res.items
		if (!selectedFlowId.value && res.items.length > 0) {
			await selectFlow(res.items[0]!.key)
		}
		else if (selectedFlowId.value) {
			await loadSelectedFlowDetail()
		}
	}
	catch (err: unknown) {
		listError.value = describeFetchError(err, t('flows.list.loadFailed')).message
	}
	finally {
		loadingList.value = false
	}
}

async function selectFlow(id: string | undefined) {
	if (!id) return
	selectedFlowId.value = id
	conflict.value = false
	saveError.value = undefined
	await loadSelectedFlowDetail()
}

async function loadSelectedFlowDetail() {
	const currentSeq = ++flowLoadSequence.value
	const id = selectedFlowId.value
	detailError.value = undefined
	if (!id) {
		selectedFlowData.value = undefined
		localSteps.value = []
		return
	}

	loadingDetail.value = true
	try {
		const data = await uiux.readResource<FlowRead>('flow', id)
		if (!data) throw new Error(t('flows.detail.unavailable'))
		if (flowLoadSequence.value !== currentSeq) return
		selectedFlowData.value = data
		editName.value = data.resource.name || ''
		editEntryStepId.value = data.resource.entryStepId || ''

		localSteps.value = Object.entries(data.resource.steps || {}).map(([stepId, s]) => ({
			id: stepId,
			viewId: s.target?.viewId || '',
			variantName: s.target?.variantName || '',
			transitions: (s.transitions || []).map(tr => ({
				widgetId: tr.trigger?.widgetId || '',
				event: tr.trigger?.event || 'click',
				targetStepId: tr.targetStepId || '',
			})),
		}))
	}
	catch (err: unknown) {
		if (flowLoadSequence.value !== currentSeq) return
		detailError.value = describeFetchError(err, t('flows.detail.loadFailed')).message
		selectedFlowData.value = undefined
		localSteps.value = []
	}
	finally {
		if (flowLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

async function reloadAfterConflict() {
	conflict.value = false
	saveError.value = undefined
	await loadSelectedFlowDetail()
}

function addStep() {
	if (props.readOnly) return
	const stepId = generateUuid()
	const defaultViewId = props.currentViewId || props.availableViews?.[0]?.key || ''
	localSteps.value.push({
		id: stepId,
		viewId: defaultViewId,
		variantName: '',
		transitions: [],
	})
	if (!editEntryStepId.value) {
		editEntryStepId.value = stepId
	}
}

function removeStep(index: number) {
	if (props.readOnly) return
	const removed = localSteps.value[index]
	localSteps.value.splice(index, 1)
	if (removed && editEntryStepId.value === removed.id) {
		editEntryStepId.value = localSteps.value[0]?.id || ''
	}
}

function addTransition(step: LocalStep) {
	if (props.readOnly) return
	const availableTargets = localSteps.value.filter(s => s.id !== step.id)
	step.transitions.push({
		widgetId: 'root',
		event: 'click',
		targetStepId: availableTargets[0]?.id || step.id,
	})
}

function removeTransition(step: LocalStep, trIdx: number) {
	if (props.readOnly) return
	step.transitions.splice(trIdx, 1)
}

async function handleSaveFlow() {
	if (props.readOnly) return
	if (!selectedFlowData.value) return
	saving.value = true
	saveError.value = undefined
	conflict.value = false

	const stepsRecord: Record<string, FlowStep> = {}
	for (const s of localSteps.value) {
		const key = s.id.trim()
		if (key) {
			stepsRecord[key] = {
				target: {
					viewId: s.viewId.trim(),
					...(s.variantName.trim() ? { variantName: s.variantName.trim() } : {}),
				},
				transitions: s.transitions
					.filter(tr => tr.widgetId.trim() && tr.targetStepId.trim())
					.map(tr => ({
						trigger: { widgetId: tr.widgetId.trim(), event: tr.event.trim() || 'click' },
						targetStepId: tr.targetStepId.trim(),
					})),
			}
		}
	}

	try {
		await $fetch(`/api/flows/${encodeURIComponent(selectedFlowData.value.key)}`, {
			method: 'PUT',
			body: {
				expectedRevision: selectedFlowData.value.revision,
				// Workspace data fallback, intentionally not localized.
				name: editName.value.trim() || 'UX Flow',
				entryStepId: editEntryStepId.value.trim() || localSteps.value[0]?.id || 'step-1',
				steps: stepsRecord,
			},
		})
		feedback.success(t('flows.save.saved'))
		emit('changed')
		await fetchFlows()
	}
	catch (err: unknown) {
		const details = describeFetchError(err, t('flows.save.failed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			conflict.value = true
		}
		else {
			saveError.value = feedback.error(err, t('flows.save.failed'))
		}
	}
	finally {
		saving.value = false
	}
}

function openCreateFlow() {
	if (props.readOnly) return
	createState.name = ''
	createState.entryStepId = generateUuid()
	createState.viewId = props.currentViewId || props.availableViews?.[0]?.key || ''
	createError.value = undefined
	isCreatingFlow.value = true
}

function validateCreate(state: Partial<typeof createState>) {
	const errors: Array<{ name: string; message: string }> = []
	if (!state.name?.trim()) errors.push({ name: 'name', message: t('flows.create.nameRequired') })
	if (!state.viewId) errors.push({ name: 'viewId', message: t('flows.create.viewRequired') })
	return errors
}

async function handleCreateFlow() {
	if (props.readOnly) return
	const name = createState.name.trim()
	const initialViewId = createState.viewId
	if (!name || !initialViewId) return
	creating.value = true
	createError.value = undefined

	const initialStepId = createState.entryStepId.trim() || generateUuid()

	try {
		const res = await $fetch<{ status: string; key: string }>('/api/flows', {
			method: 'POST',
			body: {
				name,
				entryStepId: initialStepId,
				steps: {
					[initialStepId]: {
						target: { viewId: initialViewId },
						transitions: [],
					},
				},
			},
		})
		isCreatingFlow.value = false
		feedback.success(t('flows.create.created'))
		emit('changed')
		await fetchFlows()
		if (res.key) await selectFlow(res.key)
	}
	catch (err: unknown) {
		createError.value = feedback.error(err, t('flows.create.failed'))
	}
	finally {
		creating.value = false
	}
}

onMounted(() => {
	fetchFlows()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-xs text-default">
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 border-b border-default p-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('flows.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('flows.subtitle') }}
        </p>
      </div>
      <UButton
        v-if="!readOnly"
        color="primary"
        variant="solid"
        size="xs"
        icon="i-lucide-plus"
        :label="t('flows.newFlow')"
        @click="openCreateFlow"
      />
    </div>

    <!-- Create Flow Modal -->
    <UModal
      v-if="!readOnly"
      v-model:open="isCreatingFlow"
      :title="t('flows.create.title')"
      :description="t('flows.create.description')"
    >
      <template #body>
        <UForm
          :id="createFormId"
          :state="createState"
          :validate="validateCreate"
          class="space-y-3"
          @submit="handleCreateFlow"
        >
          <UFormField
            name="name"
            :label="t('flows.fields.name')"
            required
          >
            <UInput
              v-model="createState.name"
              :placeholder="t('flows.fields.namePlaceholder')"
              class="w-full"
              autofocus
            />
          </UFormField>
          <UFormField
            name="viewId"
            :label="t('flows.fields.initialView')"
            :help="availableViews?.length ? undefined : t('flows.create.noViews')"
            required
          >
            <USelectMenu
              :model-value="createState.viewId || undefined"
              :items="viewItems(createState.viewId)"
              value-key="value"
              :search-input="viewSearchInput"
              :placeholder="t('flows.views.placeholder')"
              class="w-full"
              @update:model-value="(value?: string) => { createState.viewId = value ?? '' }"
            />
          </UFormField>
          <UFormField
            name="entryStepId"
            :label="t('flows.fields.entryStepId')"
            :help="t('flows.fields.entryStepIdHelp')"
          >
            <UInput
              v-model="createState.entryStepId"
              placeholder="step-1"
              class="w-full font-mono"
            />
          </UFormField>
          <UAlert
            v-if="createError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="createError.message"
          >
            <template
              v-if="createError.diagnostics.length"
              #description
            >
              <ul class="list-disc space-y-0.5 ps-4">
                <li
                  v-for="(diag, dIdx) in createError.diagnostics"
                  :key="dIdx"
                >
                  {{ diag.message }}
                </li>
              </ul>
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
            @click="isCreatingFlow = false"
          />
          <UButton
            type="submit"
            :form="createFormId"
            color="primary"
            :loading="creating"
            :label="t('flows.create.submit')"
          />
        </div>
      </template>
    </UModal>

    <!-- Flows List -->
    <div class="border-b border-default p-2">
      <UAlert
        v-if="listError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('flows.list.loadFailed')"
        :description="listError"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', onClick: fetchFlows }]"
        orientation="horizontal"
      />
      <UListbox
        v-else-if="flowItems.length"
        :model-value="selectedFlowId || undefined"
        :items="flowItems"
        value-key="value"
        selection-behavior="replace"
        size="sm"
        :aria-label="t('flows.list.label')"
        :ui="{
          root: 'ring-0 rounded-none',
          content: 'max-h-40',
          item: 'data-[state=checked]:text-selection data-[state=checked]:before:bg-selection-subtle',
          itemTrailingIcon: 'text-selection',
        }"
        @update:model-value="selectFlow"
      >
        <template #item-trailing="{ item }">
          <UBadge
            v-if="item.diagnosticCount"
            color="warning"
            variant="subtle"
            size="sm"
            icon="i-lucide-triangle-alert"
          >
            <span aria-hidden="true">{{ item.diagnosticCount }}</span>
            <span class="sr-only">{{ t('flows.diagnostics.count', item.diagnosticCount) }}</span>
          </UBadge>
        </template>
      </UListbox>
      <UEmpty
        v-else
        :loading="loadingList"
        icon="i-lucide-workflow"
        variant="naked"
        size="sm"
        :title="loadingList ? t('common.loading') : t('flows.list.empty')"
        :description="loadingList || readOnly ? undefined : t('flows.list.emptyHint')"
      />
    </div>

    <!-- Detail load failure -->
    <div
      v-if="detailError"
      class="p-3"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('flows.detail.loadFailed')"
        :description="detailError"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', onClick: loadSelectedFlowDetail }]"
      />
    </div>

    <!-- Active Flow Structured Editor -->
    <div
      v-if="selectedFlowData"
      class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-3"
    >
      <!-- Meta details -->
      <UCard
        variant="subtle"
        :ui="{ header: 'flex items-center justify-between gap-2 px-3 py-2 sm:px-3', body: 'space-y-3 p-3 sm:p-3' }"
      >
        <template #header>
          <span class="text-xs font-semibold text-muted">{{ t('flows.detail.metadata') }}</span>
          <UBadge
            color="neutral"
            variant="soft"
            size="sm"
            class="font-mono"
            :title="selectedFlowData.revision"
          >
            {{ t('flows.detail.revision', { revision: selectedFlowData.revision.slice(0, 12) }) }}
          </UBadge>
        </template>

        <UFormField
          :label="t('flows.fields.name')"
          size="xs"
        >
          <UInput
            v-model="editName"
            :disabled="readOnly"
            size="xs"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="t('flows.fields.entryStep')"
          size="xs"
        >
          <USelect
            :model-value="editEntryStepId || undefined"
            :items="stepItems"
            :disabled="readOnly || !stepItems.length"
            :placeholder="t('flows.fields.entryStepPlaceholder')"
            size="xs"
            class="w-full"
            @update:model-value="(value?: string) => { editEntryStepId = value ?? '' }"
          />
        </UFormField>
      </UCard>

      <!-- Conflict Banner -->
      <UAlert
        v-if="conflict"
        color="error"
        variant="subtle"
        icon="i-lucide-git-compare-arrows"
        :title="t('flows.conflict.title')"
        :description="t('flows.conflict.description')"
        :actions="[{ label: t('common.reload'), color: 'error', variant: 'outline', size: 'xs', onClick: reloadAfterConflict }]"
      />

      <UAlert
        v-else-if="saveError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="saveError.message"
        close
        @update:open="saveError = undefined"
      >
        <template
          v-if="saveError.diagnostics.length"
          #description
        >
          <ul class="list-disc space-y-0.5 ps-4">
            <li
              v-for="(diag, dIdx) in saveError.diagnostics"
              :key="dIdx"
            >
              <span
                v-if="diag.path"
                class="font-mono"
              >{{ diag.path }}</span>
              {{ diag.message }}
            </li>
          </ul>
        </template>
      </UAlert>

      <!-- Flow Diagnostics -->
      <UAlert
        v-if="selectedFlowData.diagnostics?.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('flows.diagnostics.count', selectedFlowData.diagnostics.length)"
      >
        <template #description>
          <ul class="space-y-1">
            <li
              v-for="diag in selectedFlowData.diagnostics"
              :key="diag.code + diag.path"
            >
              <span class="font-mono font-medium">{{ diag.code }}</span>
              {{ diag.message }}
            </li>
          </ul>
        </template>
      </UAlert>

      <!-- Steps Graph / List -->
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <span class="font-semibold text-highlighted">{{ t('flows.steps.title') }}</span>
          <div class="flex items-center gap-2">
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
            >
              {{ t('flows.steps.count', localSteps.length) }}
            </UBadge>
            <UButton
              v-if="!readOnly"
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              :label="t('flows.steps.add')"
              @click="addStep"
            />
          </div>
        </div>

        <div
          v-if="localSteps.length"
          class="space-y-3"
        >
          <UCard
            v-for="(step, sIdx) in localSteps"
            :key="step.id"
            variant="outline"
            :class="editEntryStepId === step.id ? 'ring-selection' : ''"
            :ui="{ header: 'flex items-center justify-between gap-2 px-3 py-2 sm:px-3', body: 'space-y-3 p-3 sm:p-3' }"
          >
            <!-- Step Header -->
            <template #header>
              <div class="flex min-w-0 items-center gap-1.5">
                <UBadge
                  color="neutral"
                  variant="soft"
                  size="sm"
                >
                  {{ t('flows.steps.ordinal', { n: sIdx + 1 }) }}
                </UBadge>
                <UBadge
                  v-if="editEntryStepId === step.id"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-flag"
                >
                  {{ t('flows.steps.entry') }}
                </UBadge>
                <span
                  class="truncate font-mono text-xs text-dimmed"
                  :title="step.id"
                >{{ step.id }}</span>
              </div>
              <UTooltip
                v-if="!readOnly"
                :text="t('flows.steps.remove')"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-trash-2"
                  :aria-label="t('flows.steps.remove')"
                  @click="removeStep(sIdx)"
                />
              </UTooltip>
            </template>

            <!-- Target View & Variant -->
            <UFormField
              :label="t('flows.fields.targetView')"
              size="xs"
            >
              <USelectMenu
                :model-value="step.viewId || undefined"
                :items="viewItems(step.viewId)"
                value-key="value"
                :search-input="viewSearchInput"
                :disabled="readOnly"
                :placeholder="t('flows.views.placeholder')"
                size="xs"
                class="w-full"
                @update:model-value="(value?: string) => { step.viewId = value ?? '' }"
              />
              <UButton
                v-if="step.viewId"
                color="neutral"
                variant="link"
                size="xs"
                icon="i-lucide-eye"
                class="mt-1 px-0"
                :label="t('flows.steps.previewView')"
                @click="emit('selectView', step.viewId)"
              />
            </UFormField>

            <UFormField
              :label="t('flows.fields.variant')"
              :hint="t('flows.fields.optional')"
              size="xs"
            >
              <UInput
                v-model="step.variantName"
                :disabled="readOnly"
                size="xs"
                :placeholder="t('flows.fields.variantPlaceholder')"
                class="w-full"
              />
            </UFormField>

            <USeparator />

            <!-- Transitions from this step -->
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-muted">{{ t('flows.transitions.count', step.transitions.length) }}</span>
                <UButton
                  v-if="!readOnly"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-plus"
                  :label="t('flows.transitions.add')"
                  @click="addTransition(step)"
                />
              </div>

              <div
                v-if="step.transitions.length"
                class="space-y-2"
              >
                <div
                  v-for="(tr, trIdx) in step.transitions"
                  :key="trIdx"
                  class="space-y-2 rounded-md bg-elevated/50 p-2"
                >
                  <div class="grid grid-cols-2 gap-2">
                    <UFormField
                      :label="t('flows.fields.event')"
                      size="xs"
                    >
                      <UInput
                        v-model="tr.event"
                        :disabled="readOnly"
                        size="xs"
                        placeholder="click"
                        class="w-full font-mono"
                      />
                    </UFormField>
                    <UFormField
                      :label="t('flows.fields.widgetId')"
                      size="xs"
                    >
                      <UInput
                        v-model="tr.widgetId"
                        :disabled="readOnly"
                        size="xs"
                        placeholder="root"
                        class="w-full font-mono"
                      />
                    </UFormField>
                  </div>
                  <div class="flex items-end gap-1.5">
                    <UFormField
                      :label="t('flows.fields.targetStep')"
                      size="xs"
                      class="min-w-0 flex-1"
                    >
                      <USelect
                        :model-value="tr.targetStepId || undefined"
                        :items="stepItems"
                        :disabled="readOnly"
                        :placeholder="t('flows.fields.targetStepPlaceholder')"
                        size="xs"
                        class="w-full"
                        @update:model-value="(value?: string) => { tr.targetStepId = value ?? '' }"
                      />
                    </UFormField>
                    <UTooltip
                      v-if="!readOnly"
                      :text="t('flows.transitions.remove')"
                    >
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-lucide-x"
                        :aria-label="t('flows.transitions.remove')"
                        @click="removeTransition(step, trIdx)"
                      />
                    </UTooltip>
                  </div>
                </div>
              </div>
              <p
                v-else
                class="py-1 text-center text-xs text-dimmed"
              >
                {{ t('flows.transitions.terminal') }}
              </p>
            </div>
          </UCard>
        </div>

        <UEmpty
          v-else
          icon="i-lucide-list-plus"
          size="sm"
          :title="t('flows.steps.empty')"
          :description="readOnly ? undefined : t('flows.steps.emptyHint')"
        />
      </div>

      <!-- Save Actions -->
      <div
        v-if="!readOnly"
        class="flex justify-end border-t border-default pt-3"
      >
        <UButton
          color="primary"
          variant="solid"
          size="sm"
          icon="i-lucide-save"
          :loading="saving"
          :label="saving ? t('common.saving') : t('flows.save.submit')"
          @click="handleSaveFlow"
        />
      </div>
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList && !detailError && flowItems.length"
      class="flex flex-1 items-center justify-center p-3"
    >
      <UEmpty
        :loading="loadingDetail"
        icon="i-lucide-mouse-pointer-click"
        variant="naked"
        size="sm"
        :title="t('flows.detail.selectTitle')"
        :description="t('flows.detail.selectDescription')"
      />
    </div>
  </div>
</template>
