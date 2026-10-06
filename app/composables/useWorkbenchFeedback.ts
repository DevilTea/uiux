import { useToast } from '#imports'
import { diagnosticLines } from '../utils/diagnostic-copy'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'

/**
 * Operation feedback for Workbench panels: success and error toasts.
 * Errors are always shown with error styling and the server's diagnostics in the UI language
 * (`utils/diagnostic-copy.ts`), never the raw `$fetch` transport string.
 */
export function useWorkbenchFeedback() {
	const toast = useToast()

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
		const extra = diagnosticLines(details.message, details.diagnostics)
		toast.add({
			title: details.message,
			...(extra.length ? { description: extra.join(' ') } : {}),
			color: 'error',
			icon: 'i-lucide-circle-alert',
			// Error toasts persist until dismissed (brief h): a failure is never timed away.
			duration: 0,
			progress: false,
		})
		return details
	}

	return { success, error, describe: describeFetchError }
}
