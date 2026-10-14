<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { NavigationMenuItem } from '@nuxt/ui'
import { PRODUCT_KIT_PATH } from '../../utils/workbench-routes'

/**
 * The Workspace pages' own sub-navigation: Settings, Product Kit, Access presets, Locales and Assets
 * (Rule 01a116f0-8a01-7cd2-807d-cc26f7bf8b16). The sidebar keeps one secondary "Workspace" entry;
 * the pages behind it are reached from here. Adapters are managed in the Overview section of the
 * Product Kit page (Rule 01a116f0-8a46-76bc-a29f-affaa302c44c), not on a page of their own.
 */
const { t } = useI18n()

const items = computed<NavigationMenuItem[]>(() => [
	{ label: t('nav.settings'), icon: 'i-lucide-settings-2', to: '/workspace/settings' },
	{ label: t('nav.productKit'), icon: 'i-lucide-blocks', to: PRODUCT_KIT_PATH },
	{ label: t('nav.accessPresets'), icon: 'i-lucide-key-square', to: '/workspace/access-presets' },
	{ label: t('nav.locales'), icon: 'i-lucide-globe', to: '/workspace/locales' },
	{ label: t('nav.assets'), icon: 'i-lucide-image', to: '/workspace/assets' },
])
</script>

<template>
  <UDashboardToolbar :ui="{ root: 'min-h-0 gap-0 px-2 sm:px-4' }">
    <UNavigationMenu
      :items="items"
      :aria-label="t('nav.workspacePages')"
      orientation="horizontal"
      color="neutral"
      highlight
      highlight-color="primary"
      class="-mb-px"
      data-workspace-subnav
    />
  </UDashboardToolbar>
</template>
