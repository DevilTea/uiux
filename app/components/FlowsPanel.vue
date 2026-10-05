<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'

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

const emit = defineEmits<{
	(e: 'selectView', viewId: string): void
}>()

const flows = ref<readonly FlowSummary[]>([])
const selectedFlowId = ref<string>('')
const selectedFlowData = ref<FlowRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const flowLoadSequence = ref(0)
const error = ref<string>()

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
const saveSuccess = ref(false)

function generateUuid(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0
			return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
		})
}

// Create modal / form
const isCreatingFlow = ref(false)
const newFlowName = ref('')
const newEntryStepId = ref(generateUuid())
const createError = ref<string>()
const creating = ref(false)

async function fetchFlows() {
	loadingList.value = true
	error.value = undefined
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
		error.value = err instanceof Error ? err.message : 'Failed to fetch flows'
	}
	finally {
		loadingList.value = false
	}
}

async function selectFlow(id: string) {
	selectedFlowId.value = id
	conflict.value = false
	saveSuccess.value = false
	error.value = undefined
	await loadSelectedFlowDetail()
}

async function loadSelectedFlowDetail() {
	const currentSeq = ++flowLoadSequence.value
	const id = selectedFlowId.value
	if (!id) {
		selectedFlowData.value = undefined
		localSteps.value = []
		return
	}

	loadingDetail.value = true
	try {
		const data = await uiux.readResource<FlowRead>('flow', id)
		if (!data) throw new Error('UX Flow is unavailable.')
		if (flowLoadSequence.value !== currentSeq) return
		selectedFlowData.value = data
		editName.value = data.resource.name || ''
		editEntryStepId.value = data.resource.entryStepId || ''

		localSteps.value = Object.entries(data.resource.steps || {}).map(([stepId, s]) => ({
			id: stepId,
			viewId: s.target?.viewId || '',
			variantName: s.target?.variantName || '',
			transitions: (s.transitions || []).map(t => ({
				widgetId: t.trigger?.widgetId || '',
				event: t.trigger?.event || 'click',
				targetStepId: t.targetStepId || '',
			})),
		}))
	}
	catch (err: unknown) {
		if (flowLoadSequence.value !== currentSeq) return
		error.value = err instanceof Error ? err.message : 'Failed to load flow detail'
		selectedFlowData.value = undefined
		localSteps.value = []
	}
	finally {
		if (flowLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
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
	error.value = undefined
	conflict.value = false
	saveSuccess.value = false

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
					.filter(t => t.widgetId.trim() && t.targetStepId.trim())
					.map(t => ({
						trigger: { widgetId: t.widgetId.trim(), event: t.event.trim() || 'click' },
						targetStepId: t.targetStepId.trim(),
					})),
			}
		}
	}

	try {
		await $fetch(`/api/flows/${encodeURIComponent(selectedFlowData.value.key)}`, {
			method: 'PUT',
			body: {
				expectedRevision: selectedFlowData.value.revision,
				name: editName.value.trim() || 'UX Flow',
				entryStepId: editEntryStepId.value.trim() || localSteps.value[0]?.id || 'step-1',
				steps: stepsRecord,
			},
		})
		saveSuccess.value = true
		await fetchFlows()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) {
			conflict.value = true
		}
		else {
			error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to save flow')
		}
	}
	finally {
		saving.value = false
	}
}

