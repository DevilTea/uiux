import { useI18n, useToast } from '#imports'
import type { ReviewRenderContext } from '../../src/domain/reviews/schema'
import { resolveRecordedContext, type MissingRenderContextKey, type RenderContextKeys } from '../../src/preview/render-context-options'
import { useWorkbench } from './useWorkbench'

/**
 * Opening a thread by its recorded render context (the inbox link and muted-pin activation):
 * the recorded keys are checked against the Workspace's settings at open time (owner ruling
 * 2026-10-09, Discussion #7), and a key that no longer exists opens with its default and a
 * non-blocking notice naming it (Rule 01a1170f-c165). Must be used below `provideWorkbench()`.
 */
export function useRecordedRenderContext() {
	const { t } = useI18n()
	const toast = useToast()
	const workbench = useWorkbench()

	/**
	 * The Workspace-local keys as of now: re-reads the manifest and the Locale list first. `undefined`
	 * when the manifest cannot be read, in which case nothing can be proven stale.
	 */
	async function keysAtOpen(): Promise<RenderContextKeys | undefined> {
		await workbench.refreshRenderContextKeys()
		return workbench.renderContextKeys.value
	}

	/** Splits `recorded` into the members that exist now and the stale ones. */
	async function resolveAtOpen(recorded: ReviewRenderContext | undefined): Promise<ReturnType<typeof resolveRecordedContext>> {
		if (!recorded) return { applied: {}, missing: [] }
		const keys = await keysAtOpen()
		return keys ? resolveRecordedContext(recorded, keys) : { applied: recorded, missing: [] }
	}

	/** The stale-key notice: a non-blocking toast, one sentence per missing member. */
	function noticeMissingContext(missing: readonly MissingRenderContextKey[]): void {
		if (!missing.length) return
		const description = missing.map(item => t(`threadContext.missing.${item.member}`, { key: item.key })).join(' ')
		toast.add({ title: t('threadContext.noticeTitle'), description, color: 'warning', icon: 'i-lucide-triangle-alert', duration: 10_000 })
	}

	return { keysAtOpen, resolveAtOpen, noticeMissingContext }
}
