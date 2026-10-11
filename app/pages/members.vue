<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, shallowRef } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { keysOfPreset, missingRequirements } from '../../src/application/access/keys'
import type { LabelPreset, MemberLabel } from '../../src/application/access/labels'
import type { MemberKind } from '../../src/application/access/principal'
import { useAccess } from '../composables/useAccess'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { copyText } from '../utils/copy-text'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { memberInitials } from '../utils/member-initials'
import { keysNoHumanHolds, orderedKeys } from '../utils/member-keys'
import { memberLabelText } from '../utils/member-label'
import MemberKeyEditor from '../components/access/MemberKeyEditor.vue'
import WbErrorDescription from '../components/workbench/WbErrorDescription.vue'
import WorkbenchPage from '../components/workbench/WorkbenchPage.vue'

/**
 * Members (accepted identity decision 12): the served Workspace's roster, for a holder of `members.manage` on a
 * loopback origin or an `https` configured origin (Rule 01a11485-eb86-7a69-bf1b-70d492ee3be4).
 * Each member is listed with its kind, label, key count, Tokens and sessions (Rule
 * 01a11c09-ba13-71f1-8194-898b221f6c8a), and its keys are edited in the key checklist (Rule
 * 01a11c09-ba80-7bef-96fe-4a4bae3ab528). Tokens are revealed once at creation; invites are single-use links.
 */
type MemberRow = Readonly<{ id: string; nickname: string; kind: MemberKind; createdAt: string; activeTokens: number; activeSessions: number; keys: readonly string[]; label: MemberLabel }>
type Roster = Readonly<{ workspaceRoot: string; hint: string; members: MemberRow[]; presets: LabelPreset[] }>
type TokenRow = Readonly<{ id: string; member: string; memberId: string; label: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; active: boolean }>
type SessionRow = Readonly<{ id: string; member: string; userAgent: string; lastSeenAt: string; expiresAt: string; current: boolean }>
type Attempts = Readonly<{ total: number; recent: readonly Readonly<{ at: string; userAgent: string }>[] }>

// Untyped request helper: Nitro's typed-route inference overflows on this many access routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const { t } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const roster = ref<Roster>()
const tokens = ref<TokenRow[]>([])
const sessions = ref<SessionRow[]>([])
const attempts = ref<Attempts>({ total: 0, recent: [] })
const loading = ref(true)
const loadError = ref('')
/** This origin does not serve roster administration (an `http` network origin, Rule 01a12500-b105-7773-822f-359d4dcbd1da). */
const adminOriginRefused = ref(false)

const kindItems = computed(() => (['human', 'agent'] as const).map(kind => ({ label: t(`access.kind.${kind}`), value: kind })))
const labelText = (label: MemberLabel) => memberLabelText(label, t('access.label.custom'))

async function load(): Promise<void> {
	loadError.value = ''
	adminOriginRefused.value = false
	try {
		const [members, tokenList, sessionList, attemptList] = await Promise.all([
			api<Roster>('/api/access/members'),
			api<{ tokens: TokenRow[] }>('/api/access/tokens'),
			api<{ sessions: SessionRow[] }>('/api/access/sessions'),
			api<Attempts>('/api/access/mcp-attempts'),
		])
		roster.value = members
		tokens.value = tokenList.tokens.filter(token => token.active)
		sessions.value = sessionList.sessions
		attempts.value = attemptList
	}
	catch (cause) {
		const details = describeFetchError(cause, t('access.members.errorTitle'))
		loadError.value = details.message
		adminOriginRefused.value = details.code === 'access.admin_origin_rejected'
	}
	finally {
		loading.value = false
	}
}

onMounted(load)

async function mutate(run: () => Promise<unknown>, success?: string): Promise<boolean> {
	try {
		await run()
		if (success) feedback.success(success)
		await load()
		return true
	}
	catch (cause) {
		feedback.error(cause, t('access.members.errorTitle'))
		return false
	}
}

const isSelf = (row: MemberRow) => row.id === access.member.value?.id

// ---- Add a member, or edit one's nickname and keys ("Edit access") ----
type Editor = { member?: MemberRow; nickname: string; kind: MemberKind; keys: string[] }
const editorOpen = ref(false)
const editor = reactive<Editor>({ nickname: '', kind: 'human', keys: [] })
const saving = ref(false)
const editorError = shallowRef<FetchErrorDetails>()
const presets = computed(() => roster.value?.presets ?? [])