async function handleCreateFlow() {
	if (props.readOnly) return
	if (!newFlowName.value.trim()) {
		createError.value = 'Flow name is required.'
		return
	}
	creating.value = true
	createError.value = undefined

	const initialViewId = props.currentViewId || props.availableViews?.[0]?.key || ''
	if (!initialViewId) {
		createError.value = 'A valid View target is required for the initial step.'
		return
	}
	const initialStepId = newEntryStepId.value.trim() || generateUuid()

	try {
		const res = await $fetch<{ status: string; key: string }>('/api/flows', {
			method: 'POST',
			body: {
				name: newFlowName.value.trim(),
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
		newFlowName.value = ''
		await fetchFlows()
		if (res.key) await selectFlow(res.key)
	}
	catch (err: unknown) {
		const errorObj = err as { data?: { message?: string } }
		createError.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to create flow')
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
  <div class="flex h-full flex-col overflow-hidden text-xs text-neutral-200">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          UX Flows
        </h2>
        <p class="text-[11px] text-neutral-400">
          User journey step sequences and transitions
        </p>
      </div>
      <UButton
        v-if="!readOnly"
        color="primary"
        variant="solid"
        size="xs"
        @click="isCreatingFlow = !isCreatingFlow"
      >
        + New Flow
      </UButton>
    </div>

    <!-- Create Flow Inline Form -->
    <div
      v-if="isCreatingFlow && !readOnly"
      class="border-b border-neutral-800 bg-neutral-900/90 p-3 space-y-2.5"
    >
      <div class="flex items-center justify-between">
        <span class="font-semibold text-white">Create New UX Flow</span>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-300"
          @click="isCreatingFlow = false"
        >
          ✕
        </button>
      </div>
      <div>
        <span class="text-[10px] text-neutral-400">Flow Name:</span>
        <UInput
          v-model="newFlowName"
          :disabled="readOnly"
          size="xs"
          placeholder="e.g. User Signup Onboarding"
          class="mt-0.5"
        />
      </div>
      <div>
        <span class="text-[10px] text-neutral-400">Entry Step ID:</span>
        <UInput
          v-model="newEntryStepId"
          :disabled="readOnly"
          size="xs"
          placeholder="step-1"
          class="mt-0.5 font-mono"
        />
      </div>
      <p
        v-if="createError"
        class="text-[11px] text-red-400"
      >
        {{ createError }}
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          @click="isCreatingFlow = false"
        >
          Cancel
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          :loading="creating"
          @click="handleCreateFlow"
        >
          Create Flow
        </UButton>
      </div>
    </div>

    <!-- Flows List -->
    <div class="max-h-40 overflow-y-auto border-b border-neutral-800 p-2">
      <div
        v-if="flows.length"
        class="space-y-1"
      >
        <button
          v-for="flow in flows"
          :key="flow.key"
          type="button"
          class="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition"
          :class="selectedFlowId === flow.key ? 'bg-primary/20 text-white font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
          @click="selectFlow(flow.key)"
        >
          <span class="truncate">{{ flow.summary.name || 'Unnamed Flow' }}</span>
          <UBadge
            v-if="flow.diagnosticCount"
            color="warning"
            variant="soft"
            size="xs"
          >
            {{ flow.diagnosticCount }}
          </UBadge>
        </button>
      </div>
      <div
        v-else-if="!loadingList"
        class="py-4 text-center text-xs text-neutral-500"
      >
        No authored UX flows yet.
      </div>
    </div>

    <!-- Active Flow Structured Editor -->
    <div
      v-if="selectedFlowData"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-4"
    >
      <!-- Meta details -->
      <div class="rounded border border-neutral-800 bg-neutral-900/60 p-3 space-y-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Flow Metadata</span>
          <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            Rev: {{ selectedFlowData.revision.slice(0, 12) }}…
          </span>
        </div>

        <div>
          <span class="text-[10px] text-neutral-400">Flow Name:</span>
          <UInput
            v-model="editName"
            :disabled="readOnly"
            size="xs"
            class="mt-0.5"
          />
        </div>

        <div>
          <span class="text-[10px] text-neutral-400">Entry Step ID:</span>
          <select
            v-model="editEntryStepId"
            :disabled="readOnly"
            class="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200 outline-none"
          >
            <option
              v-for="s in localSteps"
              :key="s.id"
              :value="s.id"
            >
              {{ s.id }} (targets view {{ s.viewId.slice(0, 8) }}…)
            </option>
          </select>
        </div>
      </div>

      <!-- Conflict Banner -->
      <div
        v-if="conflict"
        class="border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-300 text-[11px] rounded flex items-center justify-between"
      >
        <span>⚠ Stale revision conflict: This flow was modified elsewhere.</span>
        <UButton
          color="warning"
          variant="soft"
          size="xs"
          @click="loadSelectedFlowDetail"
        >
          Reload
        </UButton>
      </div>

      <div
        v-else-if="saveSuccess"
        class="border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-300 text-[11px] rounded"
      >
        ✓ Flow saved successfully.
      </div>

      <div
        v-else-if="error"
        class="border border-red-500/30 bg-red-500/10 p-2 text-red-300 text-[11px] rounded"
      >
        {{ error }}
      </div>

      <!-- Flow Diagnostics -->
      <div
        v-if="selectedFlowData.diagnostics?.length"
        class="space-y-1"
      >
        <div
          v-for="diag in selectedFlowData.diagnostics"
          :key="diag.code + diag.path"
          class="rounded bg-amber-500/10 p-2 text-amber-300 text-[11px]"
        >
          <span class="font-mono font-medium">[{{ diag.code }}]</span> {{ diag.message }}
        </div>
      </div>

      <!-- Steps Graph / List -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-white">Steps & Transitions ({{ localSteps.length }})</span>
          <UButton
            v-if="!readOnly"
            color="neutral"
            variant="outline"
            size="xs"
            @click="addStep"
          >
            + Add Step
          </UButton>
        </div>

        <div
          v-if="localSteps.length"
          class="space-y-3"
        >
          <div
            v-for="(step, sIdx) in localSteps"
            :key="step.id"
            class="rounded border border-neutral-800 bg-neutral-900/70 p-3 space-y-2.5"
            :class="editEntryStepId === step.id ? 'ring-1 ring-primary/40' : ''"
          >
            <!-- Step Header -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                  Step: {{ step.id }}
                </span>
                <span
                  v-if="editEntryStepId === step.id"
                  class="rounded bg-primary/20 px-1 py-0.5 text-[9px] font-semibold text-primary-300 uppercase"
                >
                  entry
                </span>
              </div>
              <button
                v-if="!readOnly"
                type="button"
                class="text-neutral-500 hover:text-red-400 text-xs"
                @click="removeStep(sIdx)"
              >
                ✕ Remove Step
              </button>
            </div>

            <!-- Target View & Variant -->
            <div class="grid grid-cols-2 gap-2">
              <div>
                <span class="text-[10px] text-neutral-400">Target View:</span>
                <select
                  v-model="step.viewId"
                  :disabled="readOnly"
                  class="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none"
                >
                  <option
                    v-for="v in availableViews"
                    :key="v.key"
                    :value="v.key"
                  >
                    {{ v.name || v.key }}
                  </option>
                </select>
                <button
                  v-if="step.viewId"
                  type="button"
                  class="mt-1 text-[10px] text-primary-400 hover:underline"
                  @click="emit('selectView', step.viewId)"
                >
                  Preview this View ↗
                </button>
              </div>

              <div>
                <span class="text-[10px] text-neutral-400">Variant (Optional):</span>
                <UInput
                  v-model="step.variantName"
                  :disabled="readOnly"
                  size="xs"
                  placeholder="e.g. mobile-expanded"
                  class="mt-0.5"
                />
              </div>
            </div>

            <!-- Transitions from this step -->
            <div class="rounded border border-neutral-800/80 bg-neutral-950 p-2 space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-[10px] font-semibold uppercase text-neutral-400">Transitions ({{ step.transitions.length }})</span>
                <button
                  v-if="!readOnly"
                  type="button"
                  class="text-[10px] text-primary-400 hover:underline"
                  @click="addTransition(step)"
                >
                  + Add Transition
                </button>
              </div>

              <div
                v-if="step.transitions.length"
                class="space-y-1.5"
              >
                <div
                  v-for="(tr, trIdx) in step.transitions"
                  :key="trIdx"
                  class="flex items-center gap-1.5 text-[11px]"
                >
                  <span class="text-neutral-500 font-mono text-[10px]">on</span>
                  <UInput
                    v-model="tr.event"
                    :disabled="readOnly"
                    size="xs"
                    placeholder="click"
                    class="w-16 font-mono"
                  />
                  <span class="text-neutral-500 font-mono text-[10px]">#</span>
                  <UInput
                    v-model="tr.widgetId"
                    :disabled="readOnly"
                    size="xs"
                    placeholder="widgetId"
                    class="w-24 font-mono"
                  />
                  <span class="text-neutral-500 font-mono text-[10px]">→</span>
                  <select
                    v-model="tr.targetStepId"
                    :disabled="readOnly"
                    class="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-200 outline-none"
                  >
                    <option
                      v-for="s in localSteps"
                      :key="s.id"
                      :value="s.id"
                    >
                      {{ s.id }}
                    </option>
                  </select>
                  <button
                    v-if="!readOnly"
                    type="button"
                    class="text-neutral-500 hover:text-red-400 text-xs px-1"
                    title="Remove transition"
                    @click="removeTransition(step, trIdx)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div
                v-else
                class="py-1 text-center text-[10px] text-neutral-500 italic"
              >
                No transitions (terminal step).
              </div>
            </div>
          </div>
        </div>

        <div
          v-else
          class="rounded border border-dashed border-neutral-800 p-4 text-center text-xs text-neutral-500"
        >
          No steps in this flow. Click "+ Add Step" to begin.
        </div>
      </div>

      <!-- Save Actions -->
      <div class="border-t border-neutral-800 pt-3 flex justify-end">
        <UButton
          v-if="!readOnly"
          color="primary"
          variant="solid"
          size="sm"
          :loading="saving"
          @click="handleSaveFlow"
        >
          Save Flow Changes
        </UButton>
      </div>
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList"
      class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500"
    >
      Select a UX Flow to inspect its steps and transitions.
    </div>
  </div>
</template>
