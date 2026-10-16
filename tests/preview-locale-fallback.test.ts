import { describe, expect, it } from 'vitest'
import { createStandalonePreviewMount, resolveTranslationFallbackLocale, type PreviewRuntimeStatus } from '../src/preview/browser-runtime'
import { createTranslationRuntime } from '../src/i18n'
import type { I18nResource } from '../src/domain/i18n/schema'

const resources = new Map<string, I18nResource>([
	['en-US', { title: 'Title', subtitle: 'Subtitle' }],
	['zh-TW', { title: '標題' }],
	['ja-JP', { title: 'タイトル' }],
])

describe('preview translation fallback locale', () => {
	it('uses the Workspace default locale as the fallback, not the requested locale', () => {
		expect(resolveTranslationFallbackLocale('zh-TW', 'en-US', resources)).toBe('en-US')
		const state = createTranslationRuntime(resolveTranslationFallbackLocale('zh-TW', 'en-US', resources), resources)
		expect(state.state).toBe('ready')
		if (state.state !== 'ready') return
		expect(state.runtime.translate('zh-TW', 'title').text).toBe('標題')
		const missing = state.runtime.translate('zh-TW', 'subtitle')
		expect(missing.text).toBe('Subtitle')
		expect(missing.warnings).toEqual([{ code: 'missing-translation', key: 'subtitle', requestedLocale: 'zh-TW', fallbackLocale: 'en-US' }])
	})

	it('honours a non-en-US Workspace default locale', () => {
		expect(resolveTranslationFallbackLocale('en-US', 'ja-JP', resources)).toBe('ja-JP')
	})

	// Rule 01a115cd-b24f-7bcd-acd8-6b00d0aceff2: no Locale stands in for a known default without its
	// resource; the Preview is blocked instead (tests/missing-default-locale.test.ts).
	it('keeps the Workspace default locale even when it has no resource', () => {
		expect(resolveTranslationFallbackLocale('zh-TW', 'fr-FR', resources)).toBe('fr-FR')
		expect(resolveTranslationFallbackLocale('zh-TW', 'fr-FR', new Map([['zh-TW', {}]]))).toBe('fr-FR')
	})

	it('blocks the Preview construction while the Workspace default locale has no resource', () => {
		const statuses: PreviewRuntimeStatus[] = []
		const container = {} as HTMLElement
		const bridge = createStandalonePreviewMount({ adapterDescriptors: [] }).mountPreviewRuntime(container, {
			view: { id: 'v', name: 'V', ir: { type: 'RootShell', id: 'root', slots: { content: [] } } } as never,
			context: { viewId: 'v', locale: 'zh-TW', viewportId: 'desktop', viewport: { width: 800, height: 600 }, themeId: 'light' },
			locales: new Map([['zh-TW', { title: '標題' }]]),
			defaultLocale: 'en-US',
			onStatusChange: status => statuses.push(status),
		})
		expect(statuses).toEqual([{ status: 'blocked', diagnostics: [{ code: 'i18n.missing_default_locale', path: '/i18n/en-US', message: expect.any(String) }] }])
		// Nothing is constructed: the bridge takes no update and reports nothing more.
		bridge.updateContext({ viewId: 'v', locale: 'en-US', viewportId: 'desktop', viewport: { width: 800, height: 600 }, themeId: 'light' })
		bridge.dispose()
		expect(statuses).toHaveLength(1)
	})

	it('uses the manifest-less render context fallback when the Workspace default is unknown', () => {
		expect(resolveTranslationFallbackLocale('fr-FR', undefined, resources)).toBe('en-US')
		expect(resolveTranslationFallbackLocale('zh-TW', undefined, new Map([['zh-TW', {}]]))).toBe('zh-TW')
	})
})