/** The keys of the preset with this `id` for a member of this kind, when the Workspace has it. */
function presetKeys(id: string, kind: MemberKind): string[] {
	const preset = presets.value.find(item => item.id === id)
	return preset ? keysOfPreset(kind, preset.keys) : []
}

function openAdd(kind: MemberKind = 'human'): void {
	Object.assign(editor, { member: undefined, nickname: '', kind, keys: presetKeys(kind === 'agent' ? 'editor' : 'reviewer', kind) })
	editorError.value = undefined
	editorOpen.value = true
}

function openEdit(row: MemberRow): void {
	Object.assign(editor, { member: row, nickname: row.nickname, kind: row.kind, keys: [...row.keys] })
	editorError.value = undefined
	editorOpen.value = true
}

/** A new member's kind decides its keys: an Agent never gets a `humanOnly` key (Rule 01a11485-eac6-730b-b66b-309cc9efb169). */
function setNewKind(kind: MemberKind): void {
	editor.kind = kind
	editor.keys = keysOfPreset(kind, editor.keys)
}

const sameKeys = (left: readonly string[], right: readonly string[]) => orderedKeys(left).join() === orderedKeys(right).join()

async function saveEditor(): Promise<void> {
	if (saving.value) return
	const nickname = editor.nickname.trim()
	const member = editor.member
	saving.value = true
	editorError.value = undefined
	try {
		if (!member) {
			await api('/api/access/members', { method: 'POST', body: { nickname, kind: editor.kind, keys: editor.keys } })
			feedback.success(t('access.members.added', { nickname }))
		}
		else {
			// Unchanged keys are not sent, so a rename alone leaves a key set written by hand as it is
			// (Rules 01a11c09-b779-7f5f-ba47-170a584a09ce and 01a11c33-24ab-76c8-8811-13d938153cad).
			const body = {
				...(sameKeys(editor.keys, member.keys) ? {} : { keys: editor.keys }),
				...(nickname !== member.nickname ? { nickname } : {}),
			}
			if (Object.keys(body).length > 0) {
				await api(`/api/access/members/${member.id}`, { method: 'PATCH', body })
				feedback.success(t('access.members.updated', { nickname }))
			}
		}
		editorOpen.value = false
		if (member && isSelf(member)) {
			// The signed-in member's own keys changed: what the Workbench offers follows them.
			await access.reload()
			if (!access.can('members.manage')) {
				await navigateTo('/')
				return
			}
		}
		await load()
	}
	catch (cause) {
		editorError.value = describeFetchError(cause, t('access.members.errorTitle'))
	}
	finally {
		saving.value = false
	}
}

/** Rule 01a11c33-24ab-76c8-8811-13d938153cad: a stored key set that lacks a requirement, flagged until it is next written. */
const gapsOf = (row: MemberRow) => missingRequirements(row.keys)
const gapText = (row: MemberRow) => gapsOf(row).map(gap => t('access.keys.gap', { key: gap.key, keys: gap.missing.join(', ') })).join(' ')

/** Rule 01a11c09-bbc9-721f-903c-27c615692624: the catalog keys no human member holds. */
const unheldKeys = computed(() => roster.value ? keysNoHumanHolds(roster.value.members) : [])
function openOwnChecklist(): void {
	const self = roster.value?.members.find(isSelf)
	if (self) openEdit(self)
}

const removing = ref<MemberRow>()
async function removeMember(): Promise<void> {
	const row = removing.value
	if (!row) return
	if (await mutate(() => api(`/api/access/members/${row.id}`, { method: 'DELETE' }), t('access.members.removed', { nickname: row.nickname })))
		removing.value = undefined
}

