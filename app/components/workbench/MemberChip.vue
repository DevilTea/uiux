<script setup lang="ts">
import { computed } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useAccess } from '../../composables/useAccess'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { memberInitials } from '../../utils/member-initials'

/**
 * The signed-in member (accepted identity decision 12): nickname, role, Members (Owner) and
 * Sign out. It replaces the free-text reviewer name; actors are stamped by the server.
 */
const { t } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const member = access.member

const roleLabel = computed(() => member.value ? t(`access.role.${member.value.role}`) : '')

async function signOut(): Promise<void> {
	await access.signOut().catch(() => undefined)
	feedback.success(t('access.chip.signedOut'))
	await navigateTo('/login')
}

const items = computed<DropdownMenuItem[][]>(() => {
	if (!member.value) return []
	const groups: DropdownMenuItem[][] = [[{
		type: 'label',
		label: member.value.nickname,
		description: `${roleLabel.value} · ${t(`access.kind.${member.value.kind}`)}`,
		icon: member.value.kind === 'agent' ? 'i-lucide-bot' : 'i-lucide-user-round',
	}]]
	if (access.isOwner.value) groups.push([{ label: t('access.chip.members'), icon: 'i-lucide-users', to: '/members' }])
	groups.push([{ label: t('access.chip.signOut'), icon: 'i-lucide-log-out', onSelect: () => { void signOut() } }])
	return groups
})
</script>

<template>
  <UDropdownMenu
    v-if="member"
    :items="items"
    :content="{ align: 'end', sideOffset: 6 }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      class="gap-2 px-1.5"
      data-testid="member-chip"
      :aria-label="t('access.chip.label', { nickname: member.nickname, role: roleLabel })"
    >
      <UAvatar
        :text="memberInitials(member.nickname)"
        :icon="member.kind === 'agent' ? 'i-lucide-bot' : undefined"
        size="2xs"
        :ui="{ fallback: 'font-semibold text-xs text-default' }"
      />
      <span class="hidden max-w-32 truncate lg:inline">{{ member.nickname }}</span>
      <UBadge
        color="neutral"
        variant="soft"
        size="sm"
        class="hidden lg:inline-flex"
      >
        {{ roleLabel }}
      </UBadge>
    </UButton>
  </UDropdownMenu>
</template>
