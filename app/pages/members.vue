<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { AccessRole, MemberKind } from '../../src/application/access/principal'
import { useAccess } from '../composables/useAccess'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { copyText } from '../utils/copy-text'
import { describeFetchError } from '../utils/fetch-error'
import { memberInitials } from '../utils/member-initials'
import WorkbenchPage from '../components/workbench/WorkbenchPage.vue'

/**
 * Members (accepted identity decision 12): the served Workspace's roster, for a human Owner on
 * the loopback listener. Tokens are revealed once at creation; invites are single-use links.
 */
type MemberRow = Readonly<{ id: string; nickname: string; kind: MemberKind; role: AccessRole; createdAt: string; activeTokens: number; activeSessions: number }>
type TokenRow = Readonly<{ id: string; member: string; memberId: string; label: string; lan: boolean; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; active: boolean }>
type SessionRow = Readonly<{ id: string; member: string; userAgent: string; lastSeenAt: string; expiresAt: string; current: boolean }>
type Attempts = Readonly<{ total: number; recent: readonly Readonly<{ at: string; userAgent: string }>[] }>

// Untyped request helper: Nitro's typed-route inference overflows on this many access routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const { t } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const roster = ref<{ workspaceRoot: string; hint: string; members: MemberRow[] }>()
const tokens = ref<TokenRow[]>([])
const sessions = ref<SessionRow[]>([])
const attempts = ref<Attempts>({ total: 0, recent: [] })
const loading = ref(true)
const loadError = ref('')

const ROLES: readonly AccessRole[] = ['owner', 'editor', 'reviewer', 'viewer']
const roleItems = (kind: MemberKind) => ROLES.filter(role => kind === 'human' || role !== 'owner').map(role => ({ label: t(`access.role.${role}`), value: role }))
const kindItems = computed(() => (['human', 'agent'] as const).map(kind => ({ label: t(`access.kind.${kind}`), value: kind })))

async function load(): Promise<void> {
	loadError.value = ''
	try {
		const [members, tokenList, sessionList, attemptList] = await Promise.all([
			api<{ workspaceRoot: string; hint: string; members: MemberRow[] }>('/api/access/members'),
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
		loadError.value = describeFetchError(cause, t('access.members.errorTitle')).message
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

// ---- Add member ----
const adding = ref(false)
const addForm = reactive<{ nickname: string; role: AccessRole; kind: MemberKind }>({ nickname: '', role: 'reviewer', kind: 'human' })
async function addMember(): Promise<void> {
	const nickname = addForm.nickname.trim()
	const ok = await mutate(() => api('/api/access/members', { method: 'POST', body: { nickname, role: addForm.kind === 'agent' && addForm.role === 'owner' ? 'editor' : addForm.role, kind: addForm.kind } }), t('access.members.added', { nickname }))
	if (ok) {
		adding.value = false
		addForm.nickname = ''
	}
}

async function setRole(row: MemberRow, role: AccessRole): Promise<void> {
	if (role === row.role) return
	await mutate(() => api(`/api/access/members/${row.id}`, { method: 'PATCH', body: { role } }), t('access.members.roleChanged', { nickname: row.nickname, role: t(`access.role.${role}`) }))
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
		const result = await api<{ url: string; expiresAt: string }>('/api/access/invites', { method: 'POST', body: { memberId: row.id, origin: window.location.origin } })
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
	else {
		addForm.kind = 'agent'
		addForm.role = 'editor'
		addForm.nickname = ''
		adding.value = true
	}
}

function memberActions(row: MemberRow): DropdownMenuItem[][] {
	const first: DropdownMenuItem[] = [{ label: t('access.members.createToken'), icon: 'i-lucide-key-round', onSelect: () => openToken(row) }]
	if (row.kind === 'human') first.push({ label: t('access.members.invite'), icon: 'i-lucide-link', onSelect: () => { void createInvite(row) } })
	return [first, [{ label: t('access.members.remove'), icon: 'i-lucide-user-minus', color: 'error', disabled: isSelf(row), onSelect: () => { removing.value = row } }]]
}

const memberColumns = computed<TableColumn<MemberRow>[]>(() => [
	{ accessorKey: 'nickname', header: t('access.members.columns.member') },
	{ accessorKey: 'role', header: t('access.members.columns.role') },
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
            <span class="min-w-0 truncate font-mono">{{ roster.workspaceRoot }}</span>
          </p>
          <p
            v-if="roster"
            class="text-xs text-dimmed"
          >
            {{ t('access.members.rosterHelp') }}
          </p>
        </div>
        <UButton
          color="primary"
          variant="solid"
          icon="i-lucide-user-plus"
          @click="adding = true"
        >
          {{ t('access.members.add') }}
        </UButton>
      </header>

      <UAlert
        v-if="loadError"
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

      <section class="border-b border-default px-4 py-3">
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
              <span class="text-xs text-muted">{{ t(`access.kind.${row.original.kind}`) }}</span>
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
          <template #role-cell="{ row }">
            <USelect
              :model-value="row.original.role"
              :items="roleItems(row.original.kind)"
              size="sm"
              class="w-32"
              :aria-label="t('access.members.roleLabel')"
              @update:model-value="(value: AccessRole) => setRole(row.original, value)"
            />
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
            <span class="font-mono text-xs">{{ row.original.id }}</span>
            <UBadge
              v-if="row.original.lan"
              color="neutral"
              variant="soft"
              size="sm"
              class="ms-1.5"
            >
              {{ t('access.tokens.lan') }}
            </UBadge>
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
            <span class="block max-w-56 truncate text-muted">{{ row.original.userAgent || '—' }}</span>
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

    <UModal
      v-model:open="adding"
      :title="t('access.members.addTitle')"
      :description="t('access.members.addDescription')"
    >
      <template #body>
        <UForm
          :state="addForm"
          class="space-y-4"
          @submit="addMember"
        >
          <UFormField
            :label="t('access.members.nicknameLabel')"
            :help="t('access.members.nicknameHelp')"
            name="nickname"
            required
          >
            <UInput
              v-model="addForm.nickname"
              autofocus
              autocomplete="off"
              spellcheck="false"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            :label="t('access.members.kindLabel')"
            :help="t('access.members.kindHelp')"
            name="kind"
          >
            <USelect
              v-model="addForm.kind"
              :items="kindItems"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('access.members.roleLabel')"
            name="role"
          >
            <USelect
              v-model="addForm.role"
              :items="roleItems(addForm.kind)"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="adding = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              :disabled="!addForm.nickname.trim()"
            >
              {{ t('access.members.add') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>

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
