import { describe, expect, it } from 'vitest'
import {
	DEFAULT_VIEWPORT,
	deriveRenderContextOptions,
} from '../src/preview/render-context-options'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'

const VIEW_ID = '00000000-0000-4000-8000-000000000001'

function baseView(variants: ViewResource['variants'] = {}): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Test View',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants,
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function baseWorkspace(overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
	return {
		schemaVersion: 1,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
		...overrides,
	}
}

describe('render context option derivation', () => {
	describe('variants', () => {
		it('derives empty variant state when no variants are authored on the View', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace(),
				view: baseView(),
			})
			expect(options.variants.hasVariants).toBe(false)
			expect(options.variants.available).toHaveLength(0)
			expect(options.variants.selected).toBeUndefined()
			expect(options.variants.isInvalid).toBe(false)
			expect(options.variants.statusMessage).toContain('no variants authored')
		})

		it('derives available variants when authored on the View', () => {
			const view = baseView({
				Compact: { state: {} },
				Expanded: { state: {} },
			})
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace(),
				view,
				selectedVariant: 'Compact',
			})
			expect(options.variants.hasVariants).toBe(true)
			expect(options.variants.available).toEqual(['Compact', 'Expanded'])
			expect(options.variants.selected).toBe('Compact')
			expect(options.variants.isInvalid).toBe(false)
			expect(options.variants.statusMessage).toBe('Compact')
		})

		it('flags an invalid variant when selecting an unauthored variant', () => {
			const view = baseView({
				Compact: { state: {} },
			})
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace(),
				view,
				selectedVariant: 'NonExistent',
			})
			expect(options.variants.hasVariants).toBe(true)
			expect(options.variants.isInvalid).toBe(true)
			expect(options.variants.statusMessage).toContain('Invalid variant')
		})
	})

	describe('locales', () => {
		it('uses workspace defaultLocale when no additional locales exist', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ i18n: { defaultLocale: 'zh-TW' } }),
			})
			expect(options.locales.defaultLocale).toBe('zh-TW')
			expect(options.locales.available).toEqual(['zh-TW'])
			expect(options.locales.hasAdditionalLocales).toBe(false)
			expect(options.locales.selected).toBe('zh-TW')
			expect(options.locales.isInvalid).toBe(false)
		})

		it('merges discovered locales with defaultLocale first', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ i18n: { defaultLocale: 'en-US' } }),
				discoveredLocales: ['zh-TW', 'ja-JP', 'en-US'],
				selectedLocale: 'zh-TW',
			})
			expect(options.locales.available).toEqual(['en-US', 'zh-TW', 'ja-JP'])
			expect(options.locales.hasAdditionalLocales).toBe(true)
			expect(options.locales.selected).toBe('zh-TW')
			expect(options.locales.isInvalid).toBe(false)
		})

		it('flags an invalid locale selection', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ i18n: { defaultLocale: 'en-US' } }),
				discoveredLocales: ['zh-TW'],
				selectedLocale: 'fr-FR',
			})
			expect(options.locales.isInvalid).toBe(true)
			expect(options.locales.statusMessage).toContain('Invalid locale')
		})
	})

	describe('viewports', () => {
		it('falls back to default desktop viewport when workspace.json has no viewports defined', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ viewports: {} }),
			})
			expect(options.viewports.isEmpty).toBe(true)
			expect(options.viewports.isInvalid).toBe(false)
			expect(options.viewports.selectedId).toBe(DEFAULT_VIEWPORT.id)
			expect(options.viewports.selectedDimensions).toEqual({
				width: DEFAULT_VIEWPORT.width,
				height: DEFAULT_VIEWPORT.height,
			})
			expect(options.viewports.statusMessage).toContain('No presets in workspace.json')
		})

		it('derives configured viewports from workspace.json', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					viewports: {
						mobile: { dimensions: { width: 390, height: 844 } },
						tablet: { dimensions: { width: 820, height: 1180 } },
						desktop: { dimensions: { width: 1440, height: 900 } },
					},
				}),
				selectedViewportId: 'tablet',
			})
			expect(options.viewports.isEmpty).toBe(false)
			expect(options.viewports.available).toHaveLength(3)
			expect(options.viewports.selectedId).toBe('tablet')
			expect(options.viewports.selectedDimensions).toEqual({ width: 820, height: 1180 })
			expect(options.viewports.isInvalid).toBe(false)
		})

		it('flags invalid viewport selection when selecting unknown preset', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					viewports: {
						desktop: { dimensions: { width: 1280, height: 800 } },
					},
				}),
				selectedViewportId: 'unknown-viewport',
			})
			expect(options.viewports.isInvalid).toBe(true)
			expect(options.viewports.statusMessage).toContain('Invalid viewport')
		})
	})

	describe('themes', () => {
		it('reports empty themes state when workspace.json has no themes', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ themes: {} }),
			})
			expect(options.themes.isEmpty).toBe(true)
			expect(options.themes.available).toHaveLength(0)
			expect(options.themes.isInvalid).toBe(false)
			expect(options.themes.statusMessage).toContain('Default (no themes defined)')
		})

		it('derives configured themes and selected theme', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					themes: {
						dark: {},
						light: {},
						contrast: {},
					},
				}),
				selectedThemeId: 'dark',
			})
			expect(options.themes.isEmpty).toBe(false)
			expect(options.themes.available).toEqual(['contrast', 'dark', 'light'])
			expect(options.themes.selected).toBe('dark')
			expect(options.themes.isInvalid).toBe(false)
		})

		it('flags invalid theme when selecting unknown theme ID', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					themes: {
						light: {},
					},
				}),
				selectedThemeId: 'neon',
			})
			expect(options.themes.isInvalid).toBe(true)
			expect(options.themes.statusMessage).toContain('Invalid theme')
		})
	})
})
