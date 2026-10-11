<script setup lang="ts">
import { computed } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useAccess } from '../../composables/useAccess'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { memberInitials } from '../../utils/member-initials'
import { memberLabelText } from '../../utils/member-label'

/**
 * The signed-in member: nickname, kind and label with Sign out (Rule
 * 01a11485-ed98-7754-a733-343921659920), and the Members entry for holders of `members.manage`
 * (Rule 01a116f0-8caf-7e03-ba40-ef17e116aa22). It replaces the free-text reviewer name; actors
 * are stamped by the server.
 */
const { t } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const member = access.member

const labelText = computed(() => memberLabelText(member.value?.label, t('access.label.custom')))

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
		description: `${labelText.value} · ${t(`access.kind.${member.value.kind}`)}`,
		icon: member.value.kind === 'agent' ? 'i-lucide-bot' : 'i-lucide-user-round',
	}]]
	if (access.can('members.manage')) groups.push([{ label: t('access.chip.members'), icon: 'i-lucide-users', to: '/members' }])
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
      :aria-label="t('access.chip.label', { nickname: member.nickname, kind: t(`access.kind.${member.kind}`), label: labelText })"
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
        data-member-label
      >
        {{ labelText }}
      </UBadge>
    </UButton>
  </UDropdownMenu>
</template>
