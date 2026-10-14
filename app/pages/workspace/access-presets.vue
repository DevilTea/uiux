<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { BUILT_IN_ACCESS_PRESETS, isHumanOnlyKey } from '../../../src/application/access/keys'
import type { MemberLabel } from '../../../src/application/access/labels'
import type { MemberKind } from '../../../src/application/access/principal'
import { ACCESS_PRESETS_FILENAME, labelPresetsOf, presetNameKey, type AccessPreset } from '../../../src/domain/access-presets/schema'
import { useAccess } from '../../composables/useAccess'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import {
	holdersOf,
	memberUpdates,
	newPresetId,
	normalizePresetName,
	presetNameProblem,
	presetWithKeys,
	sameKeySet,
	unknownPresetKeys,
	type MemberUpdate,
} from '../../utils/access-presets'
import { describeFetchError, type FetchErrorDetails, type FetchErrorDiagnostic } from '../../utils/fetch-error'
import { orderedKeys } from '../../utils/member-keys'
import MemberKeyEditor from '../../components/access/MemberKeyEditor.vue'
import WbErrorDescription from '../../components/workbench/WbErrorDescription.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'
import AuthoringAccessNotice from '../../components/workspace/AuthoringAccessNotice.vue'
import WorkspaceSubnav from '../../components/workspace/WorkspaceSubnav.vue'

/**
 * Access presets (Feature 01a11c09-984a-7835-95ef-67164dd91746) at `/workspace/access-presets`
 * (Clause 01a11c09-b049-71cd-9315-d3652838a378):
 *
 * - the presets in file order, each with its key count and the number of members on this host it
 *   labels (Rule 01a11c09-cd38-72c0-9af6-4598454bdcfc), names as written (Rule
 *   01a11c09-cef3-7767-9d95-c3b89510aea3), a preset holding an unknown key flagged (Rule
 *   01a11c09-ca9b-7c86-9277-22b0397bee03);
 * - on a desktop layout a holder of `presets.manage` adds, renames, edits the keys of, reorders and
 *   deletes presets; for anyone else the page is read-only (Rule 01a11c09-cda4-748c-9e2e-5929c8447269);
 * - an edit that would make two presets equal is refused inline, before saving (Rule
 *   01a11c09-ce14-7f47-bea9-9db3d283abf7);
 * - after a key edit, how many members on this host held the old keys (Rule
 *   01a11c09-ce86-702c-ae37-b284b4d818b4), then a separate step, needing `members.manage`, that gives
 *   them the new keys on this host only (Rule 01a11c33-2761-7fab-b0e5-c0f1863cb638).
 *
 * Every write is `update_access_presets` over `PUT /api/access-presets` with the revision read, so
 * a missing file is created (`expectedRevision: null`) and a file that is not JSON is replaced
 * (#140 owner rulings of 2026-10-12). The member counts come from the host's roster, which only a
 * holder of `members.manage` on an origin that serves roster administration may read.
 */
type Diagnostic = Readonly<{ code: string; path?: string; message: string }>
type PresetsRead = Readonly<{ resource: unknown; revision: string | null; diagnostics: readonly Diagnostic[] }>
type HostMember = Readonly<{ id: string; nickname: string; kind: MemberKind; keys: readonly string[]; label: MemberLabel }>
type CountsUnavailable = 'key' | 'origin' | 'error'

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const { t } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const { access: authoringAccess, writeKey, canEdit: deviceAllowsEdit } = useAuthoringAccess('presets.manage')

const state = ref<'loading' | 'ready' | 'legacy' | 'error'>('loading')
const read = ref<PresetsRead>()
const loadError = shallowRef<FetchErrorDetails>()
const members = ref<readonly HostMember[]>()
const countsUnavailable = ref<CountsUnavailable>()