// ---- Tokens (create once, reveal once) ----
const tokenFor = ref<MemberRow>()
const tokenForm = reactive<{ label: string; expires: '90' | '30' | 'never' }>({ label: '', expires: '90' })
const revealed = ref('')
const expiryItems = computed(() => [
	{ label: t('access.tokens.expires90'), value: '90' },
	{ label: t('access.tokens.expires30'), value: '30' },
	{ label: t('access.tokens.expiresNever'), value: 'never' },
])
function openToken(row: MemberRow): void {
	tokenFor.value = row
	tokenForm.label = ''
	tokenForm.expires = '90'
	revealed.value = ''
}
async function createToken(): Promise<void> {
	const row = tokenFor.value
	if (!row) return
	try {
		const result = await api<{ credential: string }>('/api/access/tokens', {
			method: 'POST',
			body: { memberId: row.id, ...(tokenForm.label.trim() ? { label: tokenForm.label.trim() } : {}), expiresInDays: tokenForm.expires === 'never' ? null : Number(tokenForm.expires) },
		})
		revealed.value = result.credential
		await load()
	}
	catch (cause) {
		feedback.error(cause, t('access.members.errorTitle'))
	}
}
function closeToken(): void {
	tokenFor.value = undefined
	revealed.value = ''
}
async function revokeToken(row: TokenRow): Promise<void> {
	await mutate(() => api(`/api/access/tokens/${row.id}`, { method: 'DELETE' }), t('access.tokens.revoked', { id: row.id }))
}

// ---- Invites ----
const invite = ref<Readonly<{ nickname: string; url: string; expiresAt: string }>>()
async function createInvite(row: MemberRow): Promise<void> {
	try {
		// The link names the origin this page was loaded from: the one the request's Host matched.
		const result = await api<{ url: string; expiresAt: string }>('/api/access/invites', { method: 'POST', body: { memberId: row.id } })
		invite.value = { nickname: row.nickname, ...result }
	}
	catch (cause) {
		feedback.error(cause, t('access.members.errorTitle'))
	}
}

async function copy(value: string): Promise<void> {
	if (await copyText(value)) feedback.success(t('access.tokens.copied'))
	else feedback.error(undefined, t('access.tokens.copyFailed'))
}

// ---- Sessions ----
async function endSession(row: SessionRow): Promise<void> {
	await mutate(() => api(`/api/access/sessions/${row.id}`, { method: 'DELETE' }), t('access.sessions.revoked'))
}

// ---- MCP clients without a token ----
const latestAttempt = computed(() => attempts.value.recent[0])
function createAgentToken(): void {
	const agent = roster.value?.members.find(member => member.kind === 'agent')
	if (agent) openToken(agent)
	else openAdd('agent')
}

function memberActions(row: MemberRow): DropdownMenuItem[][] {
	const first: DropdownMenuItem[] = [
		{ label: t('access.members.editAccess'), icon: 'i-lucide-shield-check', onSelect: () => openEdit(row) },
		{ label: t('access.members.createToken'), icon: 'i-lucide-key-round', onSelect: () => openToken(row) },
	]
	if (row.kind === 'human') first.push({ label: t('access.members.invite'), icon: 'i-lucide-link', onSelect: () => { void createInvite(row) } })
	return [first, [{ label: t('access.members.remove'), icon: 'i-lucide-user-minus', color: 'error', disabled: isSelf(row), onSelect: () => { removing.value = row } }]]
}

const memberColumns = computed<TableColumn<MemberRow>[]>(() => [
	{ accessorKey: 'nickname', header: t('access.members.columns.member') },
	{ accessorKey: 'kind', header: t('access.members.columns.kind') },
	{ id: 'label', header: t('access.members.columns.label') },
	{ id: 'keys', header: t('access.members.columns.keys') },
	{ accessorKey: 'activeTokens', header: t('access.members.columns.tokens') },
	{ accessorKey: 'activeSessions', header: t('access.members.columns.sessions') },
	{ id: 'actions', header: () => h('span', { class: 'sr-only' }, t('access.members.actionsColumn')) },
])
const tokenColumns = computed<TableColumn<TokenRow>[]>(() => [
	{ accessorKey: 'id', header: t('access.tokens.columns.token') },
	{ accessorKey: 'member', header: t('access.tokens.columns.member') },
	{ accessorKey: 'label', header: t('access.tokens.columns.label') },
	{ accessorKey: 'expiresAt', header: t('access.tokens.columns.expires') },
	{ accessorKey: 'lastUsedAt', header: t('access.tokens.columns.lastUsed') },
	{ id: 'actions', header: () => h('span', { class: 'sr-only' }, t('access.members.actionsColumn')) },
])
const sessionColumns = computed<TableColumn<SessionRow>[]>(() => [
	{ accessorKey: 'member', header: t('access.sessions.columns.member') },
	{ accessorKey: 'userAgent', header: t('access.sessions.columns.device') },
	{ accessorKey: 'lastSeenAt', header: t('access.sessions.columns.lastSeen') },
	{ accessorKey: 'expiresAt', header: t('access.sessions.columns.expires') },
	{ id: 'actions', header: () => h('span', { class: 'sr-only' }, t('access.members.actionsColumn')) },
])
const tableUi = { th: 'text-xs font-medium text-muted whitespace-nowrap', td: 'text-sm' }
</script>

