import { describe, expect, it } from 'vitest'
import {
	DEFAULT_VIEWPORT,
	FALLBACK_LOCALE,
	FALLBACK_THEME_ID,
	captureRenderContext,
	deriveRenderContextOptions,
	effectiveRenderContext,
	resolveRecordedContext,
	workspaceRenderContextKeys,
	resolveDefaultLocale,
	resolveDefaultThemeId,
	resolveDefaultViewport,
} from '../src/preview/render-context-options'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'

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
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
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
			expect(options.variants.status).toEqual({ code: 'none' })
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
			expect(options.variants.status).toEqual({ code: 'selected', value: 'Compact' })
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
			expect(options.variants.status).toEqual({ code: 'invalid', value: 'NonExistent' })
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
			expect(options.locales.status).toEqual({ code: 'invalid', value: 'fr-FR' })
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
			expect(options.viewports.status).toEqual({ code: 'none' })
			expect(options.viewports.available).toEqual([DEFAULT_VIEWPORT])
			expect(DEFAULT_VIEWPORT.isDefault).toBe(true)
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
			expect(options.viewports.status).toEqual({ code: 'invalid', value: 'unknown-viewport' })
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
			expect(options.themes.status).toEqual({ code: 'none', value: FALLBACK_THEME_ID })
			expect(options.themes.selected).toBe(FALLBACK_THEME_ID)
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
			expect(options.themes.status).toEqual({ code: 'invalid', value: 'neon' })
		})
	})

	describe('labels and effective defaults', () => {
		it('labels viewport options with the authored preset label, not the id', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					viewports: {
						desktop: { dimensions: { width: 1280, height: 800 }, label: 'Desktop' },
						phone: { dimensions: { width: 390, height: 844 } },
					},
				}),
			})
			expect(options.viewports.available).toEqual([
				{ id: 'desktop', width: 1280, height: 800, label: 'Desktop' },
				{ id: 'phone', width: 390, height: 844 },
			])
			expect(options.viewports.selectedId).toBe('desktop')
		})

		it('orders viewport presets widest first with the id as tiebreak', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({
					viewports: {
						desktop: { dimensions: { width: 1920, height: 1080 }, label: 'FHD Desktop' },
						mobile: { dimensions: { width: 390, height: 844 } },
						tablet: { dimensions: { width: 820, height: 1180 } },
						alt: { dimensions: { width: 820, height: 1000 } },
					},
				}),
			})
			expect(options.viewports.available.map(item => item.id)).toEqual(['desktop', 'alt', 'tablet', 'mobile'])
			expect(options.viewports.selectedId).toBe('desktop')
		})

		it('exposes authored theme labels alongside theme ids', () => {
			const options = deriveRenderContextOptions({
				workspace: baseWorkspace({ themes: { light: { label: 'Light' }, dark: { label: 'Dark' }, plain: {} } }),
			})
			expect(options.themes.options).toEqual([
				{ id: 'dark', label: 'Dark' },
				{ id: 'light', label: 'Light' },
				{ id: 'plain' },
			])
		})

		it('resolves the same effective defaults the preview host uses', () => {
			const workspace = baseWorkspace({
				i18n: { defaultLocale: 'zh-TW' },
				themes: { light: {}, dark: {} },
				viewports: { tablet: { dimensions: { width: 820, height: 1180 } } },
			})
			const options = deriveRenderContextOptions({ workspace })
			expect(resolveDefaultThemeId(workspace)).toBe('dark')
			expect(options.themes.selected).toBe(resolveDefaultThemeId(workspace))
			expect(resolveDefaultLocale(workspace)).toBe('zh-TW')
			expect(options.locales.selected).toBe(resolveDefaultLocale(workspace))
			expect(resolveDefaultViewport(workspace).id).toBe('tablet')
			expect(options.viewports.selectedId).toBe(resolveDefaultViewport(workspace).id)
			expect(resolveDefaultThemeId(baseWorkspace())).toBe(FALLBACK_THEME_ID)
			expect(resolveDefaultViewport(baseWorkspace())).toBe(DEFAULT_VIEWPORT)
		})
	})
})

