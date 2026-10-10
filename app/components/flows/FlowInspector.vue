<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import { useWorkbench } from '../../composables/useWorkbench'
import { useDeclaredWidgetEvents } from '../../composables/useDeclaredWidgetEvents'
import { viewLocation } from '../../utils/workbench-routes'
import { edgeKey, orderSteps, parseEdgeKey, triggerLabel, type FlowSelection } from '../../utils/flow-graph'

/**
 * Structured editing for the selected step or transition (brief g, section 6), or the Flow itself
 * when nothing is selected. Every control edits the shared draft; Save sends the whole Flow in one
 * `update_flow`. Read-only mode (tablet, phone) shows the same facts as text.
 */
const props = defineProps<{ selection?: FlowSelection; readOnly?: boolean }>()
const emit = defineEmits<{ (e: 'select', selection: FlowSelection | undefined): void }>()

const { t } = useI18n()
const editor = injectFlowEditor()
const workbench = useWorkbench()
const declaredEvents = useDeclaredWidgetEvents()
const { draft, read, problems, saving } = editor

/** reka-ui items cannot use '' as a value, so the base (no Variant) state uses a sentinel. */
const BASE_VARIANT = '__uiux_base_variant__'

const locked = computed(() => props.readOnly || saving.value)

const step = computed(() => {
	if (props.selection?.kind !== 'step' || !draft.value) return undefined
	const value = draft.value.steps[props.selection.stepId]
	return value ? { id: props.selection.stepId, value } : undefined
})

const transition = computed(() => {
	if (props.selection?.kind !== 'edge' || !draft.value) return undefined
	const parsed = parseEdgeKey(props.selection.key)
	const source = parsed ? draft.value.steps[parsed.stepId] : undefined
	const value = parsed && source ? source.transitions[parsed.index] : undefined
	return parsed && source && value ? { stepId: parsed.stepId, index: parsed.index, source, value } : undefined
})

const orderedStepIds = computed(() => draft.value ? orderSteps(draft.value).order : [])

const stepItems = computed(() => orderedStepIds.value.map((id, index) => ({
	label: t('flows.inspector.stepOption', { n: index + 1, step: editor.stepLabel(id) }),
	value: id,
})))

function viewItems(currentViewId: string) {
	const items = workbench.views.value.map(view => ({ label: view.summary.name || view.key, value: view.key }))
	if (currentViewId && !items.some(item => item.value === currentViewId))
		items.push({ label: t('flows.inspector.viewMissing', { id: currentViewId }), value: currentViewId })
	return items
}

function variantItems(viewId: string, current?: string) {
	const names = editor.viewVariants(viewId)
	const items: Array<{ label: string; value: string; disabled?: boolean }> = [
		{ label: t('ctx.base'), value: BASE_VARIANT },
		...names.map(name => ({ label: name, value: name })),
	]
	if (current && !names.includes(current)) items.push({ label: t('flows.inspector.variantMissing', { name: current }), value: current })
	return items
}

function widgetItems(viewId: string, current?: string) {
	const widgets = editor.viewWidgets(viewId)
	const items = [...widgets].map(([id, type]) => ({ label: `#${id}`, description: type, value: id }))
	if (current && !widgets.has(current)) items.push({ label: t('flows.inspector.widgetMissing', { id: current }), description: '', value: current })
	return items
}

/**
 * The Events a trigger's Widget declares, or undefined when that is unknown (the declared Events
 * could not be read, or the Widget is not in the View): then the Event stays a free-text field.
 */
function declaredEventsOf(viewId: string, widgetId: string): readonly { name: string; description: string }[] | undefined {
	const type = widgetId ? editor.viewWidgets(viewId).get(widgetId) : undefined
	return type ? declaredEvents.eventsOf(type) : undefined
}

