import { nextTick } from 'vue'

/**
 * After a rejected save (brief h, section 9): focus the first invalid field inside `root`, or else
 * the first alert there, so keyboard and screen-reader users land on what needs fixing. Alerts get
 * `tabindex="-1"` so they can take focus without joining the tab order.
 */
export async function focusFirstProblem(root: HTMLElement | string | null | undefined): Promise<void> {
	await nextTick()
	await new Promise(resolve => requestAnimationFrame(resolve))
	const scope = typeof root === 'string' ? document.querySelector<HTMLElement>(root) : root
	if (!scope) return
	const field = scope.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')
	const target = field ?? scope.querySelector<HTMLElement>('[role="alert"], [data-locked-alert], [data-conflict-alert]')
	if (!target) return
	if (!field && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
	target.focus({ preventScroll: false })
}