/** Below `schemaVersion` 6 the built-in presets label members (Rule 01a11c09-cb79-744e-bbf6-ec38d6f159ba). */
const BUILT_IN: readonly AccessPreset[] = BUILT_IN_ACCESS_PRESETS.map(preset => ({ id: preset.id, name: preset.name, keys: [...preset.keys] }))
const presets = computed<readonly AccessPreset[]>(() => state.value === 'legacy' ? BUILT_IN : labelPresetsOf(read.value?.resource))
const diagnostics = computed(() => read.value?.diagnostics ?? [])
/** Problems of a file that parses; a preset's unknown keys are flagged on its row instead. */
const fileIssues = computed<FetchErrorDiagnostic[]>(() => diagnostics.value.filter(item => item.code !== 'access.unknown_key'))
const fileState = computed<'missing' | 'unparsable' | 'issues' | 'ok'>(() => {
	if (diagnostics.value.some(item => item.code === 'access.presets_missing')) return 'missing'
	if (read.value && read.value.resource === null) return 'unparsable'
	return fileIssues.value.length > 0 ? 'issues' : 'ok'
})
const canEdit = computed(() => deviceAllowsEdit.value && state.value === 'ready')

async function loadPresets(): Promise<void> {
	try {
		read.value = await api<PresetsRead>('/api/access-presets')
		state.value = 'ready'
		loadError.value = undefined
	}
	catch (cause) {
		const details = describeFetchError(cause, t('access.presets.loadError'))
		// 404: a Workspace below schemaVersion 6, which keeps no presets file.
		if (details.statusCode === 404) state.value = 'legacy'
		else {
			state.value = 'error'
			loadError.value = details
		}
	}
}

async function loadMembers(): Promise<void> {
	if (!access.can('members.manage')) {
		members.value = undefined
		countsUnavailable.value = 'key'
		return
	}
	try {
		members.value = (await api<{ members: HostMember[] }>('/api/access/members')).members
		countsUnavailable.value = undefined
	}
	catch (cause) {
		members.value = undefined
		countsUnavailable.value = describeFetchError(cause, t('access.presets.loadError')).code === 'access.admin_origin_rejected' ? 'origin' : 'error'
	}
}

const loading = computed(() => state.value === 'loading')
onMounted(() => { void Promise.all([loadPresets(), loadMembers()]) })

/** The members on this host that a preset labels now (Rule 01a11c09-cd38-72c0-9af6-4598454bdcfc). */
function labeledCount(preset: AccessPreset): number | undefined {
	return members.value?.filter(member => 'preset' in member.label && member.label.preset.id === preset.id).length
}
const countHelp = computed(() => countsUnavailable.value ? t(`access.presets.countUnavailable.${countsUnavailable.value}`) : '')

// ---- Writes ----
const writing = ref(false)

/** Writes the whole presets array against the revision read; the server checks it again. */
async function writePresets(next: readonly AccessPreset[]): Promise<void> {
	await api('/api/access-presets', {
		method: 'PUT',
		body: { expectedRevision: read.value?.revision ?? null, presets: next.map(preset => ({ id: preset.id, name: preset.name, keys: [...preset.keys] })) },
	})
	await loadPresets()
	// The signed-in member's own label may have changed.
	void access.reload()
}

async function write(next: readonly AccessPreset[], success: string): Promise<boolean> {
	if (writing.value) return false
	writing.value = true
	try {
		await writePresets(next)
		feedback.success(success)
		return true
	}
	catch (cause) {
		feedback.error(cause, t('access.presets.errorTitle'))
		await loadPresets()
		return false
	}
	finally {
		writing.value = false
	}
}

function move(index: number, by: -1 | 1): void {
	const next = [...presets.value]
	const [moved] = next.splice(index, 1)
	next.splice(index + by, 0, moved!)
	void write(next, t('access.presets.reordered'))
}

async function useBuiltIns(): Promise<void> {
	await write(BUILT_IN, t('access.presets.usedBuiltIns'))
	await loadMembers()
}

// ---- Add, edit or view a preset ----
/** The preset being edited is found by its `id`, so a reload after a conflict keeps the right one. */
type Editor = { id?: string; openedName: string; name: string; keys: string[]; readonly: boolean }
const editorOpen = ref(false)
const editor = reactive<Editor>({ openedName: '', name: '', keys: [], readonly: false })
const editorError = shallowRef<FetchErrorDetails>()
const editorIndex = computed(() => {
	const index = editor.id === undefined ? -1 : presets.value.findIndex(preset => preset.id === editor.id)
	return index < 0 ? undefined : index
})
const editing = computed(() => editorIndex.value === undefined ? undefined : presets.value[editorIndex.value])
/**
 * The preset being edited is gone from the presets read again after a conflict: saving would add it
 * back under a new id, so the editor refuses and says so instead.
 */
