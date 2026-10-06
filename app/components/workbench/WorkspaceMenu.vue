<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'

/**
 * The Workspace mark at the start of the navbar. One server serves one Workspace, so this
 * only identifies it (mode and revision, one click away) and never switches Workspaces.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const feedback = useWorkbenchFeedback()
const { isReadOnly, workspace, publicationInfo } = workbench

async function copy(value: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value)
		feedback.success(t('workspaceMenu.copied'))
	}
	catch {
		feedback.error(undefined, t('workspaceMenu.copyFailed'))
	}
}

const items = computed<DropdownMenuItem[][]>(() => {
	const details: DropdownMenuItem[] = [{
		type: 'label',
		label: isReadOnly.value ? t('workspaceMenu.published') : t('workspaceMenu.local'),
		icon: isReadOnly.value ? 'i-lucide-lock' : 'i-lucide-hard-drive',
	}]
	const revision = workspace.value?.revision
	if (revision) {
		details.push({
			label: t('workspaceMenu.copyRevision'),
			description: `${revision.slice(0, 14)}…`,
			icon: 'i-lucide-copy',
			onSelect: () => { void copy(revision) },
		})
	}
	const identity = publicationInfo.value?.publicationIdentity
	if (identity) {
		details.push({
			label: t('workspaceMenu.copyPublication'),
			description: `${identity.slice(0, 18)}…`,
			icon: 'i-lucide-copy',
			onSelect: () => { void copy(identity) },
		})
	}
	return [details]
})
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'start' }"
    :ui="{ itemDescription: 'font-mono' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      trailing-icon="i-lucide-chevron-down"
      :aria-label="t('workspaceMenu.label')"
      class="gap-2 px-1.5"
    >
      <!-- The favicon mark keeps its near-black square; the hairline keeps it visible on dark chrome. -->
      <svg
        viewBox="0 0 32 32"
        class="size-5 shrink-0 rounded-[0.275rem] ring-1 ring-(--ui-border-accented)"
        aria-hidden="true"
      >
        <rect
          width="32"
          height="32"
          rx="7"
          fill="#171717"
        />
        <path
          d="M8 10h16v4H8zm0 8h10v4H8z"
          fill="#a78bfa"
        />
      </svg>
      <span class="hidden font-semibold text-highlighted sm:inline">{{ t('nav.workspace') }}</span>
    </UButton>
  </UDropdownMenu>
</template>