describe('recorded render context (Part 7, schemaVersion 4)', () => {
	// The browser fixture's shape: Locale files en-US and zh-TW, authored viewports and themes.
	const authored = baseWorkspace({
		viewports: { desktop: { dimensions: { width: 1920, height: 1080 } }, mobile: { dimensions: { width: 390, height: 844 } } },
		themes: { dark: {}, light: {} },
	})
	const keys = workspaceRenderContextKeys(authored, ['en-US', 'zh-TW'])

	it('takes the Locale set from the i18n files plus defaultLocale, and the viewport and theme IDs from the manifest (Clause 01a11e0d-d2d0)', () => {
		expect([...workspaceRenderContextKeys(baseWorkspace({ i18n: { defaultLocale: 'ja-JP' } }), ['en-US']).locales].sort()).toEqual(['en-US', 'ja-JP'])
		expect([...keys.viewportIds].sort()).toEqual(['desktop', 'mobile'])
		expect([...keys.themeIds].sort()).toEqual(['dark', 'light'])
		// Built-in fallbacks are never keys: no `default` viewport, no `light` theme when not authored.
		const bare = workspaceRenderContextKeys(baseWorkspace(), [])
		expect([...bare.viewportIds]).toEqual([])
		expect([...bare.themeIds]).toEqual([])
		expect([...workspaceRenderContextKeys(undefined, []).locales]).toEqual([])
	})

	it('captures every current member that is a Workspace-local key (Rule 01a1170f-c0ce)', () => {
		expect(captureRenderContext(keys, { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' })).toEqual({ locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' })
	})

	it('records only the authored members: a built-in fallback or an unknown value is left out (Scenario 01a11e0e-42a3)', () => {
		const workspace = baseWorkspace({ viewports: { mobile: { dimensions: { width: 390, height: 844 } } } })
		const options = deriveRenderContextOptions({ workspace, discoveredLocales: ['en-US', 'zh-TW'], selectedLocale: 'zh-TW', selectedViewportId: 'mobile' })
		// The Preview shows the built-in `light` theme, which this Workspace does not author.
		expect(options.themes.selected).toBe(FALLBACK_THEME_ID)
		const current = { locale: options.locales.selected, viewportId: options.viewports.selectedId, themeId: options.themes.selected }
		expect(captureRenderContext(workspaceRenderContextKeys(workspace, ['en-US', 'zh-TW']), current)).toEqual({ locale: 'zh-TW', viewportId: 'mobile' })
		expect(captureRenderContext(keys, { locale: 'fr-FR', viewportId: 'watch', themeId: 'dark' })).toEqual({ themeId: 'dark' })
	})

	it('records no render context when no member qualifies', () => {
		const workspace = baseWorkspace()
		const options = deriveRenderContextOptions({ workspace })
		expect(options.viewports.selectedId).toBe(DEFAULT_VIEWPORT.id)
		// Only the default Locale qualifies on a bare Workspace, so a non-default Locale without a file records nothing.
		expect(captureRenderContext(workspaceRenderContextKeys(workspace, []), { locale: 'zh-TW', viewportId: options.viewports.selectedId, themeId: options.themes.selected })).toBeUndefined()
		expect(captureRenderContext(workspaceRenderContextKeys(undefined, []), { locale: FALLBACK_LOCALE, viewportId: DEFAULT_VIEWPORT.id, themeId: FALLBACK_THEME_ID })).toBeUndefined()
		expect(captureRenderContext(keys, {})).toBeUndefined()
	})

	it('splits a recorded context into the members that exist and the stale ones, never rebinding (Rule 01a1170f-c165)', () => {
		expect(resolveRecordedContext({ locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }, keys)).toEqual({ applied: { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }, missing: [] })
		const withoutMobile = workspaceRenderContextKeys(baseWorkspace({ viewports: { desktop: { dimensions: { width: 1920, height: 1080 } } }, themes: { dark: {} } }), ['en-US', 'zh-TW'])
		expect(resolveRecordedContext({ locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }, withoutMobile)).toEqual({
			applied: { locale: 'zh-TW', themeId: 'dark' },
			missing: [{ member: 'viewportId', key: 'mobile' }],
		})
		expect(resolveRecordedContext({ locale: 'fr-FR', themeId: 'sepia' }, keys)).toEqual({
			applied: {},
			missing: [{ member: 'locale', key: 'fr-FR' }, { member: 'themeId', key: 'sepia' }],
		})
		// No recorded context, or an unrecorded member, is neither applied nor missing.
		expect(resolveRecordedContext(undefined, keys)).toEqual({ applied: {}, missing: [] })
		expect(resolveRecordedContext({ viewportId: 'mobile' }, keys)).toEqual({ applied: { viewportId: 'mobile' }, missing: [] })
	})

	it('compares selections by what the Preview shows, with empty members as their defaults', () => {
		const locales = ['en-US', 'zh-TW']
		expect(effectiveRenderContext(authored, locales, {})).toEqual({ locale: 'en-US', viewportId: 'desktop', themeId: 'dark' })
		expect(effectiveRenderContext(authored, locales, { locale: 'en-US', viewport: 'desktop', theme: 'dark' })).toEqual(effectiveRenderContext(authored, locales, {}))
		expect(effectiveRenderContext(authored, locales, { viewport: 'mobile' }).viewportId).toBe('mobile')
	})
})