const editorRemoved = computed(() => editor.id !== undefined && editing.value === undefined)
/** The other presets the editor may start from. */
const otherPresets = computed(() => presets.value.filter((_, index) => index !== editorIndex.value))

function openAdd(): void {
	Object.assign(editor, { id: undefined, openedName: '', name: '', keys: [], readonly: false })
	editorError.value = undefined
	editorOpen.value = true
}

function openPreset(index: number): void {
	const preset = presets.value[index]
	if (!preset) return
	Object.assign(editor, { id: preset.id, openedName: preset.name, name: preset.name, keys: [...preset.keys], readonly: !canEdit.value })
	editorError.value = undefined
	editorOpen.value = true
}

/** Rule 01a11c09-ce14-7f47-bea9-9db3d283abf7: equal presets are refused before saving. */
const duplicate = computed(() => editor.readonly ? undefined : presetWithKeys(presets.value, editor.keys, editorIndex.value))
const nameProblem = computed(() => editor.readonly ? undefined : presetNameProblem(presets.value, editor.name, editorIndex.value))
const nameError = computed(() => {
	const problem = nameProblem.value
	if (!problem) return undefined
	const taken = problem === 'taken' ? presets.value.find((preset, index) => index !== editorIndex.value && presetNameKey(preset.name) === presetNameKey(editor.name)) : undefined
	return t(`access.presets.nameProblem.${problem}`, { name: taken?.name ?? normalizePresetName(editor.name) })
})
const editorChanged = computed(() => {
	const before = editing.value
	return !before || before.name !== normalizePresetName(editor.name) || !sameKeySet(before.keys, editor.keys)
})
const canSave = computed(() => !editor.readonly && !editorRemoved.value && !duplicate.value && !nameProblem.value && editorChanged.value)

// ---- After a key edit: the members on this host who held the old keys ----
type FollowUp = Readonly<{ name: string; keys: readonly string[]; holders?: readonly HostMember[] }>
const followUp = ref<FollowUp>()

async function saveEditor(): Promise<void> {
	if (!canSave.value || writing.value) return
	const name = normalizePresetName(editor.name)
	const before = editing.value
	const edited: AccessPreset = { id: before?.id ?? newPresetId(name, presets.value), name, keys: orderedKeys(editor.keys) }
	const next = before ? presets.value.map(preset => preset.id === before.id ? edited : preset) : [...presets.value, edited]
	const keysChanged = before !== undefined && !sameKeySet(before.keys, edited.keys)
	writing.value = true
	editorError.value = undefined
	try {
		// Counted against the roster as it is now, read again because it may have changed since the
		// page loaded it (from the CLI or another Workbench), and before the write changes any label.
		if (keysChanged) await loadMembers()
		const holders = keysChanged && members.value ? holdersOf(before, members.value) : undefined
		await writePresets(next)
		feedback.success(before ? t('access.presets.saved', { name }) : t('access.presets.added', { name }))
		editorOpen.value = false
		if (keysChanged) {
			followUp.value = { name, keys: edited.keys, ...(holders ? { holders } : {}) }
			updatedIds.value = new Set()
		}
		await loadMembers()
	}
	catch (cause) {
		editorError.value = describeFetchError(cause, t('access.presets.errorTitle'))
		// Someone changed the file meanwhile: read it again, keeping the draft, so saving again
		// checks the draft against the newer presets and names their revision.
		if (editorError.value.statusCode === 409) await loadPresets()
	}
	finally {
		writing.value = false
	}
}

// ---- "Also update these members": this host's roster only ----
const updateOpen = ref(false)
const updating = ref(false)
const updateFailures = ref<readonly Readonly<{ nickname: string; error: FetchErrorDetails }>[]>([])
/** The holders this follow-up already updated: a retry after a partial failure sends only the rest. */
const updatedIds = ref<ReadonlySet<string>>(new Set())
const updates = computed<MemberUpdate<HostMember>[]>(() => followUp.value?.holders
	? memberUpdates(followUp.value.keys, followUp.value.holders).filter(update => !updatedIds.value.has(update.member.id))
	: [])
