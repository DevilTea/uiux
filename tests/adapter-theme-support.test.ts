import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspaceAdapterSet, type AdapterManifestLoader, type ResolvedAdapterModule } from '../src/adapters'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import type { AdapterManifest } from '../src/domain/adapters/schema'
import { validateRenderContextSelection, type ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { resolveSelectedWorkspaceAdapters, selectedWorkspaceThemeSupport } from '../src/server/workspace-adapters'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * Adapter theme support (issue #99): the manifest's `themeSupport` predicate (Clause
 * 01a11a5a-448c-76ba-94d4-6766435b9e2b), its shape check in server-side resolution (Rule
 * 01a11a5a-4c2c-7330-8fac-11a6c970713a), its evaluation once per resolution for every Workspace theme
 * (Rules 01a11a5a-5464-7797-82d3-f8ece37457e5, 01a11a5a-54e2-7216-a5a1-0de226971850,
 * 01a11a5a-555f-7b4c-8fcc-311c31a99b7a, 01a11a5a-55ee-737a-9970-cb9228a2de30 and
 * 01a11a5a-56e8-71c8-905a-62ed0476fd8f) and formal capture's refusal of an unsupported theme (Rules
 * 01a11add-f46d-7e92-8f5a-9d10dba6473d and 01a11a5a-566b-70b1-b000-2918519c0d19). The Preview and the
 * Product Kit page are exercised against the built server in tests/adapter-theme-support-browser.test.ts.
 */

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function manifest(id: string, overrides: Record<string, unknown> = {}): AdapterManifest {
	return { id, apiVersion: 'compatible', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [], ...overrides } as AdapterManifest
}

function fixtureInput(selections: readonly WorkspaceAdapterSelection[], manifests: Record<string, unknown>, themeIds?: readonly string[]) {
	const loader: AdapterManifestLoader = {
		async loadManifest(resolved) {
			return manifests[resolved.moduleSpecifier]
		},
	}
	return {
		workspaceRoot: '/virtual/workspace',
		adapters: selections,
		resolver: {
			async resolve(_root: string, moduleSpecifier: string): Promise<ResolvedAdapterModule> {
				return { moduleSpecifier, resolvedPath: `/virtual/${moduleSpecifier}.mjs`, moduleIdentity: `file:///virtual/${moduleSpecifier}.mjs` }
			},
		},
		loader,
		apiCompatibility: { isCompatible: (version: string) => version === 'compatible' },
		registryInspector: { async inspect() { return { widgetTypes: [], rendererKeys: [] } } },
		...(themeIds ? { themeIds } : {}),
	}
}

