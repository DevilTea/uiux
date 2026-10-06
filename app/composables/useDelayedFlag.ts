import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

/**
 * A loading flag that turns on only after `delay` ms (brief h, section 7: skeletons appear after
 * 150ms so fast loads never flash) and turns off at once.
 */
export function useDelayedFlag(source: MaybeRefOrGetter<boolean>, delay = 150): Ref<boolean> {
	const shown = ref(false)
	let timer: ReturnType<typeof setTimeout> | undefined
	const clear = () => {
		if (timer) clearTimeout(timer)
		timer = undefined
	}
	watch(() => toValue(source), (active) => {
		clear()
		if (!active) {
			shown.value = false
			return
		}
		timer = setTimeout(() => { shown.value = true }, delay)
	}, { immediate: true })
	onBeforeUnmount(clear)
	return shown
}