const dropsHumanOnly = computed(() => Boolean(followUp.value?.keys.some(isHumanOnlyKey) && updates.value.some(update => update.member.kind === 'agent')))

function openUpdate(): void {
	updateFailures.value = []
	updateOpen.value = true
}

async function updateMembers(): Promise<void> {
	if (updating.value) return
	updating.value = true
	const failures: { nickname: string; error: FetchErrorDetails }[] = []
	const pending = updates.value
	const done = new Set(updatedIds.value)
	let updated = 0
	try {
		for (const update of pending) {
			try {
				// Only the keys to grant and revoke: the server applies them to the member's current keys
				// (owner ruling 1 of 2026-10-11 on PR #191).
				await api(`/api/access/members/${encodeURIComponent(update.member.id)}`, {
					method: 'PATCH',
					body: { ...(update.grant.length > 0 ? { grant: update.grant } : {}), ...(update.revoke.length > 0 ? { revoke: update.revoke } : {}) },
				})
				done.add(update.member.id)
				updated += 1
			}
			catch (cause) {
				failures.push({ nickname: update.member.nickname, error: describeFetchError(cause, t('access.members.errorTitle')) })
			}
		}
	}
	finally {
		updatedIds.value = done
		updating.value = false
	}
	if (updated > 0) feedback.success(t('access.presets.update.done', { n: updated }, updated))
	if (pending.some(update => update.member.id === access.member.value?.id && done.has(update.member.id))) await access.reload()
	await loadMembers()
	updateFailures.value = failures
	if (failures.length === 0) {
		updateOpen.value = false
		followUp.value = undefined
	}
}

// ---- Delete ----
/** The preset to delete, by its `id`: a reload after a conflict may move it, or remove it. */
const deleting = ref<string>()
const deletingPreset = computed(() => deleting.value === undefined ? undefined : presets.value.find(preset => preset.id === deleting.value))
async function deletePreset(): Promise<void> {
	const preset = deletingPreset.value
	if (!preset) return
	if (await write(presets.value.filter(item => item.id !== preset.id), t('access.presets.deleted', { name: preset.name }))) {
		deleting.value = undefined
		await loadMembers()
	}
	else if (deleting.value !== undefined && !deletingPreset.value) {
		// The presets read again no longer hold it: someone else deleted it meanwhile.
		deleting.value = undefined
		feedback.notice(t('access.presets.deletedMeanwhile', { name: preset.name }))
	}
}

