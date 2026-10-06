import { defineNuxtPlugin } from '#imports'
import { diagnosticMessageKey, diagnosticNamespaceKey, setDiagnosticLocalizer } from '../utils/diagnostic-copy'
import { DEFAULT_WORKBENCH_LOCALE } from '../utils/workbench-locale'

/**
 * Registers the i18n-backed diagnostic localizer (see `utils/diagnostic-copy.ts`). Lookups read the
 * global composer's locale, so a template that renders `diagnosticText(...)` re-renders when the
 * Workbench language changes. Every catalog shares the en-US key set (tests/workbench-i18n.test.ts),
 * so existence is checked against en-US; `te` is true only for a message, never for a key prefix.
 */
export default defineNuxtPlugin({
	name: 'uiux:diagnostic-copy',
	dependsOn: ['i18n:plugin'],
	setup(nuxtApp) {
		const i18n = nuxtApp.$i18n
		const has = (key: string) => i18n.te(key, DEFAULT_WORKBENCH_LOCALE)
		setDiagnosticLocalizer({
			sourceLocale: () => i18n.locale.value === DEFAULT_WORKBENCH_LOCALE,
			exact: (code) => {
				const key = diagnosticMessageKey(code)
				return has(key) ? i18n.t(key) : undefined
			},
			namespace: (code) => {
				const key = diagnosticNamespaceKey(code)
				return i18n.t(has(key) ? key : 'diagnosticFallback.generic')
			},
		})
	},
})
