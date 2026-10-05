<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'

const { t } = useI18n()
const { preview } = useWorkbench()

const status = computed(() => {
	switch (preview.sessionPhase.value) {
		case 'open':
			return { color: 'success' as const, icon: 'i-lucide-plug-zap', label: t('workbench.session.open'), hint: t('workbench.session.openHint') }
		case 'initiating':
			return { color: 'warning' as const, icon: 'i-lucide-loader-circle', label: t('workbench.session.initiating'), hint: t('workbench.session.initiatingHint') }
		case 'failed':
			return { color: 'error' as const, icon: 'i-lucide-unplug', label: t('workbench.session.failed'), hint: t('workbench.session.failedHint') }
		default:
			return { color: 'neutral' as const, icon: 'i-lucide-circle-dashed', label: t('workbench.session.idle'), hint: t('workbench.session.idleHint') }
	}
})
</script>

<template>
  <UTooltip :text="status.hint">
    <UBadge
      :color="status.color"
      variant="subtle"
      size="sm"
      :icon="status.icon"
      :ui="{ leadingIcon: preview.sessionPhase.value === 'initiating' ? 'animate-spin motion-reduce:animate-none' : '' }"
      role="status"
      tabindex="0"
    >
      {{ t('workbench.session.label', { phase: status.label }) }}
    </UBadge>
  </UTooltip>
</template>
