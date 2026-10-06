<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { defineShortcuts, onBeforeRouteLeave, onBeforeRouteUpdate, useI18n, useRoute, useRouter } from '#imports'
import type { RouteLocationNormalized } from 'vue-router'
import { provideFlowEditor, useFlowEditor } from '../../composables/useFlowEditor'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { parseEdgeKey, type FlowProblem, type FlowSelection } from '../../utils/flow-graph'
import FlowGraph from '../../components/flows/FlowGraph.vue'
import FlowStepList from '../../components/flows/FlowStepList.vue'
import FlowInspector from '../../components/flows/FlowInspector.vue'
import FlowAddStepModal from '../../components/flows/FlowAddStepModal.vue'
import FlowPlayer from '../../components/flows/FlowPlayer.vue'
import LockBadge from '../../components/workbench/LockBadge.vue'
import LockedSaveAlert from '../../components/workbench/LockedSaveAlert.vue'
import { useAccess } from '../../composables/useAccess'

/**
 * One UX Flow (brief g): the graph with a structured editor for the selected step or transition, an
 * accessible List view, and the Prototype player (`?play=1`). Graph, list and player are projections
 * of the one canonical Flow (Discussion #6, 10c). Desktop edits; tablet plays and reads the graph;
 * a phone reads the ordered step list and plays.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const workbench = useWorkbench()
const shell = useWorkbenchShell()

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery('(max-width: 767.98px)')
const flowId = computed(() => String(route.params.flowId ?? ''))

const editor = useFlowEditor(flowId)
provideFlowEditor(editor)
const { draft, saved, dirty, problems, saveBlockers, playBlockedReason, checkingReferences, conflict, saveError, locked, saving, loading, notFound, loadError, lossless } = editor

const access = useAccess()
const migrationRequired = computed(() => workbench.workspace.value?.inspection?.state === 'migration_required')
/** Someone else (an agent) holds this Flow's edit lease: read-only beside the Lock badge (identity decision 11). */
const lockedByOther = computed(() => !!access.lockFor('flow', flowId.value))
// Editing needs Editor or above (authorReadOnly also covers a publication), a desktop window and no foreign lease.
const canEdit = computed(() => !workbench.authorReadOnly.value && !lockedByOther.value && isDesktop.value && lossless.value && !migrationRequired.value)
const showEditOnDesktop = computed(() => !workbench.authorReadOnly.value && !isDesktop.value)

// ---------------------------------------------------------------------------------------------
// Selection (ephemeral; dropped when the selected step or transition no longer exists)
// ---------------------------------------------------------------------------------------------

const selection = ref<FlowSelection>()
const graph = ref<InstanceType<typeof FlowGraph>>()

watch(flowId, () => { selection.value = undefined })
watch(draft, (current) => {
	const selected = selection.value
	if (!selected || !current) return
	if (selected.kind === 'step' && !current.steps[selected.stepId]) selection.value = undefined
	if (selected.kind === 'edge') {
		const parsed = parseEdgeKey(selected.key)
		if (!parsed || !current.steps[parsed.stepId]?.transitions[parsed.index]) selection.value = parsed && current.steps[parsed.stepId] ? { kind: 'step', stepId: parsed.stepId } : undefined
	}
}, { deep: true })

const inspectorOpen = ref(false)

function select(next: FlowSelection | undefined): void {
	selection.value = next
	if (next && !isDesktop.value && !isPhone.value) inspectorOpen.value = true
}

function activate(stepId: string): void {
	select({ kind: 'step', stepId })
	if (!isDesktop.value) inspectorOpen.value = true
}

function selectProblem(problem: FlowProblem): void {
	if (problem.edgeKey) select({ kind: 'edge', key: problem.edgeKey })
	else if (problem.stepId) {
		select({ kind: 'step', stepId: problem.stepId })
		void graph.value?.focusStep(problem.stepId)
	}
	else select(undefined)
}

// ---------------------------------------------------------------------------------------------
// Graph or list
// ---------------------------------------------------------------------------------------------