describe('Adapter theme support in server-side resolution', () => {
	it('treats an Adapter without themeSupport as supporting every theme', async () => {
		const result = await resolveWorkspaceAdapterSet(fixtureInput([{ moduleSpecifier: 'plain' }], { plain: manifest('plain') }, ['light', 'contrast']))
		expect(result).toMatchObject({ state: 'valid', themeSupport: { themeIds: ['light', 'contrast'], unsupportedThemeIds: [], diagnostics: [] } })
		if (result.state !== 'valid') return
		expect(result.summaries[0]).not.toHaveProperty('unsupportedThemeIds')
	})

	it('asks each predicate once per resolution about every registry theme, with the entry\'s frozen config', async () => {
		const calls: Array<{ themeId: string; context: unknown }> = []
		const gate = manifest('gate', {
			themeSupport: {
				supports(themeId: string, context: { config: unknown }) {
					calls.push({ themeId, context })
					return themeId !== 'contrast'
				},
			},
		})
		const config = { themeMap: { dark: 'midnight' } }
		const result = await resolveWorkspaceAdapterSet(fixtureInput(
			[{ moduleSpecifier: 'plain' }, { moduleSpecifier: 'gate', config }],
			{ plain: manifest('plain'), gate: { ...gate, configSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } } },
			['dark', 'light', 'contrast'],
		))
		expect(result.state).toBe('valid')
		if (result.state !== 'valid') return
		expect(calls.map(call => call.themeId)).toEqual(['dark', 'light', 'contrast'])
		const context = calls[0]!.context as { config: { themeMap: Record<string, string> } }
		expect(context).toEqual({ config })
		expect(Object.isFrozen(context)).toBe(true)
		expect(Object.isFrozen(context.config.themeMap)).toBe(true)
		// The predicate gets a copy, so the configuration the Preview receives stays as validated.
		expect(context.config).not.toBe(config)
		// Set-level: the set stays valid, and the Adapter that rejects the theme lists it.
		expect(result.themeSupport).toEqual({ themeIds: ['dark', 'light', 'contrast'], unsupportedThemeIds: ['contrast'], diagnostics: [] })
		expect(result.summaries.map(summary => summary.unsupportedThemeIds)).toEqual([undefined, ['contrast']])
	})

	it('makes a theme unsupported as soon as any active Adapter rejects it', async () => {
		const result = await resolveWorkspaceAdapterSet(fixtureInput(
			[{ moduleSpecifier: 'a' }, { moduleSpecifier: 'b' }],
			{
				a: manifest('a', { themeSupport: { supports: (themeId: string) => themeId !== 'dark' } }),
				b: manifest('b', { themeSupport: { supports: (themeId: string) => themeId === 'light' } }),
			},
			['dark', 'light', 'sepia'],
		))
		expect(result).toMatchObject({ state: 'valid', themeSupport: { unsupportedThemeIds: ['dark', 'sepia'] } })
		if (result.state !== 'valid') return
		expect(result.summaries.map(summary => summary.unsupportedThemeIds)).toEqual([['dark'], ['dark', 'sepia']])
	})

	it('fails closed on a predicate that throws or returns a non-boolean, with an Adapter diagnostic that leaves the set valid', async () => {
		const result = await resolveWorkspaceAdapterSet(fixtureInput(
			[{ moduleSpecifier: 'plain' }, { moduleSpecifier: 'flaky' }],
			{
				plain: manifest('plain'),
				flaky: manifest('flaky', {
					themeSupport: {
						supports(themeId: string) {
							if (themeId === 'dark') throw new Error('no dark tokens')
							if (themeId === 'sepia') return 'yes'
							if (themeId === 'async') return Promise.reject(new Error('later'))
							return true
						},
					},
				}),
			},
			['dark', 'light', 'sepia', 'async'],
		))
		expect(result.state).toBe('valid')
		if (result.state !== 'valid') return
		expect(result.themeSupport.unsupportedThemeIds).toEqual(['dark', 'sepia', 'async'])
		expect(result.themeSupport.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.path])).toEqual([
			['adapter.theme_support_failed', '/adapters/1/manifest/themeSupport'],
			['adapter.theme_support_failed', '/adapters/1/manifest/themeSupport'],
			['adapter.theme_support_failed', '/adapters/1/manifest/themeSupport'],
		])
		expect(result.themeSupport.diagnostics[0]!.message).toContain('no dark tokens')
		expect(result.summaries[1]!.unsupportedThemeIds).toEqual(['dark', 'sepia', 'async'])
	})

	it('makes an Adapter with a malformed themeSupport invalid on every surface', async () => {
		for (const themeSupport of [null, {}, { supports: 'light' }, () => true]) {
			const result = await resolveWorkspaceAdapterSet(fixtureInput([{ moduleSpecifier: 'bad' }], { bad: manifest('bad', { themeSupport }) }, ['light']))
			expect(result).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'adapter.invalid_theme_support', path: '/adapters/0/manifest/themeSupport' }] })
		}
	})
})

