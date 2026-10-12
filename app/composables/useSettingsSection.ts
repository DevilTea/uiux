import { computed, reactive, ref, shallowRef } from 'vue'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
import type { FetchErrorDetails } from '../utils/fetch-error'
import { cloneJson, diffJson, sameJson, type SettingsSectionId } from '../utils/workspace-authoring'

/**
 * One Workspace settings section with its own draft, base revision and conflict state
 * (brief g, "Save per section"). Its value comes from one revisioned resource `R`: the manifest,
 * or from `schemaVersion` 5 the Product Kit file for the Adapters section.
 *
 * Sync rules when a newer read of the resource arrives:
 * - no draft: adopt it;
 * - the newer value already equals the draft (our own save landed): adopt it;
 * - the newer value left this section untouched: move the base revision forward and keep the draft;
 * - otherwise: raise the conflict and keep the draft. Nothing is merged.
 */
export type SettingsSection<D, R = WorkspaceManifest> = ReturnType<typeof createSettingsSection<D, R>>

/** A revisioned read of the section's resource. */
export type SettingsSectionRead<R> = Readonly<{ revision: string; resource: R }>

export function createSettingsSection<D, R = WorkspaceManifest>(options: Readonly<{
	id: SettingsSectionId
	fromManifest: (resource: R) => D
	toPayload: (draft: D) => unknown
}>) {
	const base = shallowRef<{ revision: string; draft: D }>()
	const draft = ref<D>()
	const conflict = ref(false)
	const saving = ref(false)
	const error = shallowRef<FetchErrorDetails>()
	/** The newest server value of this section, for the Compare dialog. */
	const theirs = shallowRef<unknown>()

	const savedPayload = computed(() => base.value ? options.toPayload(base.value.draft) : undefined)
	const draftPayload = computed(() => draft.value === undefined ? undefined : options.toPayload(draft.value as D))
	const dirty = computed(() => !!base.value && !sameJson(savedPayload.value, draftPayload.value))
	const changeCount = computed(() => dirty.value ? Math.max(1, diffJson(savedPayload.value, draftPayload.value).length) : 0)

	function adopt(read: SettingsSectionRead<R>): void {
		const value = options.fromManifest(read.resource)
		base.value = { revision: read.revision, draft: cloneJson(value) }
		draft.value = value
		theirs.value = options.toPayload(value)
		conflict.value = false
		error.value = undefined
	}

	function sync(read: SettingsSectionRead<R> | undefined): void {
		if (!read?.resource) return
		const latest = options.toPayload(options.fromManifest(read.resource))
		theirs.value = latest
		if (!base.value || !dirty.value) return adopt(read)
		if (base.value.revision === read.revision) return
		if (sameJson(latest, draftPayload.value)) return adopt(read)
		if (sameJson(latest, savedPayload.value)) {
			base.value = { revision: read.revision, draft: base.value.draft }
			return
		}
		conflict.value = true
	}

	/** "Keep mine": carry the draft onto the newer revision, still unsaved. */
	function keepMine(read: SettingsSectionRead<R> | undefined): void {
		if (!read?.resource) return
		base.value = { revision: read.revision, draft: options.fromManifest(read.resource) }
		conflict.value = false
	}

	function setDraft(value: D): void {
		draft.value = value as typeof draft.value
	}

	function clearError(): void {
		error.value = undefined
	}

	return reactive({
		id: options.id,
		base,
		draft,
		conflict,
		saving,
		error,
		theirs,
		draftPayload,
		dirty,
		changeCount,
		adopt,
		sync,
		keepMine,
		setDraft,
		clearError,
	})
}
