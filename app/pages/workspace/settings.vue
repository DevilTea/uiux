<script setup lang="ts">
import { definePageMeta, navigateTo } from '#imports'
import WorkspaceSettingsPage from '../../components/workspace/WorkspaceSettingsPage.vue'

/**
 * Workspace settings (brief g): General, Viewports and Themes. The retired Adapters section
 * address, `?section=adapters`, opens the Overview section of the Product Kit page (Clause
 * 01a116f0-9739-754b-b024-346b1c16a866).
 */
definePageMeta({
	middleware: [
		to => to.query.section === 'adapters'
			? navigateTo({ path: '/workspace/product-kit', query: { section: 'overview' } }, { replace: true })
			: undefined,
	],
})
</script>

<template>
  <WorkspaceSettingsPage />
</template>