describe('render-context validation with the theme support of the current resolution', () => {
	const registries = {
		locales: new Set(['en-US']),
		viewports: { desktop: { width: 1280, height: 800 } },
		themes: new Set(['light', 'contrast']),
		themeIsCompatible: (themeId: string) => themeId !== 'contrast',
	}
	const context = (themeId: string): ResolvedRenderContext => ({ viewId: '11111111-1111-4111-8111-111111111111', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId })

	it('refuses a context whose theme the active Adapters do not support, and never another theme', () => {
		expect(validateRenderContextSelection([context('light')], registries).ok).toBe(true)
		const refused = validateRenderContextSelection([context('contrast')], registries)
		expect(refused).toMatchObject({ ok: false, diagnostics: [{ code: 'render_context.incompatible_theme', path: '/0/themeId' }] })
		// An unknown theme stays unknown: the support check applies to registry themes.
		expect(validateRenderContextSelection([context('neon')], registries)).toMatchObject({ ok: false, diagnostics: [{ code: 'render_context.unknown_theme' }] })
	})
})

/** A current-schema Workspace whose `kit/adapters/gate.mjs` Adapter rejects `contrast`. */
async function gateWorkspace(themes: Record<string, unknown>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-theme-support-'))
	temporaryRoots.push(root)
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters: [{ moduleSpecifier: './adapters/gate.mjs' }],
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } },
		themes,
	})
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await writeFile(join(root, 'kit', 'adapters', 'gate.mjs'), [
		'export const manifest = {',
		'  id: \'theme-gate\', apiVersion: \'1\', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [],',
		'  themeSupport: { supports: themeId => themeId !== \'contrast\' },',
		'}',
		'',
	].join('\n'))
	return root
}

describe('the selected Workspace\'s theme support', () => {
	it('asks about the themes of the Workspace registry, anew for each resolution', async () => {
		const root = await gateWorkspace({ light: { label: 'Light' }, contrast: { label: 'Contrast' } })
		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution).toMatchObject({
			state: 'valid',
			summaries: [{ adapterId: 'theme-gate', unsupportedThemeIds: ['contrast'] }],
			themeSupport: { themeIds: ['light', 'contrast'], unsupportedThemeIds: ['contrast'], diagnostics: [] },
		})
		expect(await selectedWorkspaceThemeSupport(root)).toMatchObject({ unsupportedThemeIds: ['contrast'] })

		await writeCurrentWorkspace(root, {
			i18n: { defaultLocale: 'en-US' },
			adapters: [{ moduleSpecifier: './adapters/gate.mjs' }],
			viewports: {},
			themes: { light: { label: 'Light' } },
		})
		expect(await selectedWorkspaceThemeSupport(root)).toEqual({ themeIds: ['light'], unsupportedThemeIds: [], diagnostics: [] })
	})

	it('reports no theme support while the Adapter set is invalid', async () => {
		const root = await gateWorkspace({ light: { label: 'Light' } })
		await writeFile(join(root, 'kit', 'adapters', 'gate.mjs'), 'export const manifest = { id: \'theme-gate\', apiVersion: \'1\', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [], themeSupport: {} }\n')
		expect(await selectedWorkspaceThemeSupport(root)).toBeUndefined()
	})
})

describe('formal capture of a theme the active Adapters do not support', () => {
	it('refuses that context with render_context.incompatible_theme before any browser runs, and stores nothing', async () => {
		const root = await gateWorkspace({ light: { label: 'Light' }, contrast: { label: 'Contrast' } })
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.locales.create('en-US', {})
		const formalCapture = createFormalCaptureService(persistence, { themeSupport: () => selectedWorkspaceThemeSupport(root) })
		const result = await formalCapture.capture({ contexts: [{ viewId: '11111111-1111-4111-8111-111111111111', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'contrast' }] })
		expect(result).toMatchObject({
			status: 'failed',
			summary: { total: 1, captured: 0, failed: 1 },
			results: [{ status: 'failed', diagnostics: [{ code: 'render_context.incompatible_theme', path: '/0/themeId' }] }],
		})
		expect(await persistence.artifacts.listIdentities()).toHaveLength(0)
	})
})
