import { describe, expect, it } from 'vitest'
import { resolveTranslationFallbackLocale } from '../src/preview/browser-runtime'
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

	it('falls back to the requested locale when the Workspace default locale has no resource', () => {
		expect(resolveTranslationFallbackLocale('zh-TW', 'fr-FR', resources)).toBe('zh-TW')
		expect(resolveTranslationFallbackLocale('zh-TW', 'fr-FR', new Map([['zh-TW', {}]]))).toBe('zh-TW')
	})

	it('uses the manifest-less render context fallback when the Workspace default is unknown', () => {
		expect(resolveTranslationFallbackLocale('fr-FR', undefined, resources)).toBe('en-US')
		expect(resolveTranslationFallbackLocale('zh-TW', undefined, new Map([['zh-TW', {}]]))).toBe('zh-TW')
	})
})
