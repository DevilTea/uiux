import { defineNuxtPlugin } from '#imports'
import { readSavedWorkbenchLocale, resolveInitialWorkbenchLocale } from '../utils/workbench-locale'

/** Applies the saved or browser-derived Workbench chrome locale before the first render. */
export default defineNuxtPlugin({
	name: 'uiux:workbench-locale',
	dependsOn: ['i18n:plugin'],
	async setup(nuxtApp) {
		const i18n = nuxtApp.$i18n
		const languages = typeof navigator === 'undefined'
			? []
			: (navigator.languages?.length ? navigator.languages : [navigator.language])
		const initial = resolveInitialWorkbenchLocale(readSavedWorkbenchLocale(), languages)
		if (i18n.locale.value !== initial) await i18n.setLocale(initial)
	},
})
