<script setup lang="ts">
import { computed } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { isWidgetAnchor, isWorkspaceAnchor } from '../../../src/domain/reviews/schema'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useCheckpointAccess } from '../../composables/useCheckpointAccess'
import { ADAPTERS_LOCATION, flowPath, viewLocation, VIEWS_LOCATION } from '../../utils/workbench-routes'

/** ⌘K: go to an area, a View, a Flow or a thread, or run a Workbench action (brief a). */
const { t } = useI18n()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { views, flows, reviews } = workbench
const route = useRoute()
const checkpoints = useCheckpointAccess()

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
				{ label: t('nav.views'), icon: 'i-lucide-app-window', to: VIEWS_LOCATION, kbds: ['g', 'v'] },
				{ label: t('nav.flows'), icon: 'i-lucide-workflow', to: '/flows', kbds: ['g', 'f'] },
				{ label: t('nav.reviews'), icon: 'i-lucide-inbox', to: '/reviews', kbds: ['g', 'r'] },
				{ label: t('nav.settings'), icon: 'i-lucide-settings-2', to: '/workspace/settings' },
				{ label: t('nav.locales'), icon: 'i-lucide-globe', to: '/workspace/locales' },
				{ label: t('nav.assets'), icon: 'i-lucide-image', to: '/workspace/assets' },
				{ label: t('nav.adapters'), icon: 'i-lucide-puzzle', to: ADAPTERS_LOCATION },
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
			items: reviews.value.flatMap((review) => {
				const anchor = review.summary.anchor
				const icon = review.summary.status === 'resolved' ? 'i-lucide-circle-check' : review.summary.status === 'ready-for-review' ? 'i-lucide-eye' : 'i-lucide-circle-dot'
				// A Workspace comment lives in Reviews only; its link is `/reviews?thread=<id>`.
				if (isWorkspaceAnchor(anchor))
					return [{ label: t('comments.workspaceComment'), suffix: statusLabel(review.summary.status), icon, to: { path: '/reviews', query: { thread: review.key } } }]
				if (!isWidgetAnchor(anchor)) return []
				return [{
					label: anchor.widgetId === 'root' ? t('comments.viewTarget') : `#${anchor.widgetId}`,
					suffix: `${viewNames.get(anchor.viewId) ?? anchor.viewId} · ${statusLabel(review.summary.status)}`,
					icon,
					to: viewLocation(anchor.viewId, { thread: review.key, panel: 'comments' }),
				}]
			}),
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
	// Offered with the canvas; when it can't start, it is listed disabled with the reason, never just missing.
	if (canvas) {
		const toolBlocked = canvas.commentBlockedReason()
		const viewBlocked = canvas.viewCommentBlockedReason()
		actions.push(
			{ label: t('palette.toggleComment'), icon: 'i-lucide-message-circle-plus', kbds: toolBlocked ? undefined : ['C'], disabled: !!toolBlocked, suffix: toolBlocked, onSelect: () => canvas.selectTool('comment') },
			{ label: t('comments.commentOnView'), icon: 'i-lucide-message-square-plus', disabled: !!viewBlocked, suffix: viewBlocked, onSelect: () => canvas.commentOnView() },
		)
	}
	// "Comment on Workspace" (scope/edit decision 8): opens the inbox composer, offering the View
	// the reviewer is on as the other choice. Viewers see it disabled, with the reason.
	const fromView = route.path.startsWith('/views/') ? workbench.selectedViewId.value : undefined
	actions.push({
		label: t('palette.commentOnWorkspace'),
		icon: 'i-lucide-globe',
		disabled: workbench.reviewReadOnly.value,
		...(workbench.reviewReadOnly.value ? { suffix: t('inbox.readOnly') } : {}),
		onSelect: () => { void navigateTo({ path: '/reviews', query: { compose: 'workspace', ...(fromView ? { from: fromView } : {}) } }) },
	})
	// Create Checkpoint (Rule 01a11a5e-0c71-78d1-9adb-14db6c67ab9c): desktop and tablet only, never on a
	// phone (Rule 01a11a5e-1ba5-765e-966f-a681def5f472); below Reviewer it is listed disabled with the reason.
	if (checkpoints.createOffered.value) {
		const blocked = checkpoints.createBlockedReason.value
		actions.push({
			label: t('history.checkpoint.create'),
			icon: 'i-lucide-flag',
			disabled: !!blocked,
			...(blocked ? { suffix: blocked } : {}),
			onSelect: () => { shell.checkpointOpen.value = true },
		})
	}
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
