import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'

import {
	resolveSelectedWorkspaceAdapters,
} from '../src/server/workspace-adapters'
import {
	buildWorkspacePreviewBundle,
	clearPreviewBundleCache,
} from '../src/server/preview-bundler'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import { HUMAN_OWNER } from './support/access'
import { writeManifest } from './support/workspace-layout'

const temporaryRoots: string[] = []

afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createTestWorkspace(adapters: Array<{ moduleSpecifier: string; config?: unknown }> = []): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-preview-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	await symlink(join(process.cwd(), 'node_modules', '@deviltea', 'widget-core'), join(root, 'node_modules', '@deviltea', 'widget-core')).catch(() => undefined)
	await symlink(join(process.cwd(), 'node_modules', '@deviltea', 'widget-vue'), join(root, 'node_modules', '@deviltea', 'widget-vue')).catch(() => undefined)
	await symlink(join(process.cwd(), 'node_modules', 'vue'), join(root, 'node_modules', 'vue')).catch(() => undefined)
	await writeManifest(root, JSON.stringify({
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		adapters,
		viewports: {},
		themes: {},
	}))
	return root
}

function makeCounterAdapterSource(): string {
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const counterPlugin = createWidgetPlugin('Counter')
  .interfaces()
  .state(s => s.count({ authorWritable: true, validate: (v) => typeof v === 'number', default: () => 42 }))
  .done();

export const CounterRenderer = defineComponent({
  name: 'CounterRenderer',
  setup() {
    const { useState } = useWidget(counterPlugin);
    const state = useState();
    return () => h('div', { class: 'real-counter' }, 'Value: ' + state.count.value);
  }
});

export const manifest = {
  id: 'my-counter',
  apiVersion: '1',
  widgetPlugins: [counterPlugin],
  catalog: { widgets: { Counter: {} } },
  renderers: [{ type: 'Counter', component: CounterRenderer }],
  providers: [],
  styles: [],
  tokens: [],
};
`
}

const VIEW_ID_1 = '11111111-1111-4111-8111-111111111111'
const VIEW_ID_2 = '22222222-2222-4222-8222-222222222222'

function viewWithCounter(): ViewResource {
	return {
		id: VIEW_ID_1,
		name: 'Counter View',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [{ id: 'c1', type: 'Counter' }],
			},
		} as never,
		variants: {},
		spec: {
			intent: 'Testing counter render',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
}

function emptyRootShellView(): ViewResource {
	return {
		id: VIEW_ID_2,
		name: 'Empty View',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [],
			},
		} as never,
		variants: {},
		spec: {
			intent: 'Testing empty rootshell',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
}

function defaultContext(viewId = VIEW_ID_1): ResolvedRenderContext {
	return {
		viewId,
		locale: 'en-US',
		viewportId: 'desktop',
		viewport: { width: 1280, height: 800 },
		themeId: 'light',
	}
}

function setupDom(): { window: Window; document: Document } {
	const win = new Window()
	globalThis.window = win as unknown as typeof globalThis.window
	globalThis.document = win.document as unknown as Document
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = win.Element as unknown as typeof Element
	globalThis.Node = win.Node as unknown as typeof Node
	globalThis.SVGElement = win.SVGElement as unknown as typeof SVGElement
	return { window: win, document: win.document as unknown as Document }
}

describe('preview adapter materialization transport', () => {
	it('proves valid workspace-relative adapter -> non-empty rendered runtime path available', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle.bundleJs).toBeTruthy()
		expect(bundle.hash).toBeTruthy()

		setupDom()
		const bundleFile = join(root, 'bundle.mjs')
		await writeFile(bundleFile, bundle.bundleJs)
		const bundleMod = await import(bundleFile)
		expect(typeof bundleMod.mountPreviewRuntime).toBe('function')

		const container = document.createElement('div')
		document.body.appendChild(container)

		let reportedStatus: unknown
		const bridge = bundleMod.mountPreviewRuntime(container, {
			view: viewWithCounter(),
			context: defaultContext(),
			onStatusChange(s: unknown) { reportedStatus = s },
		})

		expect(reportedStatus).toEqual({
			status: 'ready',
			supportedTypes: expect.arrayContaining(['RootShell', 'Counter']),
		})
		expect(container.innerHTML).toContain('class="real-counter"')
		expect(container.innerHTML).toContain('Value: 42')

		bridge.dispose()
		expect(container.innerHTML).toBe('')
	})

	it('proves valid package-relative (bare specifier) adapter resolution and mounting', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: 'pkg-counter' }])
		const packageDir = join(root, 'node_modules', 'pkg-counter')
		await mkdir(packageDir, { recursive: true })
		await writeFile(join(packageDir, 'package.json'), JSON.stringify({
			name: 'pkg-counter',
			version: '1.0.0',
			type: 'module',
			exports: { import: './index.mjs' },
			main: './index.mjs',
		}))
		await writeFile(join(packageDir, 'index.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		if (resolution.state === 'invalid') {
			console.error('pkg-counter diagnostics:', resolution.diagnostics)
		}
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle.bundleJs).toBeTruthy()

		setupDom()
		const bundleFile = join(root, 'bundle-pkg.mjs')
		await writeFile(bundleFile, bundle.bundleJs)
		const bundleMod = await import(bundleFile)

		const container = document.createElement('div')
		document.body.appendChild(container)

		let reportedStatus: unknown
		const bridge = bundleMod.mountPreviewRuntime(container, {
			view: viewWithCounter(),
			context: defaultContext(),
			onStatusChange(s: unknown) { reportedStatus = s },
		})

		expect(reportedStatus).toMatchObject({ status: 'ready' })
		expect(container.innerHTML).toContain('class="real-counter"')
		bridge.dispose()
	})

	it('fails closed when manifest is invalid or config schema is violated or adapter collision occurs', async () => {
		// 1. Invalid manifest (missing apiVersion)
		const rootInvalidManifest = await createTestWorkspace([{ moduleSpecifier: './adapters/invalid.mjs' }])
		await mkdir(join(rootInvalidManifest, 'adapters'), { recursive: true })
		await writeFile(join(rootInvalidManifest, 'adapters', 'invalid.mjs'), `
			export const manifest = { id: 'invalid-one' };
		`)
		const resInvalid = await resolveSelectedWorkspaceAdapters(rootInvalidManifest)
		expect(resInvalid.state).toBe('invalid')
		if (resInvalid.state === 'invalid') {
			expect(resInvalid.diagnostics.length).toBeGreaterThan(0)
		}

		// 2. Config schema violation
		const rootConfigViolation = await createTestWorkspace([{
			moduleSpecifier: './adapters/with-schema.mjs',
			config: { port: 'invalid-string-expected-number' },
		}])
		await mkdir(join(rootConfigViolation, 'adapters'), { recursive: true })
		await writeFile(join(rootConfigViolation, 'adapters', 'with-schema.mjs'), `
			export const manifest = {
				id: 'with-schema',
				apiVersion: '1',
				widgetPlugins: [],
				catalog: { widgets: {} },
				renderers: [],
				providers: [],
				styles: [],
				tokens: [],
				configSchema: {
					$schema: 'https://json-schema.org/draft/2020-12/schema',
					type: 'object',
					properties: { port: { type: 'number' } },
					required: ['port'],
				},
			};
		`)
		const resConfig = await resolveSelectedWorkspaceAdapters(rootConfigViolation)
		expect(resConfig.state).toBe('invalid')
		if (resConfig.state === 'invalid') {
			expect(resConfig.diagnostics.some(d => d.code === 'adapter.config_schema_violation')).toBe(true)
		}

		// 3. Collision (two adapters with same id or same widget type)
		const rootCollision = await createTestWorkspace([
			{ moduleSpecifier: './adapters/first.mjs' },
			{ moduleSpecifier: './adapters/second.mjs' },
		])
		await mkdir(join(rootCollision, 'adapters'), { recursive: true })
		await writeFile(join(rootCollision, 'adapters', 'first.mjs'), makeCounterAdapterSource())
		await writeFile(join(rootCollision, 'adapters', 'second.mjs'), makeCounterAdapterSource())

		const resCollision = await resolveSelectedWorkspaceAdapters(rootCollision)
		expect(resCollision.state).toBe('invalid')
		if (resCollision.state === 'invalid') {
			expect(resCollision.diagnostics.some(d => d.code === 'adapter.registry_collision')).toBe(true)
		}
	})

	it('fails closed when adapter module exports ambiguous manifests', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/ambiguous.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'ambiguous.mjs'), `
			export const manifestA = {
				id: 'adapter-a',
				apiVersion: '1',
				widgetPlugins: [],
				catalog: { widgets: {} },
				renderers: [],
				providers: [],
				styles: [],
				tokens: [],
			};
			export const manifestB = {
				id: 'adapter-b',
				apiVersion: '1',
				widgetPlugins: [],
				catalog: { widgets: {} },
				renderers: [],
				providers: [],
				styles: [],
				tokens: [],
			};
		`)

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('invalid')
		if (resolution.state === 'invalid') {
			expect(resolution.diagnostics.some(d => d.code === 'adapter.manifest_load_failed' && d.message.includes('Ambiguous'))).toBe(true)
		}
	})

	it('fails closed in the browser runtime when runtime ownership mismatch occurs', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/mismatch.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'mismatch.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		// Artificially tamper with the ownership in the validated set to simulate server/browser mismatch
		const tamperedSet = {
			...resolution.set,
			entries: [
				{
					...resolution.set.entries[0]!,
					ownership: {
						widgetTypes: ['DifferentWidget'],
						rendererKeys: ['DifferentWidget'],
					},
				},
			],
		}

		const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: tamperedSet as never })
		setupDom()
		const bundleFile = join(root, 'bundle-tampered.mjs')
		await writeFile(bundleFile, bundle.bundleJs)
		const bundleMod = await import(bundleFile)

		const container = document.createElement('div')
		document.body.appendChild(container)

		let reportedStatus: { status: string; diagnostics?: readonly { code: string }[] } | undefined
		bundleMod.mountPreviewRuntime(container, {
			view: viewWithCounter(),
			context: defaultContext(),
			onStatusChange(s: unknown) { reportedStatus = s as typeof reportedStatus },
		})

		expect(reportedStatus?.status).toBe('invalid')
		expect(reportedStatus?.diagnostics?.some(d => d.code === 'adapter.runtime_plugin_ownership_mismatch')).toBe(true)
	})

	it('renders RootShell when no adapters are configured, and reports adapter_unavailable for external widgets', async () => {
		const root = await createTestWorkspace([])

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		setupDom()
		const bundleFile = join(root, 'bundle-empty.mjs')
		await writeFile(bundleFile, bundle.bundleJs)
		const bundleMod = await import(bundleFile)

		const container = document.createElement('div')
		document.body.appendChild(container)

		// 1. Empty view renders RootShell successfully
		let emptyStatus: unknown
		const emptyBridge = bundleMod.mountPreviewRuntime(container, {
			view: emptyRootShellView(),
			context: defaultContext(VIEW_ID_2),
			onStatusChange(s: unknown) { emptyStatus = s },
		})
		expect(emptyStatus).toEqual({
			status: 'ready',
			supportedTypes: ['RootShell'],
		})
		emptyBridge.dispose()

		// 2. View requiring Counter reports adapter_unavailable with diagnostic
		let unavailableStatus: { status: string; unsupportedTypes?: readonly string[]; diagnostics?: readonly { code: string }[] } | undefined
		const unavailableBridge = bundleMod.mountPreviewRuntime(container, {
			view: viewWithCounter(),
			context: defaultContext(),
			onStatusChange(s: unknown) { unavailableStatus = s as typeof unavailableStatus },
		})
		expect(unavailableStatus?.status).toBe('adapter_unavailable')
		expect(unavailableStatus?.unsupportedTypes).toEqual(['Counter'])
		expect(unavailableStatus?.diagnostics?.some(d => d.code === 'adapter.materialization_unavailable')).toBe(true)
		unavailableBridge.dispose()
	})

	it('ensures adapter module changes on disk are not incorrectly masked by cache', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		if (resolution.state !== 'valid') throw new Error('Expected valid resolution')

		const bundle1 = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle1.bundleJs).toContain('Value: ')

		// Repeated build without disk change hits cache (returns same hash)
		const bundleCached = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundleCached.hash).toBe(bundle1.hash)

		// Modify adapter file on disk
		const modifiedSource = makeCounterAdapterSource().replace('Value: ', 'CountIs: ')
		await writeFile(join(root, 'adapters', 'counter.mjs'), modifiedSource)

		// Build again: must detect modified file and return updated bundle with new hash
		const bundle2 = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle2.hash).not.toBe(bundle1.hash)
		expect(bundle2.bundleJs).toContain('CountIs: ')
	})

	it('serves preview adapters plan and runtime bundle through internal Nitro routes', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const prevEnv = process.env.UIUX_WORKSPACE_ROOT
		process.env.UIUX_WORKSPACE_ROOT = root
		try {
			const { default: adaptersHandler } = await import('../server/api/preview/adapters.get')
			const { default: runtimeHandler } = await import('../server/api/preview/runtime.get')

			// Routes read the principal the access guard attached (identity decision 4).
			const mockEvent = { context: { uiuxPrincipal: HUMAN_OWNER }, node: { res: { setHeader() {} } } } as never
			const adaptersResp = await adaptersHandler(mockEvent)
			expect(adaptersResp).toMatchObject({
				state: 'valid',
				diagnostics: [],
			})
			expect(adaptersResp).toMatchObject({ bundleUrl: expect.stringContaining('/api/preview/runtime?v=') })

			const runtimeJs = await runtimeHandler(mockEvent)
			expect(typeof runtimeJs).toBe('string')
			expect(runtimeJs).toContain('mountPreviewRuntime')
			expect(runtimeJs).toContain('my-counter')
		}
		finally {
			if (prevEnv !== undefined) process.env.UIUX_WORKSPACE_ROOT = prevEnv
			else delete process.env.UIUX_WORKSPACE_ROOT
			const { closeSelectedWorkspaceServerRuntime } = await import('../src/server/selected-workspace')
			await closeSelectedWorkspaceServerRuntime()
		}
	})

	it('fails closed deterministically when an adapter source file cannot be read', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		// Remove the adapter file so it becomes unreadable
		await rm(join(root, 'adapters', 'counter.mjs'))

		// computeBundleContentHash must throw structured error instead of Date.now() fallback
		await expect(buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set }))
			.rejects
			.toThrow(/Failed to read adapter source file at/)
	})

	it('renders translated fields and updates visible output dynamically when locale changes', async () => {
		const greetingAdapterSource = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const greetingPlugin = createWidgetPlugin('Greeting')
  .interfaces()
  .properties(p => p.label({
    valueContract: {
      type: 'string',
      validate: (v) => typeof v === 'string',
      serialize: (v) => v,
      deserialize: (v) => ({ ok: true, value: v }),
    },
    registerDeps: ({ dep }) => ({
      t: dep.root.methods.invoke('t').validate((v) => typeof v === 'object' && v !== null && 'text' in v),
    }),
    compute: ({ deps }) => {
      const res = deps.t('welcome');
      const missing = deps.t('untranslated_key');
      const resText = res.ok && res.value ? res.value.text : 'none';
      const missingText = missing.ok && missing.value ? missing.value.text : 'none';
      return resText + '|' + missingText;
    },
  }))
  .done();

export const GreetingRenderer = defineComponent({
  name: 'GreetingRenderer',
  setup() {
    const { useProperties } = useWidget(greetingPlugin);
    const properties = useProperties();
    return () => h('div', { class: 'greeting-container', id: 'greeting-text' }, properties.label.value);
  }
});

export const manifest = {
  id: 'my-greeting',
  apiVersion: '1',
  widgetPlugins: [greetingPlugin],
  catalog: { widgets: { Greeting: {} } },
  renderers: [{ type: 'Greeting', component: GreetingRenderer }],
  providers: [],
  styles: [],
  tokens: [],
};
`
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/greeting.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'greeting.mjs'), greetingAdapterSource)

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		setupDom()
		const bundleFile = join(root, 'bundle-greeting.mjs')
		await writeFile(bundleFile, bundle.bundleJs)
		const bundleMod = await import(bundleFile)

		const container = document.createElement('div')
		document.body.appendChild(container)

		const view: ViewResource = {
			id: VIEW_ID_1,
			name: 'Greeting View',
			ir: {
				type: 'RootShell',
				id: 'root',
				slots: {
					content: [{ id: 'g1', type: 'Greeting' }],
				},
			} as never,
			variants: {},
			spec: {
				intent: 'Testing greeting locale',
				entryConditions: [],
				interactionRules: [],
				constraints: [],
				accessibility: [],
				references: [],
				decisions: [],
			},
		}

		const locales = new Map([
			['en-US', { welcome: 'Hello World' }],
			['zh-TW', { welcome: '你好世界' }],
		])

		const bridge = bundleMod.mountPreviewRuntime(container, {
			view,
			context: { ...defaultContext(), locale: 'en-US' },
			locales,
		})

		expect(container.querySelector('#greeting-text')?.textContent).toBe('Hello World|⟦missing:untranslated_key⟧')

		// Switch locale to zh-TW
		bridge.updateContext({ ...defaultContext(), locale: 'zh-TW' })
		await new Promise(r => setTimeout(r, 50))
		expect(container.querySelector('#greeting-text')?.textContent).toBe('你好世界|⟦missing:untranslated_key⟧')

		// Switch to an unknown locale: falls back to default locale en-US for welcome, missing for untranslated_key
		bridge.updateContext({ ...defaultContext(), locale: 'fr-FR' })
		await new Promise(r => setTimeout(r, 50))
		expect(container.querySelector('#greeting-text')?.textContent).toBe('Hello World|⟦missing:untranslated_key⟧')

		// Dynamically provide fr-FR locale
		bridge.updateLocales?.(new Map([
			...locales,
			['fr-FR', { welcome: 'Bonjour le monde' }],
		]))
		await new Promise(r => setTimeout(r, 50))
		expect(container.querySelector('#greeting-text')?.textContent).toBe('Bonjour le monde|⟦missing:untranslated_key⟧')

		bridge.dispose()
	})
})
