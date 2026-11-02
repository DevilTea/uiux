import { describe, expect, it } from 'vitest'

import { contextKey as appContextKey } from '../app/utils/readiness'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { resolveCaptureContexts, type CaptureWorkspaceFacts } from '../src/preview/capture-contexts'
import { requiredContexts } from '../scripts/dogfood-check.mjs'

/**
 * How `uiux evidence capture` turns a selection into the explicit context list a formal capture runs
 * (Rules 01a115cd-c3c9-76fd-8ccd-4a8664e52e7d and 01a115cd-c3fd-7e82-aa05-737aac6c4354): `--all` is the
 * required contexts of `pnpm dogfood:check`, a named selection fills an omitted dimension with the
 * Workspace default, a Variant is captured only when named, and a name the Workspace lacks refuses
 * the whole selection.
 */
const VIEW_A = '2e2f88d6-7a95-424a-b3d4-4661d811ef13'
const VIEW_B = '468247e8-4f39-4f04-8056-b2af4c1c37ea'
const MANIFEST = {
	schemaVersion: 7,
	i18n: { defaultLocale: 'en-US' },
	themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
	viewports: { desktop: { dimensions: { width: 1920, height: 1080 } }, mobile: { dimensions: { width: 390, height: 844 } } },
} as unknown as WorkspaceManifest

const FACTS: CaptureWorkspaceFacts = {
	workspace: MANIFEST,
	locales: ['zh-TW', 'en-US'],
	views: [{ id: VIEW_B, variants: [] }, { id: VIEW_A, variants: ['empty', 'error'] }],
}

const keys = (contexts: readonly Parameters<typeof appContextKey>[0][]) => contexts.map(appContextKey)

describe('resolveCaptureContexts', () => {
	it('resolves --all to every View x Locale x viewport x theme at the base context, as dogfood:check requires', () => {
		const result = resolveCaptureContexts(FACTS, { all: true })
		expect(result.ok).toBe(true)
		const contexts = result.ok ? result.contexts : []
		expect(contexts).toHaveLength(16)
		expect(contexts.every(item => !('variantName' in item))).toBe(true)
		const required = requiredContexts({ views: FACTS.views.map(view => ({ key: view.id })), workspace: MANIFEST, locales: FACTS.locales })
		expect(keys(contexts)).toEqual(required.contexts.map(item => item.key))
	})

	it('falls back to the built-in viewport, theme and Locale of a bare Workspace, as dogfood:check does', () => {
		const bare: CaptureWorkspaceFacts = { workspace: { schemaVersion: 7 } as unknown as WorkspaceManifest, locales: [], views: [{ id: VIEW_A, variants: [] }] }
		const result = resolveCaptureContexts(bare, { all: true })
		expect(result.ok && result.contexts).toEqual([{ viewId: VIEW_A, locale: 'en-US', viewportId: 'default', viewport: { width: 1280, height: 800 }, themeId: 'light' }])
		const required = requiredContexts({ views: [{ key: VIEW_A }], workspace: {}, locales: [] })
		expect(result.ok && keys(result.contexts)).toEqual(required.contexts.map(item => item.key))
	})

	it('gives --all no contexts for a Workspace without Views', () => {
		expect(resolveCaptureContexts({ ...FACTS, views: [] }, { all: true })).toEqual({ ok: true, contexts: [] })
	})

	it('fills an omitted dimension with the Workspace default and captures only the named View', () => {
		const result = resolveCaptureContexts(FACTS, { views: [VIEW_A] })
		// The default viewport is the widest preset, the default theme the first in sorted order.
		expect(result).toEqual({ ok: true, contexts: [{ viewId: VIEW_A, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId: 'dark' }] })
	})

	it('lists the named values of each dimension in the order given, without duplicates', () => {
		const result = resolveCaptureContexts(FACTS, { views: [VIEW_B, VIEW_A, VIEW_B], locales: ['zh-TW', 'en-US', 'zh-TW'], viewports: ['mobile'], themes: ['light'] })
		expect(result.ok && result.contexts.map(item => [item.viewId, item.locale, item.viewportId, item.themeId])).toEqual([
			[VIEW_B, 'zh-TW', 'mobile', 'light'], [VIEW_B, 'en-US', 'mobile', 'light'],
			[VIEW_A, 'zh-TW', 'mobile', 'light'], [VIEW_A, 'en-US', 'mobile', 'light'],
		])
		expect(result.ok && result.contexts.every(item => item.viewport.width === 390 && item.viewport.height === 844)).toBe(true)
	})

	it('adds a named Variant next to the base context, and never a Variant that is not named', () => {
		const result = resolveCaptureContexts(FACTS, { views: [VIEW_A], variants: ['error'], locales: ['en-US'], viewports: ['desktop'], themes: ['light'] })
		expect(result.ok && result.contexts.map(item => item.variantName)).toEqual([undefined, 'error'])
		const none = resolveCaptureContexts(FACTS, { views: [VIEW_A], locales: ['en-US'], viewports: ['desktop'], themes: ['light'] })
		expect(none.ok && none.contexts).toHaveLength(1)
	})

	it('refuses the whole selection that names what the Workspace lacks', () => {
		const message = (selection: Parameters<typeof resolveCaptureContexts>[1]) => {
			const result = resolveCaptureContexts(FACTS, selection)
			return result.ok ? undefined : result.message
		}
		expect(message({ views: ['nope'] })).toContain('no View "nope"')
		expect(message({ views: [VIEW_A], locales: ['fr-FR'] })).toContain('no Locale "fr-FR"')
		expect(message({ views: [VIEW_A], viewports: ['tablet'] })).toContain('no viewport preset "tablet"')
		expect(message({ views: [VIEW_A], themes: ['sepia'] })).toContain('no theme "sepia"')
		expect(message({ views: [VIEW_A], variants: ['gone'] })).toContain('has no Variant "gone"')
		// A Variant must exist in every selected View.
		expect(message({ views: [VIEW_A, VIEW_B], variants: ['empty'] })).toContain(`View "${VIEW_B}" has no Variant "empty"`)
	})
})