/** The Event picker's items. An existing value the Widget doesn't declare stays, labelled, and is never rebound. */
function eventItems(viewId: string, widgetId: string, current?: string) {
	const declared = declaredEventsOf(viewId, widgetId) ?? []
	const items: Array<{ label: string; description?: string; value: string }> = declared.map(event => ({ label: event.name, ...(event.description ? { description: event.description } : {}), value: event.name }))
	if (current && !declared.some(event => event.name === current)) items.push({ label: t('flows.inspector.eventNotDeclared', { event: current }), value: current })
	return items
}

function stepProblems(stepId: string) {
	return problems.value.filter(problem => problem.stepId === stepId && !problem.edgeKey)
}

function edgeProblems(key: string) {
	return problems.value.filter(problem => problem.edgeKey === key)
}

// --- Step ----------------------------------------------------------------------------------------

const stepViewModel = computed({
	get: () => step.value?.value.target.viewId || undefined,
	set: (viewId: string | undefined) => {
		if (!step.value || !viewId) return
		// A different View starts at its base state; a Variant name means nothing across Views.
		editor.setTarget(step.value.id, { viewId })
	},
})

const stepVariantModel = computed({
	get: () => step.value?.value.target.variantName ?? BASE_VARIANT,
	set: (value: string) => {
		if (!step.value) return
		editor.setTarget(step.value.id, {
			viewId: step.value.value.target.viewId,
			...(value === BASE_VARIANT ? {} : { variantName: value }),
		})
	},
})

const isEntry = computed(() => !!step.value && draft.value?.entryStepId === step.value.id)
const incomingCount = computed(() => step.value ? editor.incoming(step.value.id).length : 0)
const confirmingRemove = ref(false)
const addingTransition = ref(false)
watch(() => props.selection, () => {
	confirmingRemove.value = false
	addingTransition.value = false
})

function removeStep(): void {
	if (!step.value) return
	editor.removeStep(step.value.id)
	confirmingRemove.value = false
	emit('select', undefined)
}

const newTransition = reactive({ widgetId: '', event: '', targetStepId: '' })

function openAddTransition(): void {
	newTransition.widgetId = ''
	newTransition.event = ''
	newTransition.targetStepId = orderedStepIds.value.find(id => id !== step.value?.id) ?? step.value?.id ?? ''
	addingTransition.value = true
}

const canAddTransition = computed(() => !!newTransition.widgetId && !!newTransition.event.trim() && !!newTransition.targetStepId)

// A new trigger's Event is chosen from what its Widget declares: picking another Widget clears an
// Event that Widget doesn't declare, and preselects the only Event when there is exactly one.
watch(() => newTransition.widgetId, (widgetId) => {
	if (!step.value || !widgetId) return
	const declared = declaredEventsOf(step.value.value.target.viewId, widgetId)
	if (!declared) return
	if (declared.length === 1) newTransition.event = declared[0]!.name
	else if (!declared.some(event => event.name === newTransition.event)) newTransition.event = ''
})

function submitTransition(): void {
	if (!step.value || !canAddTransition.value) return
	const index = editor.addTransition(step.value.id, {
		trigger: { widgetId: newTransition.widgetId, event: newTransition.event.trim() },
		targetStepId: newTransition.targetStepId,
	})
	addingTransition.value = false
	if (index !== undefined) emit('select', { kind: 'edge', key: edgeKey(step.value.id, index) })
}

// --- Transition ----------------------------------------------------------------------------------

const widgetModel = computed({
	get: () => transition.value?.value.trigger.widgetId || undefined,
	set: (value: string | undefined) => {
		if (transition.value && value) editor.updateTransition(transition.value.stepId, transition.value.index, { widgetId: value })
	},
})

const eventModel = computed({
	get: () => transition.value?.value.trigger.event ?? '',
	set: (value: string) => {
		if (transition.value) editor.updateTransition(transition.value.stepId, transition.value.index, { event: value })
	},
})

const targetModel = computed({
	get: () => transition.value?.value.targetStepId || undefined,
	set: (value: string | undefined) => {
		if (transition.value && value) editor.updateTransition(transition.value.stepId, transition.value.index, { targetStepId: value })
	},
})

