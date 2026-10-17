import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import { resolve as resolveImport } from 'import-meta-resolve'

import {
	getSelectedWorkspacePreviewBundle,
	resolveSelectedWorkspaceAdapters,
} from '../src/server/workspace-adapters'
import { emptyProductKit } from '../src/domain/product-kit/schema'
import { V5_LAYOUT } from '../src/persistence/paths'
import {
	buildWorkspacePreviewBundle,
	clearPreviewBundleCache,
} from '../src/server/preview-bundler'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { HUMAN_OWNER } from './support/access'
import { currentManifest, writeCurrentWorkspace } from './support/workspace-layout'

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
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters,
		viewports: {},
		themes: {},
	})
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
		// From schemaVersion 5 a bare Adapter resolves from the kit project, kit/node_modules/.
		const packageDir = join(root, 'kit', 'node_modules', 'pkg-counter')
		await mkdir(packageDir, { recursive: true })
		await writeFile(join(packageDir, 'package.json'), JSON.stringify({
			name: 'pkg-counter',
			version: '1.0.0',
			type: 'module',
			exports: { import: './index.mjs' },
			main: './index.mjs',
		}))
		await writeFile(join(packageDir, 'index.mjs'), makeCounterAdapterSource())
		// From schemaVersion 5 a bare Adapter is a dependency the kit project declares.
		await mkdir(join(root, 'kit'), { recursive: true })
		await writeFile(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { 'pkg-counter': '1.0.0' } }))

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
		await mkdir(join(rootInvalidManifest, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(rootInvalidManifest, 'kit', 'adapters', 'invalid.mjs'), `
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
		await mkdir(join(rootConfigViolation, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(rootConfigViolation, 'kit', 'adapters', 'with-schema.mjs'), `
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
		await mkdir(join(rootCollision, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(rootCollision, 'kit', 'adapters', 'first.mjs'), makeCounterAdapterSource())
		await writeFile(join(rootCollision, 'kit', 'adapters', 'second.mjs'), makeCounterAdapterSource())

		const resCollision = await resolveSelectedWorkspaceAdapters(rootCollision)
		expect(resCollision.state).toBe('invalid')
		if (resCollision.state === 'invalid') {
			expect(resCollision.diagnostics.some(d => d.code === 'adapter.registry_collision')).toBe(true)
		}
	})

	it('fails closed when adapter module exports ambiguous manifests', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/ambiguous.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'ambiguous.mjs'), `
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'mismatch.mjs'), makeCounterAdapterSource())

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		if (resolution.state !== 'valid') throw new Error('Expected valid resolution')

		const bundle1 = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle1.bundleJs).toContain('Value: ')

		// Repeated build without disk change hits cache (returns same hash)
		const bundleCached = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundleCached.hash).toBe(bundle1.hash)

		// Modify adapter file on disk
		const modifiedSource = makeCounterAdapterSource().replace('Value: ', 'CountIs: ')
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), modifiedSource)

		// Build again: must detect modified file and return updated bundle with new hash
		const bundle2 = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
		expect(bundle2.hash).not.toBe(bundle1.hash)
		expect(bundle2.bundleJs).toContain('CountIs: ')
	})

	it('serves preview adapters plan and runtime bundle through internal Nitro routes', async () => {
		const root = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const prevEnv = process.env.UIUX_WORKSPACE_ROOT
		process.env.UIUX_WORKSPACE_ROOT = root
		try {
			const { default: adaptersHandler } = await import('../server/api/preview/adapters.get')
			const { default: runtimeHandler } = await import('../server/api/preview/runtime/[hash]/[...file].get')

			// Routes read the principal the access guard attached (identity decision 4).
			const headers: Record<string, unknown> = {}
			const mockEvent = (params: Record<string, string> = {}) => ({
				context: { uiuxPrincipal: HUMAN_OWNER, params },
				node: { res: { setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value }, getHeader(name: string) { return headers[name.toLowerCase()] } } },
			}) as never
			const adaptersResp = await adaptersHandler(mockEvent()) as { bundleUrl: string; stylesheetUrl?: string; themes: unknown }
			expect(adaptersResp).toMatchObject({
				state: 'valid',
				diagnostics: [],
				themes: {},
			})
			// The bundle's files are served by content hash; a bundle without CSS has no stylesheet.
			const match = /^\/api\/preview\/runtime\/([0-9a-f]{16})\/runtime\.js$/.exec(adaptersResp.bundleUrl)
			expect(match).not.toBeNull()
			expect(adaptersResp.stylesheetUrl).toBeUndefined()

			const runtimeJs = await runtimeHandler(mockEvent({ hash: match![1]!, file: 'runtime.js' })) as Buffer
			expect(Buffer.isBuffer(runtimeJs)).toBe(true)
			expect(headers['content-type']).toBe('text/javascript; charset=utf-8')
			expect(runtimeJs.toString('utf8')).toContain('mountPreviewRuntime')
			expect(runtimeJs.toString('utf8')).toContain('my-counter')
			// A served bundle carries its source map (Rule 01a11bb1-ae8c-721f-b1e4-f6936ffe5d5a).
			expect(runtimeJs.toString('utf8')).toContain(`//# sourceMappingURL=/api/preview/runtime/${match![1]}/runtime.js.map`)
			const map = JSON.parse((await runtimeHandler(mockEvent({ hash: match![1]!, file: 'runtime.js.map' })) as Buffer).toString('utf8')) as { sources: string[] }
			expect(map.sources).toContain('workspace:///kit/adapters/counter.mjs')
			expect(map.sources.every(source => !source.includes(root))).toBe(true)

			// A hash that is not the current bundle's names nothing.
			expect(await runtimeHandler(mockEvent({ hash: '0000000000000000', file: 'runtime.js' }))).toEqual({ error: 'preview_runtime_file_not_found' })
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('valid')
		if (resolution.state !== 'valid') return

		// Remove the adapter file so it becomes unreadable
		await rm(join(root, 'kit', 'adapters', 'counter.mjs'))

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'greeting.mjs'), greetingAdapterSource)

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

