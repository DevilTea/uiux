import { computed, inject, provide, ref, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import { useI18n } from '#imports'
import { deriveWidgetTree, flattenWidgetTree } from '../../src/preview/widget-tree'
import { describeFetchError, isLockedError, type FetchErrorDetails, type FetchErrorLock } from '../utils/fetch-error'
import {
	cloneDraft,
	draftToCanonical,
	incomingTransitions,
	orderSteps,
	referencesPending,
	sameDraft,
	toFlowDraft,
	validateFlowDraft,
	type FlowDraft,
	type FlowProblem,
	type FlowTransitionDraft,
	type FlowViewFacts,
	type FlowViewIndex,
} from '../utils/flow-graph'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'
import { useWorkbenchFeedback } from './useWorkbenchFeedback'
import type { Diagnostic, ViewRead } from './workbench-types'
import { focusFirstProblem } from '../utils/focus-problem'
import { randomUuid } from '../utils/random-uuid'

export type FlowRead = Readonly<{
	kind: 'flow'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: unknown
}>

/**
 * One UX Flow open in the graph editor: the canonical read, a Workbench edit draft, reference facts
 * about its target Views, validation, and the single atomic `update_flow` save with
 * `expectedRevision`. The draft is editing state only; nothing reaches the Workspace until Save, and
 * a revision conflict keeps the draft instead of overwriting either side.
 */
export function useFlowEditor(flowId: Ref<string>) {
	const uiux = useUiuxClient()
	const { t } = useI18n()
	const feedback = useWorkbenchFeedback()
	const workbench = useWorkbench()

	const read = shallowRef<FlowRead>()
	const saved = shallowRef<FlowDraft>()
	const draft = ref<FlowDraft>()
	const lossless = ref(true)
	const loading = ref(false)
	const notFound = ref(false)
	const loadError = ref<string>()
	const saving = ref(false)
	const conflict = ref(false)
	const saveError = ref<FetchErrorDetails>()
	/** A save refused by someone else's edit lease (`423 resource.locked`); the draft is kept, as with 409. */
	const locked = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()
	let loadSequence = 0

	async function load(): Promise<void> {
		const id = flowId.value
		const sequence = ++loadSequence
		loadError.value = undefined
		notFound.value = false
		if (!id) {
			read.value = undefined
			saved.value = undefined
			draft.value = undefined
			return
		}
		loading.value = true
		try {
			const result = await uiux.readResource<FlowRead>('flow', id)
			if (sequence !== loadSequence) return
			if (!result) {
				notFound.value = true
				read.value = undefined
				saved.value = undefined
				draft.value = undefined
				return
			}
			const projected = toFlowDraft(result.resource)
			read.value = result
			saved.value = projected.draft
			draft.value = cloneDraft(projected.draft)
			lossless.value = projected.lossless
			conflict.value = false
			saveError.value = undefined
			locked.value = undefined
		}
		catch (cause) {
			if (sequence !== loadSequence) return
			loadError.value = describeFetchError(cause, t('flows.detail.loadFailed')).message
		}
		finally {
			if (sequence === loadSequence) loading.value = false
		}
	}

	watch(flowId, () => { void load() }, { immediate: true })

	// ---------------------------------------------------------------------------------------------
	// Reference facts about target Views (name, Variants, Widgets), cached per View revision.
	// ---------------------------------------------------------------------------------------------

	const viewFacts = shallowRef<FlowViewIndex>(new Map())
	const factCache = new Map<string, { revision: string; facts: FlowViewFacts }>()
	let factSequence = 0

	/** Views a form is about to reference (e.g. Add step), so their Variants and Widgets are known first. */
	const requestedViewIds = ref<readonly string[]>([])
	function requestViewFacts(viewId: string): void {
		if (viewId && !requestedViewIds.value.includes(viewId)) requestedViewIds.value = [...requestedViewIds.value, viewId]
	}

	const referencedViewIds = computed(() => {
		const ids = new Set<string>(requestedViewIds.value)
		for (const step of Object.values(draft.value?.steps ?? {})) if (step.target.viewId) ids.add(step.target.viewId)
		return [...ids].sort()
	})

	async function refreshFacts(): Promise<void> {
		const sequence = ++factSequence
		const summaries = new Map(workbench.views.value.map(view => [view.key, view]))
		const next = new Map<string, FlowViewFacts | 'missing' | 'pending'>()
		const toLoad: string[] = []
		for (const viewId of referencedViewIds.value) {
			const summary = summaries.get(viewId)
			if (!summary) {
				next.set(viewId, workbench.loading.value ? 'pending' : 'missing')
				continue
			}
			const cached = factCache.get(viewId)
			if (cached && cached.revision === summary.revision) next.set(viewId, cached.facts)
			else {
				next.set(viewId, 'pending')
				toLoad.push(viewId)
			}
		}
		viewFacts.value = next
		if (!toLoad.length) return
		await Promise.all(toLoad.map(async (viewId) => {
			try {
				const view = await uiux.readResource<ViewRead>('view', viewId)
				if (!view) return
				const tree = deriveWidgetTree(view.resource.ir)
				const facts: FlowViewFacts = Object.freeze({
					name: view.resource.name || view.key,
					variants: Object.freeze(Object.keys(view.resource.variants ?? {})),
					...(tree.status === 'valid'
						? { widgets: new Map(flattenWidgetTree(tree.root).map(node => [node.id, node.type] as const)) }
						: {}),
				})
				factCache.set(viewId, { revision: view.revision, facts })
			}
			catch {
				// Unreadable View: it stays pending, so reference problems are not guessed.
			}
		}))
		if (sequence !== factSequence) return
		const settled = new Map(viewFacts.value)
		for (const viewId of toLoad) {
			const cached = factCache.get(viewId)
			if (cached) settled.set(viewId, cached.facts)
		}
		viewFacts.value = settled
	}

	watch([referencedViewIds, () => workbench.views.value, () => workbench.loading.value], () => { void refreshFacts() }, { immediate: true })

	function viewName(viewId: string): string {
		const facts = viewFacts.value.get(viewId)
		if (facts && typeof facts === 'object') return facts.name
		return workbench.views.value.find(view => view.key === viewId)?.summary.name || viewId
	}

	/** Widgets of a View, for trigger pickers; empty while unknown. */
	function viewWidgets(viewId: string): ReadonlyMap<string, string> {
		const facts = viewFacts.value.get(viewId)
		return facts && typeof facts === 'object' && facts.widgets ? facts.widgets : new Map()
	}

	function viewVariants(viewId: string): readonly string[] {
		const facts = viewFacts.value.get(viewId)
		return facts && typeof facts === 'object' ? facts.variants : []
	}

	/** A step reads as its target View; the step UUID stays in Details. */
	function stepLabel(stepId: string): string {
		const step = draft.value?.steps[stepId] ?? saved.value?.steps[stepId]
		if (!step) return t('flows.graph.missingStep')
		if (!step.target.viewId) return t('flows.inspector.noView')
		return viewFacts.value.get(step.target.viewId) === 'missing' ? t('flows.graph.missingView') : viewName(step.target.viewId)
	}

	const stepOrder = computed(() => new Map((draft.value ? orderSteps(draft.value).order : []).map((id, index) => [id, index + 1])))

	/** "3. Checkout": the reading-order number tells apart steps that open the same View. */
	function stepOrdinalLabel(stepId: string): string {
		const n = stepOrder.value.get(stepId)
		return n ? t('flows.inspector.stepOption', { n, step: stepLabel(stepId) }) : stepLabel(stepId)
	}

	function describeProblem(problem: FlowProblem): string {
		const trigger = problem.params.trigger ?? ''
		switch (problem.kind) {
			case 'unreachable': return t('flows.problems.unreachable', { step: problem.stepId ? stepOrdinalLabel(problem.stepId) : '' })
			case 'ambiguous': return t('flows.problems.ambiguous', { trigger })
			case 'missingTargetStep': return t('flows.problems.missingTargetStep', { trigger })
			case 'missingEntry': return t('flows.problems.missingEntry')
			case 'incomplete':
				if (problem.path === '/name') return t('flows.problems.nameRequired')
				return problem.edgeKey ? t('flows.problems.incompleteTrigger', { trigger }) : t('flows.problems.incompleteStep', { step: problem.stepId ? stepOrdinalLabel(problem.stepId) : '' })
			case 'missingView': return t('flows.problems.missingView', { id: problem.params.viewId ?? '' })
			case 'missingVariant': return t('flows.problems.missingVariant', { variant: problem.params.variant ?? '', view: problem.params.view ?? '' })
			case 'missingWidget': return t('flows.problems.missingWidget', { widgetId: problem.params.widgetId ?? '', view: problem.params.view ?? '' })
			default: return t('flows.problems.structure', { path: problem.path || '/' })
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Validation and gates
	// ---------------------------------------------------------------------------------------------

	const problems = computed(() => draft.value ? validateFlowDraft(draft.value, viewFacts.value) : [])
	const savedProblems = computed(() => saved.value ? validateFlowDraft(saved.value, viewFacts.value) : [])
	const checkingReferences = computed(() => !!saved.value && referencesPending(saved.value, viewFacts.value))
	const dirty = computed(() => !!draft.value && !sameDraft(draft.value, saved.value))
	const saveBlockers = computed(() => problems.value.filter(problem => problem.blocksSave))

	/** Why the saved Flow cannot play yet; empty when it can. Play always follows the saved Flow. */
	const playBlockedReason = computed<string | undefined>(() => {
		if (!saved.value) return t('flows.player.unavailable')
		if (dirty.value) return t('flows.player.saveFirst')
		if (checkingReferences.value) return t('flows.player.checking')
		if (savedProblems.value.length) return t('flows.cantPlay', savedProblems.value.length)
		return undefined
	})

	// ---------------------------------------------------------------------------------------------
	// Draft edits. Each one keeps the canonical keyed-steps shape; Save sends them as one update.
	// ---------------------------------------------------------------------------------------------

	function setName(name: string): void {
		if (draft.value) draft.value.name = name
	}

	function setEntry(stepId: string): void {
		if (draft.value?.steps[stepId]) draft.value.entryStepId = stepId
	}

	function setTarget(stepId: string, target: { viewId: string; variantName?: string }): void {
		const step = draft.value?.steps[stepId]
		if (!step) return
		step.target = { viewId: target.viewId, ...(target.variantName !== undefined ? { variantName: target.variantName } : {}) }
	}

	/** A new step always arrives with the transition that reaches it, so the draft stays reachable. */
	function addStep(input: { fromStepId: string; trigger: { widgetId: string; event: string }; viewId: string; variantName?: string }): string | undefined {
		const current = draft.value
		if (!current?.steps[input.fromStepId]) return undefined
		const stepId = randomUuid()
		current.steps[stepId] = {
			target: { viewId: input.viewId, ...(input.variantName ? { variantName: input.variantName } : {}) },
			transitions: [],
		}
		current.steps[input.fromStepId]!.transitions.push({ trigger: { ...input.trigger }, targetStepId: stepId })
		return stepId
	}

	/** Removes a step and every transition that targets it (the impact is shown before confirming). */
	function removeStep(stepId: string): void {
		const current = draft.value
		if (!current?.steps[stepId] || current.entryStepId === stepId) return
		delete current.steps[stepId]
		for (const step of Object.values(current.steps))
			step.transitions = step.transitions.filter(transition => transition.targetStepId !== stepId)
	}

	function addTransition(stepId: string, transition: FlowTransitionDraft): number | undefined {
		const step = draft.value?.steps[stepId]
		if (!step) return undefined
		step.transitions.push({ trigger: { ...transition.trigger }, targetStepId: transition.targetStepId })
		return step.transitions.length - 1
	}

	function updateTransition(stepId: string, index: number, patch: Partial<{ widgetId: string; event: string; targetStepId: string }>): void {
		const transition = draft.value?.steps[stepId]?.transitions[index]
		if (!transition) return
		if (patch.widgetId !== undefined) transition.trigger.widgetId = patch.widgetId
		if (patch.event !== undefined) transition.trigger.event = patch.event
		if (patch.targetStepId !== undefined) transition.targetStepId = patch.targetStepId
	}

	function removeTransition(stepId: string, index: number): void {
		draft.value?.steps[stepId]?.transitions.splice(index, 1)
	}

	function discard(): void {
		if (saved.value) draft.value = cloneDraft(saved.value)
		saveError.value = undefined
		locked.value = undefined
	}

	/** One atomic `update_flow` with the revision this draft started from. A 409 keeps the draft. */
	async function save(): Promise<boolean> {
		const current = draft.value
		const base = read.value
		if (!current || !base || saving.value || !dirty.value || saveBlockers.value.length) return false
		saving.value = true
		saveError.value = undefined
		locked.value = undefined
		const sent = cloneDraft(current)
		try {
			await $fetch(`/api/flows/${encodeURIComponent(base.key)}`, {
				method: 'PUT',
				body: { expectedRevision: base.revision, ...draftToCanonical(sent) },
			})
			await load()
			// Anything edited while the save was in flight stays as unsaved changes.
			if (draft.value && !sameDraft(sent, current)) draft.value = cloneDraft(current)
			feedback.success(t('flows.save.saved'))
			void workbench.refreshCounts()
			return true
		}
		catch (cause) {
			const details = describeFetchError(cause, t('flows.save.failed'))
			if (details.statusCode === 409 || details.status === 'conflict') conflict.value = true
			else if (isLockedError(details)) locked.value = { lock: details.lock }
			else saveError.value = details
			void focusFirstProblem('main')
			return false
		}
		finally {
			saving.value = false
		}
	}

	/** Conflict recovery: take the current canonical Flow and drop this draft. */
	async function reloadTheirs(): Promise<void> {
		conflict.value = false
		await load()
	}

	return {
		read,
		saved,
		draft,
		lossless,
		loading,
		notFound,
		loadError,
		saving,
		conflict,
		saveError,
		locked,
		dirty,
		problems,
		savedProblems,
		saveBlockers,
		checkingReferences,
		playBlockedReason,
		viewFacts,
		viewName,
		viewWidgets,
		viewVariants,
		stepLabel,
		stepOrdinalLabel,
		describeProblem,
		requestViewFacts,
		incoming: (stepId: string) => draft.value ? incomingTransitions(draft.value, stepId) : [],
		load,
		setName,
		setEntry,
		setTarget,
		addStep,
		removeStep,
		addTransition,
		updateTransition,
		removeTransition,
		discard,
		save,
		reloadTheirs,
	}
}

export type FlowEditor = ReturnType<typeof useFlowEditor>

const FLOW_EDITOR_KEY: InjectionKey<FlowEditor> = Symbol('uiux-flow-editor')

/** The Flow page shares one editor with its graph, list, inspector and player. */
export function provideFlowEditor(editor: FlowEditor): void {
	provide(FLOW_EDITOR_KEY, editor)
}

export function injectFlowEditor(): FlowEditor {
	const editor = inject(FLOW_EDITOR_KEY)
	if (!editor) throw new Error('injectFlowEditor() must be used below provideFlowEditor().')
	return editor
}