function presetActions(index: number): DropdownMenuItem[][] {
	return [
		[
			{ label: t('access.presets.edit'), icon: 'i-lucide-pencil', onSelect: () => openPreset(index) },
			{ label: t('access.presets.moveUp'), icon: 'i-lucide-arrow-up', disabled: index === 0, onSelect: () => move(index, -1) },
			{ label: t('access.presets.moveDown'), icon: 'i-lucide-arrow-down', disabled: index === presets.value.length - 1, onSelect: () => move(index, 1) },
		],
		[{ label: t('access.presets.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => { deleting.value = presets.value[index]?.id } }],
	]
}

type Row = Readonly<{ index: number; preset: AccessPreset }>
const rows = computed<Row[]>(() => presets.value.map((preset, index) => ({ index, preset })))
const columns = computed<TableColumn<Row>[]>(() => [
	{ id: 'name', header: t('access.presets.columns.name') },
	{ id: 'keys', header: t('access.presets.columns.keys') },
	{ id: 'members', header: t('access.presets.columns.members') },
	...(canEdit.value ? [{ id: 'actions', header: () => h('span', { class: 'sr-only' }, t('access.members.actionsColumn')) }] : []),
])
const tableUi = { th: 'text-xs font-medium text-muted whitespace-nowrap', td: 'text-sm' }
const unknownHelp = (preset: AccessPreset) => t('access.presets.unknownKeysHelp', { keys: unknownPresetKeys(preset).join(', ') })
</script>

<template>
  <WorkbenchPage
    id="access-presets"
    :title="t('access.presets.title')"
  >
    <template #toolbar>
      <WorkspaceSubnav />
    </template>
    <div
      class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-y-auto"
      data-access-presets
      :data-state="state"
      :data-file-state="state === 'ready' ? fileState : undefined"
    >
      <header class="flex flex-wrap items-start justify-between gap-3 border-b border-default px-4 py-4">
        <div class="min-w-0 space-y-1">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('access.presets.title') }}
          </h1>
          <p class="text-sm text-muted">
            {{ t('access.presets.subtitle') }}
          </p>
          <i18n-t
            keypath="access.presets.fileHelp"
            tag="p"
            scope="global"
            class="text-xs text-dimmed"
          >
            <template #file>
              <code
                class="font-mono"
                translate="no"
              >{{ ACCESS_PRESETS_FILENAME }}</code>
            </template>
          </i18n-t>
          <AuthoringAccessNotice
            v-if="state !== 'legacy'"
            :access="authoringAccess"
            :write-key="writeKey"
          />
        </div>
        <UButton
          v-if="canEdit"
          color="primary"
          variant="solid"
          icon="i-lucide-plus"
          :disabled="writing"
          data-preset-add
          @click="openAdd"
        >
          {{ t('access.presets.add') }}
        </UButton>
      </header>

      <UAlert
        v-if="state === 'error' && loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="loadError.message"
        :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', icon: 'i-lucide-refresh-cw', onClick: () => { void loadPresets() } }]"
        :ui="{ root: 'rounded-none border-b border-default' }"
        data-presets-load-error
      >
        <template #description>
          <WbErrorDescription
            :headline="loadError.message"
            :diagnostics="loadError.diagnostics"
            :status-code="loadError.statusCode"
          />
        </template>
      </UAlert>

      <UAlert
        v-if="state === 'legacy'"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :title="t('access.presets.legacyTitle')"
        :description="t('access.presets.legacyDescription')"
        :ui="{ root: 'rounded-none border-b border-default' }"
        data-presets-legacy
      />

      <UAlert
        v-if="state === 'ready' && (fileState === 'missing' || fileState === 'unparsable')"
        :color="fileState === 'missing' ? 'warning' : 'error'"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="fileState === 'missing' ? t('access.presets.missingTitle') : t('access.presets.unparsableTitle')"
        :description="fileState === 'missing' ? t('access.presets.missingDescription', { file: ACCESS_PRESETS_FILENAME }) : t('access.presets.unparsableDescription')"
        :actions="canEdit ? [{ label: t('access.presets.useBuiltIns'), color: 'neutral', variant: 'outline', icon: 'i-lucide-list-restart', disabled: writing, onClick: () => { void useBuiltIns() } }] : undefined"
        :ui="{ root: 'rounded-none border-b border-default' }"
        data-presets-file-problem
      />

      <UAlert
        v-if="state === 'ready' && fileState === 'issues'"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('access.presets.issuesTitle')"
        :ui="{ root: 'rounded-none border-b border-default' }"
        data-presets-file-problem
      >
        <template #description>
          <WbErrorDescription
            :headline="t('access.presets.issuesTitle')"
            :diagnostics="fileIssues"
            :lead="canEdit ? t('access.presets.issuesHelp') : undefined"
          />
        </template>
      </UAlert>

      <UAlert
        v-if="followUp"
        color="info"
        variant="subtle"
        icon="i-lucide-users"
        :title="followUp.holders ? t('access.presets.followUp.held', { n: followUp.holders.length, name: followUp.name }, followUp.holders.length) : t('access.presets.followUp.uncounted', { name: followUp.name })"
        :description="followUp.holders && followUp.holders.length > 0 ? t('access.presets.followUp.kept') : undefined"
        close
        :actions="followUp.holders && followUp.holders.length > 0 ? [{ label: t('access.presets.followUp.update'), color: 'neutral', variant: 'outline', icon: 'i-lucide-user-cog', disabled: !access.can('members.manage'), onClick: openUpdate }] : undefined"
        :ui="{ root: 'rounded-none border-b border-default' }"
        role="status"
        data-preset-follow-up
        :data-holders="followUp.holders?.length"
        @update:open="(open: boolean) => { if (!open) followUp = undefined }"
      />

      <section
        class="border-b border-default px-4 py-3"
        data-presets-table
      >
        <UTable
          :data="rows"
          :columns="columns"
          :loading="loading"
          :empty="state === 'ready' ? t('access.presets.empty') : ''"
          :ui="tableUi"
        >
          <template #name-cell="{ row }">
            <div
              class="flex flex-wrap items-center gap-1.5"
              :data-preset-row="row.original.preset.id"
            >
              <span
                class="font-medium text-highlighted"
                data-preset-name
              >{{ row.original.preset.name }}</span>
              <UTooltip
                v-if="unknownPresetKeys(row.original.preset).length > 0"
                :text="unknownHelp(row.original.preset)"
              >
                <UBadge
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  data-preset-unknown-keys
                  :aria-description="unknownHelp(row.original.preset)"
                >
                  {{ t('access.presets.unknownKeys') }}
                </UBadge>
              </UTooltip>
            </div>
          </template>
          <template #keys-cell="{ row }">
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              data-preset-key-count
              :aria-label="canEdit ? t('access.presets.editTitle', { name: row.original.preset.name }) : t('access.presets.viewTitle', { name: row.original.preset.name })"
              @click="openPreset(row.original.index)"
            >
              {{ t('access.keys.count', { n: row.original.preset.keys.length }, row.original.preset.keys.length) }}
            </UButton>
          </template>
          <template #members-cell="{ row }">
            <span
              v-if="labeledCount(row.original.preset) !== undefined"
              class="text-muted"
              data-preset-member-count
            >{{ t('access.presets.memberCount', { n: labeledCount(row.original.preset) }, labeledCount(row.original.preset)!) }}</span>
            <UTooltip
              v-else-if="countsUnavailable"
              :text="countHelp"
            >
              <span
                class="text-dimmed"
                tabindex="0"
                data-preset-member-count="unavailable"
                :aria-label="countHelp"
              >—</span>
            </UTooltip>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end">
              <UDropdownMenu
                :items="presetActions(row.original.index)"
                :content="{ align: 'end' }"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-ellipsis"
                  size="sm"
                  :disabled="writing"
                  :aria-label="t('access.presets.actionsLabel', { name: row.original.preset.name })"
                  data-preset-actions
                />
              </UDropdownMenu>
            </div>
          </template>
        </UTable>
      </section>
    </div>

    <USlideover
      v-model:open="editorOpen"
      side="right"
      :title="editor.readonly ? t('access.presets.viewTitle', { name: editing?.name ?? editor.openedName }) : editor.id !== undefined ? t('access.presets.editTitle', { name: editing?.name ?? editor.openedName }) : t('access.presets.addTitle')"
      :description="editor.readonly ? t('access.presets.viewDescription') : editor.id !== undefined ? t('access.presets.editDescription') : t('access.presets.addDescription')"
      :dismissible="!writing"
      :ui="{ content: 'max-w-xl', body: 'flex min-h-0 flex-col gap-4 p-4 sm:p-4' }"
    >
      <template #body>
        <UForm
          :state="editor"
          class="space-y-4"
          data-preset-editor
          @submit="saveEditor"
        >
          <UFormField
            v-if="!editor.readonly"
            :label="t('access.presets.nameLabel')"
            :help="nameError ? undefined : t('access.presets.nameHelp')"
            :error="nameError && editor.name.length > 0 ? nameError : undefined"
            name="name"
            required
          >
            <UInput
              v-model="editor.name"
              autocomplete="off"
              class="w-full"
              data-preset-editor-name
            />
          </UFormField>
          <MemberKeyEditor
            v-model:keys="editor.keys"
            kind="human"
            subject="preset"
            :readonly="editor.readonly"
            :presets="otherPresets"
          />
          <UAlert
            v-if="duplicate"
            color="error"
            variant="subtle"
            icon="i-lucide-copy-x"
            :title="t('access.presets.duplicate', { name: duplicate.name })"
            role="alert"
            data-preset-editor-duplicate
          />
          <UAlert
            v-if="editorRemoved && !editor.readonly"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('access.presets.removedWhileEditing', { name: editor.openedName })"
            role="alert"
            data-preset-editor-removed
          />
          <UAlert
            v-else-if="editorError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="editorError.message"
            role="alert"
            data-preset-editor-error
            :data-code="editorError.code"
          >
            <template #description>
              <WbErrorDescription
                :headline="editorError.message"
                :diagnostics="editorError.diagnostics"
                :status-code="editorError.statusCode"
              />
            </template>
          </UAlert>
          <div
            v-if="!editor.readonly"
            class="flex justify-end gap-2"
          >
            <UButton
              color="neutral"
              variant="outline"
              :disabled="writing"
              @click="editorOpen = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              :loading="writing"
              :disabled="!canSave"
              data-preset-editor-save
            >
              {{ editor.id !== undefined ? t('access.presets.save') : t('access.presets.add') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </USlideover>

    <UModal
      :open="deletingPreset !== undefined"
      :title="deletingPreset ? t('access.presets.deleteTitle', { name: deletingPreset.name }) : ''"
      :description="t('access.presets.deleteDescription')"
      @update:open="(open: boolean) => { if (!open) deleting = undefined }"
    >
      <template #body>
        <div
          class="space-y-4"
          data-preset-delete
        >
          <p
            v-if="deletingPreset && labeledCount(deletingPreset) !== undefined"
            class="text-sm text-default"
            data-preset-delete-count
          >
            {{ t('access.presets.deleteCount', { n: labeledCount(deletingPreset) }, labeledCount(deletingPreset)!) }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="writing"
              @click="deleting = undefined"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="error"
              variant="soft"
              icon="i-lucide-trash-2"
              :loading="writing"
              data-preset-delete-confirm
              @click="deletePreset"
            >
              {{ t('access.presets.deleteConfirm') }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="updateOpen"
      :title="t('access.presets.update.title')"
      :description="t('access.presets.update.description', { name: followUp?.name ?? '' })"
      :dismissible="!updating"
    >
      <template #body>
        <div
          class="space-y-4"
          data-preset-update
        >
          <ul
            v-if="updates.length > 0"
            class="divide-y divide-(--ui-border) rounded-md border border-default"
          >
            <li
              v-for="update in updates"
              :key="update.member.id"
              class="space-y-0.5 px-3 py-2"
              :data-preset-update-member="update.member.nickname"
            >
              <p class="flex items-center gap-1.5 text-sm">
                <UIcon
                  v-if="update.member.kind === 'agent'"
                  name="i-lucide-bot"
                  class="size-4 text-muted"
                />
                <span class="font-medium text-highlighted">{{ update.member.nickname }}</span>
              </p>
              <i18n-t
                v-if="update.grant.length > 0"
                keypath="access.presets.update.grant"
                tag="p"
                scope="global"
                class="text-xs text-muted"
              >
                <template #keys>
                  <code
                    class="font-mono"
                    translate="no"
                  >{{ update.grant.join(', ') }}</code>
                </template>
              </i18n-t>
              <i18n-t
                v-if="update.revoke.length > 0"
                keypath="access.presets.update.revoke"
                tag="p"
                scope="global"
                class="text-xs text-muted"
              >
                <template #keys>
                  <code
                    class="font-mono"
                    translate="no"
                  >{{ update.revoke.join(', ') }}</code>
                </template>
              </i18n-t>
            </li>
          </ul>
          <p
            v-else
            class="text-sm text-muted"
          >
            {{ t('access.presets.update.nothing') }}
          </p>
          <p
            v-if="dropsHumanOnly"
            class="text-xs text-muted"
          >
            {{ t('access.presets.update.agentNote') }}
          </p>
          <UAlert
            v-if="updateFailures.length > 0"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('access.presets.update.errorTitle')"
            role="alert"
            data-preset-update-error
          >
            <template #description>
              <ul class="space-y-1">
                <li
                  v-for="failure in updateFailures"
                  :key="failure.nickname"
                >
                  <span class="font-medium">{{ failure.nickname }}</span> · {{ failure.error.message }}
                </li>
              </ul>
            </template>
          </UAlert>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="updating"
              @click="updateOpen = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="primary"
              variant="solid"
              :loading="updating"
              :disabled="updates.length === 0 || !access.can('members.manage')"
              data-preset-update-confirm
              @click="updateMembers"
            >
              {{ t('access.presets.update.confirm') }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </WorkbenchPage>
</template>
