import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { describeFetchError, isLockedError, type FetchErrorDiagnostic, type FetchErrorLock } from '../utils/fetch-error'
import { viewMetadataChange, viewMetadataDraftOf, type ViewMetadataDraft } from '../utils/view-metadata'
import { useAccess } from './useAccess'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'
import { useWorkbenchFeedback } from './useWorkbenchFeedback'
import type { ViewRead } from './workbench-types'

/**
 * Renaming the open View and setting or clearing its `feature` tag in place, from the View page
 * header, on every device tier (Rule 01a1537a-333f-7246-b39c-5feca6f4b3c7), through the View
 * metadata operation `PUT /api/views/:id/metadata` (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85).
 * Like the Spec editor: the revision read when editing starts is the `expectedRevision`; a 409
 * keeps the draft and never overwrites; while someone else holds the View's edit lease nothing
 * opens and Save waits, and a `423 resource.locked` keeps the draft as a 409 does.
 */
export function useViewMetadataEditor() {
	const { t } = useI18n()
	const workbench = useWorkbench()
	const uiux = useUiuxClient()
	const feedback = useWorkbenchFeedback()
	const access = useAccess()

	const editing = ref(false)
	const draft = ref<ViewMetadataDraft>({ name: '', feature: '' })
	const saving = ref(false)
	/** The View, revision, name and tag the draft is based on. */
	const base = shallowRef<Readonly<{ viewId: string; revision: string; name: string; feature?: string }>>()
	/** A save refused because the View changed underneath; `latest` is the View as saved now. */
	const conflict = shallowRef<Readonly<{ latest?: ViewRead }>>()
	const locked = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()
	const invalid = shallowRef<readonly FetchErrorDiagnostic[]>()
	const nameError = ref<string>()

	const canRename = computed(() => !!workbench.selectedView.value && workbench.canWrite('views.write'))
	/** Someone else (an agent) holds the edit lease on the View. */
	const heldByOther = computed(() => !!access.lockFor('view', base.value?.viewId ?? workbench.selectedViewId.value))

	function baseOf(view: ViewRead) {
		return { viewId: view.key, revision: view.revision, name: view.resource.name, ...(view.resource.feature === undefined ? {} : { feature: view.resource.feature }) }
	}

	function start(): void {
		const view = workbench.selectedView.value
		if (!view || !canRename.value || heldByOther.value || saving.value) return
		base.value = baseOf(view)
		draft.value = viewMetadataDraftOf(view.resource)
		editing.value = true
		conflict.value = undefined
		locked.value = undefined
		invalid.value = undefined
		nameError.value = undefined
	}

	function cancel(): void {
		if (saving.value) return
		editing.value = false
		base.value = undefined
		conflict.value = undefined
		locked.value = undefined
		invalid.value = undefined
		nameError.value = undefined
	}

	// Another View is another resource; this draft cannot apply to it.
	watch(() => workbench.selectedViewId.value, (id) => {
		if (base.value && base.value.viewId !== id) { saving.value = false; cancel() }
	})

	async function save(): Promise<boolean> {
		const from = base.value
		if (!from || saving.value || conflict.value || heldByOther.value) return false
		nameError.value = draft.value.name.trim() ? undefined : t('viewHeader.nameRequired')
		if (nameError.value) return false
		const change = viewMetadataChange(from, draft.value)
		if (!change) {
			cancel()
			return true
		}
		saving.value = true
		invalid.value = undefined
		locked.value = undefined
		try {
			await $fetch(`/api/views/${encodeURIComponent(from.viewId)}/metadata`, {
				method: 'PUT',
				body: { expectedRevision: from.revision, ...change },
			})
			saving.value = false
			cancel()
			feedback.success(t('viewHeader.saved'))
			await workbench.loadSelectedView()
			void workbench.refreshCounts()
			return true
		}
		catch (cause) {
			const details = describeFetchError(cause, t('viewHeader.saveFailed'))
			if (details.statusCode === 409 || details.status === 'conflict') {
				conflict.value = {}
				const latest = await uiux.readResource<ViewRead>('view', from.viewId).catch(() => undefined)
				if (conflict.value && base.value === from) conflict.value = { latest }
			}
			else if (isLockedError(details)) {
				locked.value = { lock: details.lock }
			}
			else if (details.statusCode === 400 || details.status === 'invalid') {
				invalid.value = details.diagnostics.length ? details.diagnostics : [{ message: details.message, localized: true }]
			}
			else {
				feedback.error(cause, t('viewHeader.saveFailed'))
			}
			return false
		}
		finally {
			saving.value = false
		}
	}

	/** Drops the draft and shows the View as saved now. */
	async function discardMine(): Promise<void> {
		cancel()
		await workbench.loadSelectedView()
	}

	/** Keeps the draft and bases the next save on the View as saved now; nothing is saved yet. */
	async function keepMine(): Promise<void> {
		const latest = conflict.value?.latest
		if (!latest || !base.value) return
		base.value = baseOf(latest)
		conflict.value = undefined
		await workbench.loadSelectedView()
	}

	return { editing, draft, saving, conflict, locked, invalid, nameError, canRename, heldByOther, start, cancel, save, discardMine, keepMine }
}

export type ViewMetadataEditor = ReturnType<typeof useViewMetadataEditor>