const LAYOUT_KEY = 'uiux.workbench.flowLayout'
const preferredLayout = ref<'graph' | 'list'>('graph')
try { if (globalThis.localStorage?.getItem(LAYOUT_KEY) === 'list') preferredLayout.value = 'list' }
catch { /* storage unavailable */ }
watch(preferredLayout, (value) => {
	try { globalThis.localStorage?.setItem(LAYOUT_KEY, value) }
	catch { /* storage unavailable */ }
})
const layout = computed(() => isPhone.value ? 'list' : preferredLayout.value)

// ---------------------------------------------------------------------------------------------
// Prototype player
// ---------------------------------------------------------------------------------------------

const playRequested = computed(() => route.query.play === '1')
const playing = computed(() => playRequested.value && !!saved.value && !playBlockedReason.value)
/** A `?play=1` link to a Flow that can't play: say why, on the graph, instead of a broken player. */
const playRefused = computed(() => playRequested.value && !!saved.value && !checkingReferences.value && !!playBlockedReason.value)

function play(): void {
	if (playBlockedReason.value) return
	void router.push({ query: { ...route.query, play: '1' } })
}

function exitPlayer(): void {
	const query = { ...route.query }
	delete query.play
	void router.replace({ query })
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

const addStepOpen = ref(false)
const addFromStepId = computed(() => {
	const selected = selection.value
	if (selected?.kind === 'step') return selected.stepId
	if (selected?.kind === 'edge') return parseEdgeKey(selected.key)?.stepId
	return undefined
})

function onStepAdded(stepId: string): void {
	selection.value = { kind: 'step', stepId }
}

const saveBlockedReason = computed(() => saveBlockers.value.length ? t('flows.problems.saveBlocked', saveBlockers.value.length) : undefined)

async function save(): Promise<void> {
	if (!canEdit.value || !dirty.value || saveBlockedReason.value) return
	await editor.save()
}

defineShortcuts(computed(() => ({
	meta_s: { usingInput: true, handler: () => { void save() } },
	...(canEdit.value && shell.singleKeyShortcuts.value && !playing.value ? { a: () => { addStepOpen.value = true } } : {}),
})))

// Leaving with unsaved changes asks first (brief g, section 7).
const leaveOpen = ref(false)
let pendingLeave: RouteLocationNormalized | undefined
let leaveConfirmed = false

function guard(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
	const sameFlow = to.path === from.path
	if (sameFlow || !dirty.value || leaveConfirmed) return true
	pendingLeave = to
	leaveOpen.value = true
	return false
}
onBeforeRouteLeave(guard)
onBeforeRouteUpdate(guard)

function confirmLeave(): void {
	leaveOpen.value = false
	const target = pendingLeave
	pendingLeave = undefined
	if (!target) return
	leaveConfirmed = true
	editor.discard()
	void router.push(target.fullPath).finally(() => { leaveConfirmed = false })
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
	if (!dirty.value) return
	event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

const stepCount = computed(() => Object.keys(draft.value?.steps ?? {}).length)
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <UDashboardPanel
      id="flow"
      :ui="{ root: 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
    >
      <template #body>
        <main
          id="main"
          data-landmark="main"
          tabindex="-1"
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
          :aria-label="draft?.name || t('nav.flows')"
        >
          <h1 class="sr-only">
            {{ draft?.name || t('nav.flows') }}
          </h1>
          <FlowPlayer
            v-if="playing && saved"
            :key="`${saved.id}:${editor.read.value?.revision}`"
            :flow="saved"
            @exit="exitPlayer"
          />

          <template v-else-if="draft">
            <UDashboardToolbar
              :ui="{
                root: 'min-h-10 h-auto flex-wrap gap-x-2 gap-y-1 bg-default px-2 py-1 sm:px-2',
                left: 'min-w-0 gap-2',
                right: 'ms-auto shrink-0 flex-wrap justify-end gap-1',
              }"
            >
              <template #left>
                <UFieldGroup
                  v-if="!isPhone"
                  size="sm"
                  role="group"
                  :aria-label="t('flows.graph.layout')"
                >
                  <UButton
                    color="neutral"
                    :variant="layout === 'graph' ? 'soft' : 'ghost'"
                    icon="i-lucide-workflow"
                    :label="t('flows.graph.graphView')"
                    :aria-pressed="layout === 'graph'"
                    @click="preferredLayout = 'graph'"
                  />
                  <UButton
                    color="neutral"
                    :variant="layout === 'list' ? 'soft' : 'ghost'"
                    icon="i-lucide-list"
                    :label="t('flows.graph.listView')"
                    :aria-pressed="layout === 'list'"
                    @click="preferredLayout = 'list'"
                  />
                </UFieldGroup>
                <span class="truncate text-xs text-muted">{{ t('flows.toolbar.steps', stepCount) }}</span>
                <span
                  v-if="showEditOnDesktop"
                  class="hidden items-center gap-1 text-xs text-muted sm:inline-flex"
                >
                  <UIcon
                    name="i-lucide-monitor"
                    class="size-3.5"
                  />
                  {{ t('common.editOnDesktop') }}
                </span>
              </template>
              <template #right>
                <template v-if="canEdit && dirty">
                  <span
                    class="px-1 text-xs text-muted"
                    role="status"
                  >{{ t('flows.toolbar.unsaved') }}</span>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :label="t('flows.toolbar.discard')"
                    :disabled="saving"
                    @click="editor.discard()"
                  />
                  <UTooltip
                    :text="saveBlockedReason ?? t('common.save')"
                    :kbds="saveBlockedReason ? undefined : ['meta', 's']"
                  >
                    <UButton
                      color="primary"
                      variant="solid"
                      size="sm"
                      icon="i-lucide-save"
                      :label="saving ? t('common.saving') : t('common.save')"
                      :loading="saving"
                      :disabled="!!saveBlockedReason"
                      data-flow-save
                      @click="save"
                    />
                  </UTooltip>
                  <USeparator
                    orientation="vertical"
                    class="mx-1 h-4"
                  />
                </template>
                <UTooltip
                  v-if="canEdit"
                  :text="t('flows.toolbar.addStep')"
                  :kbds="shell.singleKeyShortcuts.value ? ['a'] : undefined"
                >
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    icon="i-lucide-plus"
                    :label="t('flows.toolbar.addStep')"
                    :disabled="saving"
                    data-flow-add-step
                    @click="addStepOpen = true"
                  />
                </UTooltip>
                <UTooltip :text="playBlockedReason ?? t('flows.play')">
                  <UButton
                    :color="dirty && canEdit ? 'neutral' : 'primary'"
                    :variant="dirty && canEdit ? 'outline' : 'solid'"
                    size="sm"
                    icon="i-lucide-play"
                    :label="t('flows.play')"
                    :disabled="!!playBlockedReason"
                    data-flow-play
                    @click="play"
                  />
                </UTooltip>
                <UButton
                  v-if="!isDesktop && !isPhone"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-panel-right-open"
                  :aria-label="t('shell.openPanel')"
                  :aria-expanded="inspectorOpen"
                  @click="inspectorOpen = true"
                />
              </template>
            </UDashboardToolbar>

            <LockBadge
              kind="flow"
              :resource-key="flowId"
              class="border-b border-default px-3 py-2"
            />
            <div class="shrink-0 space-y-px empty:hidden">
              <LockedSaveAlert
                v-if="locked"
                :lock="locked.lock"
                class="rounded-none"
                @dismiss="locked = undefined"
              />
              <UAlert
                v-if="conflict"
                color="warning"
                variant="subtle"
                icon="i-lucide-git-compare-arrows"
                :title="t('flows.conflict.title')"
                :description="t('flows.conflict.description')"
                :actions="[{ label: t('flows.conflict.reload'), color: 'neutral', variant: 'outline', size: 'sm', onClick: () => { void editor.reloadTheirs() } }]"
                class="rounded-none"
                data-flow-conflict
              />
              <UAlert
                v-else-if="saveError"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-alert"
                :title="saveError.message"
                close
                class="rounded-none"
                @update:open="saveError = undefined"
              >
                <template
                  v-if="saveError.diagnostics.length"
                  #description
                >
                  <ul class="space-y-0.5">
                    <li
                      v-for="(diagnostic, index) in saveError.diagnostics"
                      :key="index"
                    >
                      <span
                        v-if="diagnostic.path"
                        class="font-mono text-xs"
                      >{{ diagnostic.path }}</span>
                      {{ diagnostic.message }}
                    </li>
                  </ul>
                </template>
              </UAlert>
              <UAlert
                v-if="!lossless"
                color="warning"
                variant="subtle"
                icon="i-lucide-file-warning"
                :description="t('flows.problems.lossy')"
                class="rounded-none"
              />
              <UAlert
                v-if="playRefused"
                color="info"
                variant="subtle"
                icon="i-lucide-info"
                :title="playBlockedReason"
                close
                class="rounded-none"
                @update:open="exitPlayer"
              />
              <UAlert
                v-if="problems.length"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-alert"
                :title="t('flows.toolbar.problems', problems.length)"
                class="rounded-none"
                :ui="{ description: 'mt-1' }"
                data-flow-problems
              >
                <template #description>
                  <ul class="max-h-32 space-y-0.5 overflow-y-auto">
                    <li
                      v-for="problem in problems"
                      :key="problem.code + problem.path"
                    >
                      <button
                        type="button"
                        class="min-h-(--wb-target) text-start text-sm underline-offset-2 hover:underline"
                        @click="selectProblem(problem)"
                      >
                        {{ editor.describeProblem(problem) }}
                      </button>
                    </li>
                  </ul>
                </template>
              </UAlert>
            </div>

            <FlowGraph
              v-if="layout === 'graph'"
              ref="graph"
              :selection="selection"
              :can-play="!playBlockedReason"
              @select="select"
              @activate="activate"
              @play="play"
            />
            <FlowStepList
              v-else
              :selection="selection"
              :interactive="!isPhone"
              class="bg-default"
              @select="select"
            />
          </template>

          <div
            v-else
            class="flex min-h-0 flex-1 items-center justify-center p-6"
          >
            <UEmpty
              v-if="notFound"
              icon="i-lucide-workflow"
              :title="t('flows.detail.notFound')"
              :description="t('flows.detail.notFoundHint')"
              variant="naked"
              :actions="[{ label: t('flows.detail.allFlows'), to: '/flows', color: 'neutral', variant: 'outline', icon: 'i-lucide-arrow-left' }]"
            />
            <UEmpty
              v-else-if="loadError"
              icon="i-lucide-circle-alert"
              :title="t('flows.detail.loadFailed')"
              :description="loadError"
              variant="naked"
              :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void editor.load() } }]"
            />
            <USkeleton
              v-else-if="loading"
              class="h-24 w-64 rounded-lg"
            />
          </div>
        </main>
      </template>
    </UDashboardPanel>

    <UDashboardSidebar
      v-if="isDesktop && !playing && draft"
      id="flow-details"
      side="right"
      resizable
      :min-size="300"
      :max-size="440"
      :default-size="340"
      :toggle="false"
      :open="false"
      :ui="{ root: 'min-h-0 h-auto border-s border-default', body: 'gap-0 p-0 overflow-hidden' }"
    >
      <aside
        data-landmark="complementary"
        :aria-label="t('flows.inspector.label')"
        class="flex min-h-0 flex-1 flex-col"
      >
        <FlowInspector
          :selection="selection"
          :read-only="!canEdit"
          @select="select"
        />
      </aside>
    </UDashboardSidebar>

    <USlideover
      v-if="!isDesktop && !isPhone && !playing && draft"
      v-model:open="inspectorOpen"
      side="right"
      :title="t('flows.inspector.label')"
      :ui="{ content: 'max-w-sm', body: 'flex min-h-0 flex-col p-0 sm:p-0' }"
    >
      <template #body>
        <aside
          data-landmark="complementary"
          :aria-label="t('flows.inspector.label')"
          class="flex min-h-0 flex-1 flex-col"
        >
          <FlowInspector
            :selection="selection"
            read-only
            @select="select"
          />
        </aside>
      </template>
    </USlideover>

    <FlowAddStepModal
      v-if="canEdit"
      v-model:open="addStepOpen"
      :from-step-id="addFromStepId"
      @added="onStepAdded"
      @settled="(stepId: string) => graph?.focusStep(stepId)"
    />

    <UModal
      v-model:open="leaveOpen"
      :title="t('flows.leave.title')"
      :description="t('flows.leave.description')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('flows.leave.stay')"
            @click="leaveOpen = false"
          />
          <UButton
            color="error"
            variant="soft"
            :label="t('flows.leave.confirm')"
            @click="confirmLeave"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
