import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { describeFetchError, isLockedError, type FetchErrorDiagnostic, type FetchErrorLock } from '../utils/fetch-error'
import {
	isAbsoluteUri,
	normalizeList,
	referenceDraftOf,
	referenceFromDraft,
	specContentOf,
	withSpecSection,
	type ReferenceDraft,
	type SpecContent,
	type SpecListSection,
	type SpecSectionKey,
} from '../utils/widget-inspection'
import { useAccess } from './useAccess'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbenchFeedback } from './useWorkbenchFeedback'
import type { Workbench } from './useWorkbench'
import type { ViewRead } from './workbench-types'
import { focusFirstProblem } from '../utils/focus-problem'

/** The draft of the one Spec section being edited. */
export type SpecDraft =
	| { section: 'intent'; intent: string }
	| { section: SpecListSection; items: string[] }
	| { section: 'references'; references: ReferenceDraft[] }

/** A save refused because the Spec changed underneath: the draft is kept, nothing is merged. */
export type SpecConflict = Readonly<{
	/** The View as saved now, read after the refusal; `undefined` while it loads or if it is gone. */
	latest?: ViewRead
	comparing: boolean
}>

/**
 * Per-section Spec editing through `update_view_spec` (`PUT /api/views/:id/spec`). The revision
 * observed when editing starts is the `expectedRevision`; a 409 shows the conflict and never
 * overwrites. The rest of the Spec is sent exactly as it was read, and Decisions are preserved
 * by the server. Editing needs Editor or above; while someone else holds the View's edit lease
 * nothing new opens and Save waits, and a `423 resource.locked` keeps the draft as a 409 does.
 */
export function useSpecEditor(workbench: Workbench) {
	const { t } = useI18n()
	const uiux = useUiuxClient()
	const feedback = useWorkbenchFeedback()
	const access = useAccess()

	const editing = ref<SpecSectionKey>()
	const draft = ref<SpecDraft>()
	const saving = ref(false)
	const conflict = shallowRef<SpecConflict>()
	const invalid = shallowRef<readonly FetchErrorDiagnostic[]>()
	const fieldErrors = ref<Record<string, string>>({})
	/** A save refused by someone else's edit lease (`423 resource.locked`); the draft is kept. */
	const locked = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()
	/** The View, revision and content the draft is based on. */
	const base = shallowRef<Readonly<{ viewId: string; revision: string; content: SpecContent }>>()
	/** Someone else (an agent) holds the edit lease on the View being edited or shown. */
	const heldByOther = computed(() => !!access.lockFor('view', base.value?.viewId ?? workbench.selectedViewId.value))

	function draftOf(view: ViewRead, section: SpecSectionKey): SpecDraft {
		const spec = view.resource.spec
		if (section === 'intent') return { section, intent: spec.intent }
		if (section === 'references') return { section, references: spec.references.map(referenceDraftOf) }
		return { section, items: spec[section].length ? [...spec[section]] : [''] }
	}

	function start(section: SpecSectionKey): void {
		const view = workbench.selectedView.value
		if (!view || workbench.authorReadOnly.value || access.lockFor('view', view.key) || saving.value) return
		editing.value = section
		draft.value = draftOf(view, section)
		base.value = { viewId: view.key, revision: view.revision, content: specContentOf(view) }
		conflict.value = undefined
		locked.value = undefined
		invalid.value = undefined
		fieldErrors.value = {}
	}

	function cancel(): void {
		if (saving.value) return
		editing.value = undefined
		draft.value = undefined
		base.value = undefined
		conflict.value = undefined
		locked.value = undefined
		invalid.value = undefined
		fieldErrors.value = {}
	}

	// A different View is a different document; its draft cannot apply here.
	watch(() => workbench.selectedViewId.value, (id) => {
		if (base.value && base.value.viewId !== id) { saving.value = false; cancel() }
	})

	function validate(value: SpecDraft): Record<string, string> {
		const errors: Record<string, string> = {}
		if (value.section !== 'references') return errors
		value.references.forEach((reference, index) => {
			if (reference.type === 'external' && !isAbsoluteUri(reference.uri)) errors[`references.${index}.uri`] = t('spec.ref.uriInvalid')
			if (reference.type === 'view' && !reference.viewId) errors[`references.${index}.viewId`] = t('spec.ref.viewRequired')
		})
		return errors
	}

	function sectionValue(value: SpecDraft) {
		if (value.section === 'intent') return value.intent.trim()
		if (value.section === 'references') return value.references.map(referenceFromDraft)
		return normalizeList(value.items)
	}

	async function save(): Promise<void> {
		const value = draft.value
		const from = base.value
		if (!value || !from || saving.value || conflict.value || heldByOther.value) return
		fieldErrors.value = validate(value)
		if (Object.keys(fieldErrors.value).length) {
			void focusFirstProblem('[data-spec-editor]')
			return
		}
		saving.value = true
		invalid.value = undefined
		locked.value = undefined
		try {
			await $fetch(`/api/views/${encodeURIComponent(from.viewId)}/spec`, {
				method: 'PUT',
				body: { expectedRevision: from.revision, spec: withSpecSection(from.content, value.section, sectionValue(value)) },
			})
			saving.value = false
			cancel()
			feedback.success(t('spec.saved'))
			await workbench.loadSelectedView()
			void workbench.refreshCounts()
		}
		catch (cause) {
			const details = describeFetchError(cause, t('spec.saveFailed'))
			if (details.statusCode === 409 || details.status === 'conflict') {
				conflict.value = { comparing: false }
				const latest = await uiux.readResource<ViewRead>('view', from.viewId).catch(() => undefined)
				if (conflict.value && base.value === from) conflict.value = { ...conflict.value, latest }
			}
			else if (isLockedError(details)) {
				locked.value = { lock: details.lock }
			}
			else if (details.statusCode === 400 || details.status === 'invalid') {
				invalid.value = details.diagnostics.length ? details.diagnostics : [{ message: details.message, localized: true }]
			}
			else {
				feedback.error(cause, t('spec.saveFailed'))
			}
			void focusFirstProblem('[data-spec-editor]')
		}
		finally {
			saving.value = false
		}
	}

	/** Shows the saved version of this section beside the draft. */
	function reviewTheirs(): void {
		if (conflict.value) conflict.value = { ...conflict.value, comparing: !conflict.value.comparing }
	}

	/** Drops the draft and shows the saved Spec. */
	async function discardMine(): Promise<void> {
		cancel()
		await workbench.loadSelectedView()
	}

	/**
	 * After reviewing their version, continue from it: the draft stays in the editor and the next
	 * save targets the revision just read. Nothing is saved until the reviewer saves again.
	 */
	async function keepMine(): Promise<void> {
		const latest = conflict.value?.latest
		if (!latest || !base.value) return
		base.value = { viewId: latest.key, revision: latest.revision, content: specContentOf(latest) }
		conflict.value = undefined
		await workbench.loadSelectedView()
	}

	const theirs = computed(() => {
		const latest = conflict.value?.latest
		return latest && editing.value ? draftOf(latest, editing.value) : undefined
	})

	return {
		editing,
		draft,
		saving,
		conflict,
		locked,
		heldByOther,
		theirs,
		invalid,
		fieldErrors,
		start,
		cancel,
		save,
		reviewTheirs,
		discardMine,
		keepMine,
	}
}

export type SpecEditor = ReturnType<typeof useSpecEditor>
