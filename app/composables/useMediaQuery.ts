import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** Reactive `matchMedia` for the SPA (no SSR), e.g. the Workbench device-class breakpoints. */
export function useMediaQuery(query: string): Ref<boolean> {
	const matches = ref(typeof window !== 'undefined' && window.matchMedia(query).matches)
	let list: MediaQueryList | undefined
	const update = (event: MediaQueryListEvent) => { matches.value = event.matches }
	onMounted(() => {
		list = window.matchMedia(query)
		matches.value = list.matches
		list.addEventListener('change', update)
	})
	onBeforeUnmount(() => list?.removeEventListener('change', update))
	return matches
}

/** Tailwind breakpoints used by the Workbench shell (DESIGN.md "Device classes"). */
export const WORKBENCH_BREAKPOINTS = {
	/** Desktop: everything inline. */
	desktop: '(min-width: 1280px)',
	/** Tablet and up: the sidebar is inline (rail below desktop). */
	tablet: '(min-width: 1024px)',
} as const