describe('a current-schema Workspace resolves its Adapters from the Product Kit', () => {
	const HOST_PACKAGES = [['@deviltea', 'widget-core'], ['@deviltea', 'widget-vue'], ['vue']] as const

	/** Links the host's widget-core, widget-vue and vue into `<directory>/node_modules`, as a kit install would provide them. */
	async function linkHostPackages(directory: string): Promise<void> {
		for (const segments of HOST_PACKAGES) {
			const target = join(directory, 'node_modules', ...segments)
			await mkdir(dirname(target), { recursive: true })
			await symlink(join(process.cwd(), 'node_modules', ...segments), target)
		}
	}

	/** A current-schema Workspace at `<root>`: `workspace.json`, `product-kit.json` with `adapters`, and `kit/` (Clause 01a1144e-538e). */
	async function createKitWorkspace(root: string, adapters: Array<{ moduleSpecifier: string }>, kitPackage?: unknown): Promise<string> {
		await mkdir(join(root, 'kit'), { recursive: true })
		await writeFile(join(root, 'workspace.json'), JSON.stringify(currentManifest()))
		await writeFile(join(root, 'product-kit.json'), JSON.stringify({ ...emptyProductKit(), adapters }))
		if (kitPackage !== undefined) await writeFile(join(root, 'kit', 'package.json'), JSON.stringify(kitPackage))
		return root
	}

	async function temporaryRoot(): Promise<string> {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-preview-v5-')))
		temporaryRoots.push(root)
		return root
	}

	async function mountCounter(root: string, bundleJs: string): Promise<string> {
		setupDom()
		const bundleFile = join(root, `bundle-${randomUUID()}.mjs`)
		await writeFile(bundleFile, bundleJs)
		const bundleMod = await import(bundleFile)
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundleMod.mountPreviewRuntime(container, { view: viewWithCounter(), context: defaultContext() })
		const html = container.innerHTML
		bridge.dispose()
		return html
	}

	it('renders a plain-module Adapter in kit/ with no build, no registry and no kit package file (the minimal form)', async () => {
		const root = await createKitWorkspace(await temporaryRoot(), [{ moduleSpecifier: './adapter.mjs' }])
		await linkHostPackages(join(root, 'kit'))
		await writeFile(join(root, 'kit', 'adapter.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution).toMatchObject({ state: 'valid', summaries: [{ index: 0, moduleSpecifier: './adapter.mjs', adapterId: 'my-counter' }] })
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle.state).toBe('valid')
		if (bundle.state !== 'valid') return
		expect(await mountCounter(root, bundle.bundleJs)).toContain('Value: 42')
	})

	it('reports an Adapter outside kit/ or an undeclared package as a resolution diagnostic of the Product Kit list', async () => {
		const root = await createKitWorkspace(await temporaryRoot(), [
			{ moduleSpecifier: './../views/counter.mjs' },
			{ moduleSpecifier: 'undeclared-counter' },
		], { private: true, dependencies: {} })
		await mkdir(join(root, 'views'), { recursive: true })
		await writeFile(join(root, 'views', 'counter.mjs'), makeCounterAdapterSource())
		const undeclared = join(root, 'kit', 'node_modules', 'undeclared-counter')
		await mkdir(undeclared, { recursive: true })
		await writeFile(join(undeclared, 'package.json'), JSON.stringify({ name: 'undeclared-counter', type: 'module', main: './index.mjs' }))
		await writeFile(join(undeclared, 'index.mjs'), makeCounterAdapterSource())

		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.state).toBe('invalid')
		expect(resolution.diagnostics).toEqual([
			expect.objectContaining({ code: 'adapter.resolution_failed', path: '/adapters/0/moduleSpecifier', message: expect.stringMatching(/escapes kit\//) }),
			expect.objectContaining({ code: 'adapter.resolution_failed', path: '/adapters/1/moduleSpecifier', message: expect.stringMatching(/does not declare/) }),
		])
	})

	it('fails closed when the Product Kit file or the manifest is missing or invalid', async () => {
		const root = await createKitWorkspace(await temporaryRoot(), [])
		expect(await resolveSelectedWorkspaceAdapters(root)).toMatchObject({ state: 'valid', summaries: [] })
		for (const content of [undefined, '{', JSON.stringify({ adapters: [] })]) {
			if (content === undefined) await rm(join(root, 'product-kit.json'))
			else await writeFile(join(root, 'product-kit.json'), content)
			const resolution = await resolveSelectedWorkspaceAdapters(root)
			expect(resolution, String(content)).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'product_kit.missing', path: '/product-kit' }] })
		}
		// A current manifest that still lists adapters is invalid (Clause 01a115cd-adb0): its Adapters are not read from it.
		await writeFile(join(root, 'product-kit.json'), JSON.stringify(emptyProductKit()))
		await writeFile(join(root, 'workspace.json'), JSON.stringify({ ...currentManifest(), adapters: [] }))
		expect(await resolveSelectedWorkspaceAdapters(root)).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'workspace.manifest_missing' }] })
	})

	it('bundles the host widget-core even when kit/node_modules holds a second copy (#123)', async () => {
		const root = await createKitWorkspace(await temporaryRoot(), [{ moduleSpecifier: './adapter.mjs' }])
		await linkHostPackages(join(root, 'kit'))
		// Replace the linked widget-core with a second copy: it re-exports the host copy (so the
		// server-side manifest load still works) and carries a marker that a bundled copy would include.
		const secondCopy = join(root, 'kit', 'node_modules', '@deviltea', 'widget-core')
		await rm(secondCopy)
		await mkdir(secondCopy, { recursive: true })
		const hostCore = resolveImport('@deviltea/widget-core', pathToFileURL(join(process.cwd(), 'package.json')).href)
		await writeFile(join(secondCopy, 'package.json'), JSON.stringify({ name: '@deviltea/widget-core', version: '0.0.0-kit', type: 'module', exports: { '.': './index.mjs' } }))
		await writeFile(join(secondCopy, 'index.mjs'), `export * from ${JSON.stringify(hostCore)};\nglobalThis.__kitSecondCopy = 'kit-second-widget-core-copy';\n`)
		await writeFile(join(root, 'kit', 'adapter.mjs'), makeCounterAdapterSource())

		const bundle = await getSelectedWorkspacePreviewBundle(root)
		expect(bundle.state).toBe('valid')
		if (bundle.state !== 'valid') return
		expect(bundle.bundleJs).not.toContain('kit-second-widget-core-copy')
		expect(await mountCounter(root, bundle.bundleJs)).toContain('Value: 42')
	})

	it('falls back to kit/node_modules, never the root node_modules, for a bare import of an Adapter outside kit/', async () => {
		const outer = await temporaryRoot()
		await linkHostPackages(outer)
		const root = await createKitWorkspace(join(outer, 'ws'), [{ moduleSpecifier: 'hoisted-counter' }], { dependencies: { 'hoisted-counter': '*' } })
		const hoisted = join(outer, 'node_modules', 'hoisted-counter')
		await mkdir(hoisted, { recursive: true })
		await writeFile(join(hoisted, 'package.json'), JSON.stringify({ name: 'hoisted-counter', type: 'module', main: './index.mjs' }))
		// The probe import is dynamic and never runs on the server; only the bundler resolves it.
		await writeFile(join(hoisted, 'index.mjs'), `${makeCounterAdapterSource()}\nif (globalThis.__neverSet) import('fallback-probe');\n`)
		for (const [directory, marker] of [[join(root, 'kit'), 'probe-from-kit'], [root, 'probe-from-root']] as const) {
			const probe = join(directory, 'node_modules', 'fallback-probe')
			await mkdir(probe, { recursive: true })
			await writeFile(join(probe, 'package.json'), JSON.stringify({ name: 'fallback-probe', type: 'module', main: './index.mjs' }))
			await writeFile(join(probe, 'index.mjs'), `export const probe = ${JSON.stringify(marker)};\n`)
		}

		const bundle = await getSelectedWorkspacePreviewBundle(root)
		expect(bundle.state).toBe('valid')
		if (bundle.state !== 'valid') return
		expect(bundle.bundleJs).toContain('probe-from-kit')
		expect(bundle.bundleJs).not.toContain('probe-from-root')
	})
})
