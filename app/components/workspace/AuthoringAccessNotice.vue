<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import KitIcon from '~/components/kit/ui/Icon.vue'
import type { AuthoringAccess } from '../../composables/useAuthoringAccess'

/**
 * Why a Workspace authoring page is read-only. Tablet and mobile get "Edit on desktop";
 * a Workspace this UIUX cannot write names the reason, and a member without the page's write key
 * names that key (Discussion #140, decision 12). A held edit lock already has its Lock badge, so
 * it shows nothing here.
 */
const props = defineProps<{ access: AuthoringAccess; writeKey: string }>()
const { t } = useI18n()

const notice = computed(() => {
	if (props.access === 'tablet' || props.access === 'mobile')
		return { icon: 'monitor', title: t('common.editOnDesktop'), description: t('authoring.access.device') }
	if (props.access === 'unsupported')
		return { icon: 'lock', title: t('common.readOnly'), description: t('authoring.access.unsupported') }
	if (props.access === 'key')
		return { icon: 'user-lock', title: t('common.readOnly'), description: t('access.requiresKey', { key: props.writeKey }) }
	return undefined
})
</script>

<template>
  <p
    v-if="notice"
    class="flex items-start gap-2 text-sm text-muted"
    data-access-notice
    :data-missing-key="access === 'key' ? writeKey : undefined"
  >
    <KitIcon
      :name="notice.icon"
      class="mt-0.5 shrink-0"
    />
    <span><span class="font-medium text-default">{{ notice.title }}</span> · {{ notice.description }}</span>
  </p>
</template>