function targetItems(current: string) {
	const items = stepItems.value.slice()
	if (current && !items.some(item => item.value === current)) items.push({ label: t('flows.graph.missingStep'), value: current })
	return items
}

function removeTransition(): void {
	if (!transition.value) return
	const stepId = transition.value.stepId
	editor.removeTransition(stepId, transition.value.index)
	emit('select', { kind: 'step', stepId })
}

// --- Flow ----------------------------------------------------------------------------------------

const nameModel = computed({
	get: () => draft.value?.name ?? '',
	set: (value: string) => editor.setName(value),
})

const entryModel = computed({
	get: () => draft.value?.entryStepId || undefined,
	set: (value: string | undefined) => { if (value) editor.setEntry(value) },
})

const transitionCount = computed(() => Object.values(draft.value?.steps ?? {}).reduce((sum, item) => sum + item.transitions.length, 0))

const viewSearch = computed(() => ({ placeholder: t('flows.inspector.searchViews') }))
const eventSearch = computed(() => ({ placeholder: t('flows.inspector.searchEvents') }))
/** Declared Events could be read; otherwise the Event stays a free-text field. */
const catalogKnown = computed(() => typeof declaredEvents.catalog.value === 'object')
const widgetSearch = computed(() => ({ placeholder: t('flows.inspector.searchWidgets') }))
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    data-flow-inspector
  >
    <!-- A step -->
    <template v-if="step">
      <div class="flex items-center gap-1 border-b border-default px-2 py-1.5">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-arrow-left"
          :label="t('flows.inspector.flow')"
          class="text-muted"
          @click="emit('select', undefined)"
        />
      </div>
      <section class="space-y-4 px-3 py-4">
        <div class="flex min-w-0 items-center gap-2">
          <h2 class="min-w-0 flex-1 truncate text-title font-semibold text-highlighted">
            {{ editor.stepLabel(step.id) }}
          </h2>
          <UBadge
            v-if="isEntry"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-flag"
          >
            {{ t('flows.graph.entry') }}
          </UBadge>
        </div>

        <UAlert
          v-for="problem in stepProblems(step.id)"
          :key="problem.code + problem.path"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="editor.describeProblem(problem)"
          :ui="{ description: 'text-sm' }"
        />

        <template v-if="!readOnly">
          <UFormField :label="t('flows.inspector.view')">
            <USelectMenu
              v-model="stepViewModel"
              :items="viewItems(step.value.target.viewId)"
              value-key="value"
              :search-input="viewSearch"
              :disabled="locked"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('ctx.variant')">
            <USelectMenu
              v-model="stepVariantModel"
              :items="variantItems(step.value.target.viewId, step.value.target.variantName)"
              value-key="value"
              :search-input="false"
              :disabled="locked || !step.value.target.viewId"
              class="w-full"
            />
          </UFormField>
        </template>
        <dl
          v-else
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"
        >
          <dt class="text-muted">
            {{ t('flows.inspector.view') }}
          </dt>
          <dd class="min-w-0 truncate text-default">
            {{ editor.stepLabel(step.id) }}
          </dd>
          <dt class="text-muted">
            {{ t('ctx.variant') }}
          </dt>
          <dd class="min-w-0 truncate">
            <span
              v-if="step.value.target.variantName"
              class="font-mono text-xs"
            >{{ step.value.target.variantName }}</span>
            <span v-else>{{ t('ctx.base') }}</span>
          </dd>
        </dl>

        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="step.value.target.viewId"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-app-window"
            :label="t('flows.inspector.openView')"
            :to="viewLocation(step.value.target.viewId, { variant: step.value.target.variantName })"
          />
          <UButton
            v-if="!readOnly && !isEntry"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-flag"
            :label="t('flows.inspector.makeEntry')"
            :disabled="locked"
            @click="editor.setEntry(step.id)"
          />
        </div>
      </section>

      <section class="space-y-2 border-t border-default px-3 py-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('flows.inspector.transitions') }}
          </h3>
          <UButton
            v-if="!readOnly && !addingTransition"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-plus"
            :label="t('flows.inspector.addTransition')"
            :disabled="locked"
            @click="openAddTransition"
          />
        </div>
        <ul
          v-if="step.value.transitions.length"
          class="space-y-0.5"
        >
          <li
            v-for="(item, index) in step.value.transitions"
            :key="`${step.id}:${index}`"
          >
            <button
              type="button"
              class="flex min-h-(--wb-target) w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-muted"
              @click="emit('select', { kind: 'edge', key: edgeKey(step.id, index) })"
            >
              <span
                class="min-w-0 truncate font-mono text-xs"
                :class="edgeProblems(edgeKey(step.id, index)).length ? 'text-error' : 'text-muted'"
              >{{ triggerLabel(item.trigger) }}</span>
              <UIcon
                name="i-lucide-arrow-right"
                class="size-3.5 shrink-0 text-dimmed"
              />
              <span class="min-w-0 flex-1 truncate">{{ draft?.steps[item.targetStepId] ? editor.stepLabel(item.targetStepId) : t('flows.graph.missingStep') }}</span>
            </button>
          </li>
        </ul>
        <p
          v-else-if="!addingTransition"
          class="text-sm text-muted"
        >
          {{ t('flows.inspector.noOutgoing') }}
        </p>

        <form
          v-if="addingTransition"
          class="space-y-3 rounded-lg border border-dashed border-accented p-3"
          @submit.prevent="submitTransition"
        >
          <UFormField :label="t('flows.inspector.widget')">
            <USelectMenu
              v-model="newTransition.widgetId"
              :items="widgetItems(step.value.target.viewId)"
              value-key="value"
              :search-input="widgetSearch"
              :placeholder="t('flows.inspector.widgetPlaceholder')"
              class="w-full"
              :ui="{ itemLabel: 'font-mono text-xs', itemDescription: 'text-xs' }"
            />
          </UFormField>
          <UFormField
            v-if="catalogKnown"
            :label="t('flows.inspector.event')"
            :help="!newTransition.widgetId || eventItems(step.value.target.viewId, newTransition.widgetId).length ? t('flows.inspector.eventPickHelp') : t('flows.inspector.eventsNone')"
          >
            <USelectMenu
              v-model="newTransition.event"
              :items="eventItems(step.value.target.viewId, newTransition.widgetId, newTransition.event)"
              value-key="value"
              :search-input="eventSearch"
              :placeholder="t('flows.inspector.eventPick')"
              :disabled="!newTransition.widgetId"
              class="w-full"
              :ui="{ base: 'font-mono', itemLabel: 'font-mono text-xs', itemDescription: 'text-xs' }"
              data-flow-event-picker
            />
          </UFormField>
          <UFormField
            v-else
            :label="t('flows.inspector.event')"
            :help="t('flows.inspector.eventHelp')"
          >
            <UInput
              v-model="newTransition.event"
              :placeholder="t('flows.inspector.eventPlaceholder')"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
          <UFormField :label="t('flows.inspector.target')">
            <USelect
              v-model="newTransition.targetStepId"
              :items="stepItems"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :label="t('common.cancel')"
              @click="addingTransition = false"
            />
            <UButton
              type="submit"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-plus"
              :label="t('common.add')"
              :disabled="!canAddTransition"
            />
          </div>
        </form>

        <p
          v-if="incomingCount"
          class="pt-1 text-xs text-muted"
        >
          {{ t('flows.inspector.incoming', incomingCount) }}
        </p>
      </section>

      <section
        v-if="!readOnly"
        class="space-y-2 border-t border-default px-3 py-4"
      >
        <template v-if="confirmingRemove">
          <p class="text-sm text-default">
            {{ t('flows.inspector.removeStepConfirm', incomingCount) }}
          </p>
          <div class="flex gap-2">
            <UButton
              color="error"
              variant="soft"
              size="sm"
              icon="i-lucide-trash-2"
              :label="t('flows.inspector.removeStep')"
              @click="removeStep"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :label="t('common.cancel')"
              @click="confirmingRemove = false"
            />
          </div>
        </template>
        <UTooltip
          v-else
          :text="isEntry ? t('flows.inspector.entryCantRemove') : undefined"
          :disabled="!isEntry"
        >
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-trash-2"
            :label="t('flows.inspector.removeStep')"
            :disabled="locked || isEntry"
            class="text-muted"
            @click="confirmingRemove = true"
          />
        </UTooltip>
      </section>

      <UCollapsible class="border-t border-default px-3 py-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          :label="t('flows.inspector.details')"
          class="-mx-2 text-muted"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-120' }"
        />
        <template #content>
          <dl class="grid gap-1 pb-2 text-xs">
            <dt class="text-muted">
              {{ t('flows.inspector.stepId') }}
            </dt>
            <dd class="break-all font-mono text-default">
              {{ step.id }}
            </dd>
            <template v-if="step.value.target.viewId">
              <dt class="pt-1 text-muted">
                {{ t('flows.inspector.viewId') }}
              </dt>
              <dd class="break-all font-mono text-default">
                {{ step.value.target.viewId }}
              </dd>
            </template>
          </dl>
        </template>
      </UCollapsible>
    </template>

    <!-- A transition -->
    <template v-else-if="transition">
      <div class="flex items-center gap-1 border-b border-default px-2 py-1.5">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-arrow-left"
          :label="editor.stepLabel(transition.stepId)"
          class="min-w-0 text-muted"
          :ui="{ label: 'truncate' }"
          @click="emit('select', { kind: 'step', stepId: transition.stepId })"
        />
      </div>
      <section class="space-y-4 px-3 py-4">
        <h2 class="truncate font-mono text-sm text-highlighted">
          {{ triggerLabel(transition.value.trigger) }}
        </h2>

        <UAlert
          v-for="problem in edgeProblems(edgeKey(transition.stepId, transition.index))"
          :key="problem.code + problem.path"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="editor.describeProblem(problem)"
          :ui="{ description: 'text-sm' }"
        />

        <template v-if="!readOnly">
          <UFormField :label="t('flows.inspector.widget')">
            <USelectMenu
              v-model="widgetModel"
              :items="widgetItems(transition.source.target.viewId, transition.value.trigger.widgetId)"
              value-key="value"
              :search-input="widgetSearch"
              :placeholder="t('flows.inspector.widgetPlaceholder')"
              :disabled="locked"
              class="w-full"
              :ui="{ base: 'font-mono', itemLabel: 'font-mono text-xs', itemDescription: 'text-xs' }"
            />
          </UFormField>
          <UFormField
            v-if="declaredEventsOf(transition.source.target.viewId, transition.value.trigger.widgetId)"
            :label="t('flows.inspector.event')"
            :help="declaredEventsOf(transition.source.target.viewId, transition.value.trigger.widgetId)?.length ? t('flows.inspector.eventPickHelp') : t('flows.inspector.eventsNone')"
          >
            <USelectMenu
              v-model="eventModel"
              :items="eventItems(transition.source.target.viewId, transition.value.trigger.widgetId, transition.value.trigger.event)"
              value-key="value"
              :search-input="eventSearch"
              :placeholder="t('flows.inspector.eventPick')"
              :disabled="locked"
              class="w-full"
              :ui="{ base: 'font-mono', itemLabel: 'font-mono text-xs', itemDescription: 'text-xs' }"
              data-flow-event-picker
            />
          </UFormField>
          <UFormField
            v-else
            :label="t('flows.inspector.event')"
            :help="t('flows.inspector.eventHelp')"
          >
            <UInput
              v-model="eventModel"
              :placeholder="t('flows.inspector.eventPlaceholder')"
              :disabled="locked"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
          <UFormField :label="t('flows.inspector.target')">
            <USelect
              v-model="targetModel"
              :items="targetItems(transition.value.targetStepId)"
              :disabled="locked"
              class="w-full"
            />
          </UFormField>
        </template>
        <dl
          v-else
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"
        >
          <dt class="text-muted">
            {{ t('flows.inspector.widget') }}
          </dt>
          <dd class="min-w-0 truncate font-mono text-xs">
            #{{ transition.value.trigger.widgetId }}
          </dd>
          <dt class="text-muted">
            {{ t('flows.inspector.event') }}
          </dt>
          <dd class="min-w-0 truncate font-mono text-xs">
            {{ transition.value.trigger.event }}
          </dd>
          <dt class="text-muted">
            {{ t('flows.inspector.target') }}
          </dt>
          <dd class="min-w-0 truncate">
            {{ draft?.steps[transition.value.targetStepId] ? editor.stepLabel(transition.value.targetStepId) : t('flows.graph.missingStep') }}
          </dd>
        </dl>

        <UButton
          v-if="draft?.steps[transition.value.targetStepId]"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-arrow-right"
          :label="t('flows.inspector.selectTarget')"
          @click="emit('select', { kind: 'step', stepId: transition.value.targetStepId })"
        />
      </section>

      <section
        v-if="!readOnly"
        class="border-t border-default px-3 py-4"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-trash-2"
          :label="t('flows.inspector.removeTransition')"
          :disabled="locked"
          class="text-muted"
          @click="removeTransition"
        />
      </section>
    </template>

    <!-- The Flow -->
    <template v-else-if="draft">
      <section class="space-y-4 px-3 py-4">
        <h2 class="text-title font-semibold text-highlighted">
          {{ t('flows.inspector.flow') }}
        </h2>
        <template v-if="!readOnly">
          <UFormField
            :label="t('flows.inspector.name')"
            required
          >
            <UInput
              v-model="nameModel"
              :disabled="locked"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('flows.inspector.entryStep')">
            <USelect
              v-model="entryModel"
              :items="stepItems"
              :disabled="locked"
              class="w-full"
            />
          </UFormField>
        </template>
        <dl
          v-else
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"
        >
          <dt class="text-muted">
            {{ t('flows.inspector.name') }}
          </dt>
          <dd class="min-w-0 truncate text-default">
            {{ draft.name }}
          </dd>
          <dt class="text-muted">
            {{ t('flows.inspector.entryStep') }}
          </dt>
          <dd class="min-w-0 truncate text-default">
            {{ editor.stepLabel(draft.entryStepId) }}
          </dd>
        </dl>
        <p class="text-sm text-muted">
          {{ t('flows.toolbar.steps', orderedStepIds.length) }} · {{ t('flows.inspector.transitionCount', transitionCount) }}
        </p>
        <p
          v-if="!readOnly"
          class="text-sm text-muted"
        >
          {{ t('flows.inspector.selectHint') }}
        </p>
      </section>

      <UCollapsible class="border-t border-default px-3 py-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          :label="t('flows.inspector.details')"
          class="-mx-2 text-muted"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-120' }"
        />
        <template #content>
          <dl class="grid gap-1 pb-2 text-xs">
            <dt class="text-muted">
              {{ t('flows.inspector.flowId') }}
            </dt>
            <dd class="break-all font-mono text-default">
              {{ draft.id }}
            </dd>
            <template v-if="read">
              <dt class="pt-1 text-muted">
                {{ t('common.revision') }}
              </dt>
              <dd class="break-all font-mono text-default">
                {{ read.revision }}
              </dd>
            </template>
            <template v-if="draft.scenarioRef">
              <dt class="pt-1 text-muted">
                {{ t('flows.inspector.scenario') }}
              </dt>
              <dd class="break-all font-mono text-default">
                {{ JSON.stringify(draft.scenarioRef) }}
              </dd>
            </template>
          </dl>
        </template>
      </UCollapsible>
    </template>
  </div>
</template>
