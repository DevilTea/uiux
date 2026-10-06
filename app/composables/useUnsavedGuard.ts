import { onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from '#imports'

/**
 * Keeps unsaved drafts from being dropped by navigation (brief g, section 7): leaving the
 * route asks first through an inline modal, and closing the tab triggers the browser prompt.
 */
export function useUnsavedGuard(isDirty: () => boolean) {
	const open = ref(false)
	let settle: ((leave: boolean) => void) | undefined

	onBeforeRouteLeave(() => {
		if (!isDirty()) return true
		open.value = true
		return new Promise<boolean>((resolve) => { settle = resolve })
	})

	function finish(leave: boolean): void {
		open.value = false
		settle?.(leave)
		settle = undefined
	}

	function onBeforeUnload(event: BeforeUnloadEvent): void {
		if (!isDirty()) return
		event.preventDefault()
	}

	onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
	onBeforeUnmount(() => {
		window.removeEventListener('beforeunload', onBeforeUnload)
		finish(false)
	})

	return {
		open,
		leave: () => finish(true),
		stay: () => finish(false),
	}
}
