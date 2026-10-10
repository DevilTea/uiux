import { computed } from 'vue'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'

/**
 * Rule 01a11a5e-1ba5-765e-966f-a681def5f472: the canvas before/after comparison is offered on desktop
 * and tablet layouts, never on a phone in either orientation (a handset, as for Create Checkpoint).
 * Elsewhere the `canvas` address key is kept but shows nothing.
 */
export function useVersionCanvasAccess() {
	const atLeastTablet = useMediaQuery('(min-width: 768px)')
	const handset = useMediaQuery(WORKBENCH_BREAKPOINTS.handset)
	const offered = computed(() => atLeastTablet.value && !handset.value)
	return { offered }
}
