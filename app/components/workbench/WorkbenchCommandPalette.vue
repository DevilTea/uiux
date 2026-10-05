<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { flowPath, viewLocation } from '../../utils/workbench-routes'

/** ⌘K: go to an area, a View, a Flow or a thread, or run a Workbench action (brief a). */
const { t } = useI18n()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { views, flows, reviews, isReadOnly } = workbench

function statusLabel(status: string | undefined): string {
	if (status === 'resolved') return t('reviews.status.resolved')
	if (status === 'ready-for-review') return t('reviews.status.readyForReview')
	return t('reviews.status.open')
}

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
	const viewNames = new Map(views.value.map(view => [view.key, view.summary.name || t('common.unnamed')]))
	const result: CommandPaletteGroup<CommandPaletteItem>[] = [
		{
			id: 'goto',
			label: t('palette.goTo'),
			items: [
				{ label: t('nav.overview'), icon: 'i-lucide-layout-dashboard', to: '/', kbds: ['g', 'o'] },
				{ label: t('nav.views'), icon: 'i-lucide-app-window', to: '/views', kbds: ['g', 'v'] },
				{ label: t('nav.flows'), icon: 'i-lucide-workflow', to: '/flows', kbds: ['g', 'f'] },
				{ label: t('nav.reviews'), icon: 'i-lucide-inbox', to: '/reviews', kbds: ['g', 'r'] },
				{ label: t('nav.settings'), icon: 'i-lucide-settings-2', to: '/workspace/settings' },
				{ label: t('nav.locales'), icon: 'i-lucide-globe', to: '/workspace/locales' },
				{ label: t('nav.assets'), icon: 'i-lucide-image', to: '/workspace/assets' },
				{ label: t('nav.adapters'), icon: 'i-lucide-puzzle', to: '/workspace/adapters' },
			],
		},
		{
			id: 'views',
			label: t('nav.views'),
			items: views.value.map(view => ({
				label: view.summary.name || t('common.unnamed'),
				suffix: view.summary.feature,
				icon: 'i-lucide-app-window',
				to: viewLocation(view.key),
			})),
		},
		{
			id: 'flows',
			label: t('nav.flows'),
			items: flows.value.map(flow => ({
				label: flow.summary.name || t('flows.list.unnamed'),
				icon: 'i-lucide-workflow',
				to: flowPath(flow.key),
			})),
		},
		{
			id: 'threads',
			label: t('palette.threads'),
			items: reviews.value
				.filter(review => review.summary.anchor)
				.map(review => ({
					label: `#${review.summary.anchor!.widgetId}`,
					suffix: `${viewNames.get(review.summary.anchor!.viewId) ?? review.summary.anchor!.viewId} · ${statusLabel(review.summary.status)}`,
					icon: review.summary.status === 'resolved' ? 'i-lucide-circle-check' : review.summary.status === 'ready-for-review' ? 'i-lucide-eye' : 'i-lucide-circle-dot',
					to: viewLocation(review.summary.anchor!.viewId, { thread: review.key, panel: 'comments' }),
				})),
		},
	]
	const canvas = shell.canvasCommands.value
	if (canvas) {
		result.push({
			id: 'canvas',
			label: t('palette.canvas'),
			items: [
				{ label: t('palette.fit'), icon: 'i-lucide-scan', kbds: ['shift', '1'], onSelect: canvas.fit },
				{ label: t('palette.actualSize'), icon: 'i-lucide-square', kbds: ['shift', '0'], onSelect: canvas.actualSize },
				{ label: t('palette.zoomIn'), icon: 'i-lucide-zoom-in', kbds: ['meta', '='], onSelect: canvas.zoomIn },
				{ label: t('palette.zoomOut'), icon: 'i-lucide-zoom-out', kbds: ['meta', '-'], onSelect: canvas.zoomOut },
				{ label: t('palette.selectTool'), icon: 'i-lucide-mouse-pointer-2', kbds: ['V'], onSelect: () => canvas.selectTool('select') },
				{ label: t('palette.interactTool'), icon: 'i-lucide-hand', kbds: ['I'], onSelect: () => canvas.selectTool('interact') },
			],
		})
	}
	const actions: CommandPaletteItem[] = []
	if (!isReadOnly.value && shell.canToggleCommentMode.value)
		actions.push({ label: t('palette.toggleComment'), icon: 'i-lucide-message-circle-plus', kbds: ['C'], onSelect: () => shell.toggleCommentMode() })
	actions.push(
		{ label: t('palette.toggleTheme'), icon: 'i-lucide-sun-moon', kbds: ['meta', '.'], onSelect: () => shell.toggleWorkbenchTheme() },
		{ label: t('palette.switchLanguage'), icon: 'i-lucide-languages', onSelect: () => shell.switchWorkbenchLanguage() },
		{ label: t('prefs.shortcuts'), icon: 'i-lucide-keyboard', kbds: ['?'], onSelect: () => { shell.shortcutsOpen.value = true } },
	)
	result.push({ id: 'actions', label: t('palette.actions'), items: actions })
	return result.filter(group => group.items?.length)
})
</script>

<template>
  <UDashboardSearch
    v-model:open="shell.searchOpen.value"
    :groups="groups"
    :color-mode="false"
    :placeholder="t('shell.search')"
    :title="t('shell.search')"
    :description="t('palette.description')"
  />
</template>
