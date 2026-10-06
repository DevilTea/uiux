import { nextTick, onMounted, watch } from 'vue'
import { useI18n } from '#imports'

/**
 * reka-ui names the toast region "Notifications (F8)" in English and Nuxt UI's Toaster does not
 * forward that prop, so the region's accessible name is set after mount and on a language change.
 * Vue only patches an attribute when its own binding changes, so the name sticks.
 */
export function useToastRegionName(): void {
	const { locale, t } = useI18n()
	function name(): void {
		const region = document.querySelector('[data-slot="viewport"]')?.closest('[role="region"]')
		region?.setAttribute('aria-label', t('a11y.notificationsRegion', { hotkey: 'F8' }))
	}
	onMounted(() => { void nextTick(name) })
	watch(locale, () => { void nextTick(name) })
}