<template>
  <WorkbenchPage
    id="members"
    :title="t('access.members.title')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-y-auto">
      <header class="flex flex-wrap items-start justify-between gap-3 border-b border-default px-4 py-4">
        <div class="min-w-0 space-y-1">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('access.members.title') }}
          </h1>
          <p class="text-sm text-muted">
            {{ t('access.members.subtitle') }}
          </p>
          <p
            v-if="roster"
            class="flex flex-wrap items-center gap-1.5 text-xs text-muted"
          >
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
              class="font-mono"
            >
              {{ t('access.members.rosterLabel', { hint: roster.hint }) }}
            </UBadge>
            <span
              class="min-w-0 truncate font-mono"
              translate="no"
            >{{ roster.workspaceRoot }}</span>
          </p>
          <p
            v-if="roster"
            class="text-xs text-dimmed"
          >
            {{ t('access.members.rosterHelp') }}
          </p>
        </div>
        <UButton
          v-if="!adminOriginRefused"
          color="primary"
          variant="solid"
          icon="i-lucide-user-plus"
          @click="openAdd()"
        >
          {{ t('access.members.add') }}
        </UButton>
      </header>

      <UAlert
        v-if="adminOriginRefused"
        data-testid="admin-origin-refused"
        color="warning"
        variant="subtle"
        icon="i-lucide-shield-alert"
        :title="t('access.members.adminOriginTitle')"
        :description="loadError"
        :ui="{ root: 'rounded-none border-b border-default' }"
      />

      <UAlert
        v-else-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('access.members.errorTitle')"
        :description="loadError"
        :ui="{ root: 'rounded-none border-b border-default' }"
      />

      <UAlert
        v-if="attempts.total > 0"
        data-testid="mcp-attempts"
        color="warning"
        variant="subtle"
        icon="i-lucide-plug-zap"
        :title="t('access.mcpAttempts.title')"
        :description="t('access.mcpAttempts.description', { n: attempts.total, time: fmt.dateTime(latestAttempt?.at), agent: latestAttempt?.userAgent || t('access.mcpAttempts.unknownAgent') }, attempts.total)"
        :actions="[{ label: t('access.mcpAttempts.action'), color: 'neutral', variant: 'outline', icon: 'i-lucide-key-round', onClick: createAgentToken }]"
        :ui="{ root: 'rounded-none border-b border-default' }"
      />

      <UAlert
        v-if="unheldKeys.length > 0 && access.can('members.manage')"
        data-testid="unheld-keys"
        color="info"
        variant="subtle"
        icon="i-lucide-key-square"
        :title="t('access.members.unheldTitle', { n: unheldKeys.length }, unheldKeys.length)"
        :ui="{ root: 'rounded-none border-b border-default' }"
      >
        <template #description>
          <p class="space-y-1">
            <span class="block">{{ t('access.members.unheldDescription') }}</span>
            <code
              class="block font-mono text-xs"
              translate="no"
              data-unheld-keys
            >{{ unheldKeys.join(', ') }}</code>
          </p>
        </template>
        <template #actions>
          <UButton
            v-if="roster?.members.some(isSelf)"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-list-checks"
            data-unheld-open-checklist
            @click="openOwnChecklist"
          >
            {{ t('access.members.unheldAction') }}
          </UButton>
        </template>
      </UAlert>

      <section
        class="border-b border-default px-4 py-3"
        data-members-table
      >
        <UTable
          :data="roster?.members ?? []"
          :columns="memberColumns"
          :loading="loading"
          :ui="tableUi"
        >
          <template #nickname-cell="{ row }">
            <div class="flex items-center gap-2">
              <UAvatar
                :text="memberInitials(row.original.nickname)"
                :icon="row.original.kind === 'agent' ? 'i-lucide-bot' : undefined"
                size="2xs"
              />
              <span class="font-medium text-highlighted">{{ row.original.nickname }}</span>
              <UBadge
                v-if="isSelf(row.original)"
                color="neutral"
                variant="soft"
                size="sm"
              >
                {{ t('access.members.you') }}
              </UBadge>
            </div>
          </template>
          <template #kind-cell="{ row }">
            <span class="text-muted">{{ t(`access.kind.${row.original.kind}`) }}</span>
          </template>
          <template #label-cell="{ row }">
            <div class="flex flex-wrap items-center gap-1.5">
              <UBadge
                color="neutral"
                variant="soft"
                data-member-label
              >
                {{ labelText(row.original.label) }}
              </UBadge>
              <UTooltip
                v-if="gapsOf(row.original).length > 0"
                :text="gapText(row.original)"
              >
                <UBadge
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  data-member-key-gap
                  :aria-description="gapText(row.original)"
                >
                  {{ t('access.keys.gapBadge') }}
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
              data-member-key-count
              :aria-label="t('access.members.editAccessFor', { nickname: row.original.nickname })"
              @click="openEdit(row.original)"
            >
              {{ t('access.keys.count', { n: row.original.keys.length }, row.original.keys.length) }}
            </UButton>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end">
              <UDropdownMenu
                :items="memberActions(row.original)"
                :content="{ align: 'end' }"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-ellipsis"
                  size="sm"
                  :aria-label="t('access.members.actionsLabel', { nickname: row.original.nickname })"
                />
              </UDropdownMenu>
            </div>
          </template>
        </UTable>
      </section>

      <section class="space-y-2 border-b border-default px-4 py-3">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('access.tokens.title') }}
        </h2>
        <UTable
          :data="tokens"
          :columns="tokenColumns"
          :loading="loading"
          :empty="t('access.tokens.empty')"
          :ui="tableUi"
        >
          <template #id-cell="{ row }">
            <span
              class="font-mono text-xs"
              translate="no"
            >{{ row.original.id }}</span>
          </template>
          <template #label-cell="{ row }">
            <span class="text-muted">{{ row.original.label || '—' }}</span>
          </template>
          <template #expiresAt-cell="{ row }">
            {{ row.original.expiresAt ? fmt.date(row.original.expiresAt) : t('access.tokens.never') }}
          </template>
          <template #lastUsedAt-cell="{ row }">
            <span class="text-muted">{{ row.original.lastUsedAt ? fmt.dateTime(row.original.lastUsedAt) : t('access.tokens.unused') }}</span>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end">
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                :aria-label="t('access.tokens.revokeLabel', { id: row.original.id })"
                @click="revokeToken(row.original)"
              >
                {{ t('access.tokens.revoke') }}
              </UButton>
            </div>
          </template>
        </UTable>
      </section>

      <section class="space-y-2 px-4 py-3">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('access.sessions.title') }}
        </h2>
        <UTable
          :data="sessions"
          :columns="sessionColumns"
          :loading="loading"
          :empty="t('access.sessions.empty')"
          :ui="tableUi"
        >
          <template #member-cell="{ row }">
            <span class="font-medium text-highlighted">{{ row.original.member }}</span>
            <UBadge
              v-if="row.original.current"
              color="neutral"
              variant="soft"
              size="sm"
              class="ms-1.5"
            >
              {{ t('access.sessions.current') }}
            </UBadge>
          </template>
          <template #userAgent-cell="{ row }">
            <span
              class="block max-w-56 truncate text-muted"
              translate="no"
            >{{ row.original.userAgent || '—' }}</span>
          </template>
          <template #lastSeenAt-cell="{ row }">
            {{ fmt.dateTime(row.original.lastSeenAt) }}
          </template>
          <template #expiresAt-cell="{ row }">
            {{ fmt.date(row.original.expiresAt) }}
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end">
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                :aria-label="t('access.sessions.revokeLabel', { member: row.original.member, device: row.original.userAgent || '—' })"
                @click="endSession(row.original)"
              >
                {{ t('access.sessions.revoke') }}
              </UButton>
            </div>
          </template>
        </UTable>
      </section>
    </div>

    <USlideover
      v-model:open="editorOpen"
      side="right"
      :title="editor.member ? t('access.members.editTitle', { nickname: editor.member.nickname }) : t('access.members.addTitle')"
      :description="editor.member ? t('access.members.editDescription') : t('access.members.addDescription')"
      :dismissible="!saving"
      :ui="{ content: 'max-w-xl', body: 'flex min-h-0 flex-col gap-4 p-4 sm:p-4' }"
    >
      <template #body>
        <UForm
          :state="editor"
          class="space-y-4"
          data-member-editor
          @submit="saveEditor"
        >
          <UFormField
            :label="t('access.members.nicknameLabel')"
            :help="t('access.members.nicknameHelp')"
            name="nickname"
            required
          >
            <UInput
              v-model="editor.nickname"
              autocomplete="off"
              spellcheck="false"
              class="w-full font-mono"
              data-member-editor-nickname
            />
          </UFormField>
          <UFormField
            :label="t('access.members.kindLabel')"
            :help="t('access.members.kindHelp')"
            name="kind"
          >
            <USelect
              v-if="!editor.member"
              :model-value="editor.kind"
              :items="kindItems"
              class="w-full"
              data-member-editor-kind
              @update:model-value="(value: MemberKind) => setNewKind(value)"
            />
            <p
              v-else
              class="text-sm text-default"
              data-member-editor-kind
            >
              {{ t(`access.kind.${editor.kind}`) }}
            </p>
          </UFormField>
          <MemberKeyEditor
            v-model:keys="editor.keys"
            :kind="editor.kind"
            :presets="presets"
          />
          <UAlert
            v-if="editorError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="editorError.message"
            role="alert"
            data-member-editor-error
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
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="editorOpen = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              :loading="saving"
              :disabled="!editor.nickname.trim()"
              data-member-editor-save
            >
              {{ editor.member ? t('access.members.save') : t('access.members.add') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </USlideover>

    <UModal
      :open="Boolean(tokenFor)"
      :title="tokenFor ? (revealed ? t('access.tokens.revealTitle') : t('access.tokens.createTitle', { nickname: tokenFor.nickname })) : ''"
      :description="revealed ? t('access.tokens.revealDescription') : t('access.tokens.createDescription')"
      @update:open="(open: boolean) => { if (!open) closeToken() }"
    >
      <template #body>
        <div
          v-if="revealed"
          class="space-y-3"
        >
          <div class="flex items-center gap-2">
            <UInput
              :model-value="revealed"
              readonly
              class="w-full font-mono"
              data-testid="revealed-token"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-copy"
              @click="copy(revealed)"
            >
              {{ t('access.tokens.copy') }}
            </UButton>
          </div>
          <p class="text-xs text-muted">
            {{ t('access.tokens.mcpHint') }}
          </p>
          <div class="flex justify-end">
            <UButton
              color="neutral"
              variant="outline"
              @click="closeToken"
            >
              {{ t('common.close') }}
            </UButton>
          </div>
        </div>
        <UForm
          v-else
          :state="tokenForm"
          class="space-y-4"
          @submit="createToken"
        >
          <UFormField
            :label="t('access.tokens.labelLabel')"
            name="label"
          >
            <UInput
              v-model="tokenForm.label"
              :placeholder="t('access.tokens.labelPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('access.tokens.expiresLabel')"
            name="expires"
          >
            <USelect
              v-model="tokenForm.expires"
              :items="expiryItems"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="closeToken"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
            >
              {{ t('access.members.createToken') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <UModal
      :open="Boolean(invite)"
      :title="invite ? t('access.invites.title', { nickname: invite.nickname }) : ''"
      :description="invite ? t('access.invites.description', { nickname: invite.nickname, time: fmt.dateTime(invite.expiresAt) }) : ''"
      @update:open="(open: boolean) => { if (!open) invite = undefined }"
    >
      <template #body>
        <div
          v-if="invite"
          class="flex items-center gap-2"
        >
          <UInput
            :model-value="invite.url"
            readonly
            class="w-full font-mono"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-copy"
            @click="copy(invite.url)"
          >
            {{ t('access.tokens.copy') }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="Boolean(removing)"
      :title="removing ? t('access.members.removeTitle', { nickname: removing.nickname }) : ''"
      :description="t('access.members.removeDescription')"
      @update:open="(open: boolean) => { if (!open) removing = undefined }"
    >
      <template #body>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="removing = undefined"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="error"
            variant="soft"
            icon="i-lucide-user-minus"
            @click="removeMember"
          >
            {{ t('access.members.remove') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </WorkbenchPage>
</template>
