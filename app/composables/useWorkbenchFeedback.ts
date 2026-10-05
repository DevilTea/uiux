import { useI18n, useToast } from '#imports'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'

/**
 * Operation feedback for Workbench panels: success and error toasts.
 * Errors are always shown with error styling and the server's diagnostic body,
 * never the raw `$fetch` transport string.
 */
export function useWorkbenchFeedback() {
	const toast = useToast()
	const { t } = useI18n()

	function success(title: string, description?: string): void {
		toast.add({
			title,
			...(description ? { description } : {}),
			color: 'success',
			icon: 'i-lucide-circle-check',
		})
	}

	function error(cause: unknown, fallback: string): FetchErrorDetails {
		const details = describeFetchError(cause, fallback)
		const extra = details.diagnostics
			.map(item => item.message)
			.filter(item => item !== details.message)
		toast.add({
			title: details.message,
			...(extra.length ? { description: extra.join(' ') } : {}),
			color: 'error',
			icon: 'i-lucide-circle-alert',
			duration: 8000,
			close: { 'aria-label': t('common.dismiss') },
		})
		return details
	}

	return { success, error, describe: describeFetchError }
}
