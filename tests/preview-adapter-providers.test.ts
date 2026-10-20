import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'

import { getSelectedWorkspacePreviewBundle, resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { clearPreviewBundleCache, previewRuntimeFileUrl } from '../src/server/preview-bundler'
import { readPreviewRuntimeFile } from '../src/server/preview-runtime-http'
import type { PreviewRuntimeBridge, PreviewRuntimeMountOptions, PreviewRuntimeStatus } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * Adapter providers and configuration delivery (issues #126 and #127, Discussion #130 decisions 2, 4
 * and 5): a construction installs every provider, a Vue plugin, in Adapter-list order and then entry
 * order before its first render (Clause 01a11a5a-4309-7ad5-8279-e1f60045017f, Rules
 * 01a11a5a-4d38-7f2c-98be-755d8c404d98 and 01a115cd-ae6b-7a85-be8e-0a42517daf17), passing the frozen
 * `{ adapterId, config }` with the deep-frozen validated configuration (Rule
 * 01a11a5a-515e-7c1d-9990-82e883c33243) that renderers reach only through their provider (Rule
 * 01a11a5a-51dc-743c-993c-d4b3079beec7). A throwing or asynchronous provider fails the construction
 * (Rules 01a11a5a-4ecd-7edb-a9e2-5918f01880e7 and 01a11a5a-5059-716e-b0a5-d178395be034), a malformed
 * entry makes the Adapter invalid on the server (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a), and the
 * configuration is embedded in the bundle, whose hash covers it (Rules
 * 01a11a5a-52dd-7cb5-b12e-cef45b262a76 and 01a11a5a-535f-73f2-96d0-6ccb02910f0b).
 */

const temporaryRoots: string[] = []
const servers: Server[] = []

type ProviderLogEntry = Readonly<{ name: string; context?: unknown; self?: boolean; rendered?: boolean }>
type ProviderLogHost = { __uiuxProviderLog?: ProviderLogEntry[] }

function providerLog(): ProviderLogEntry[] {
	const host = globalThis as ProviderLogHost
	host.__uiuxProviderLog ??= []
	return host.__uiuxProviderLog
}

afterEach(async () => {
	clearPreviewBundleCache()
	providerLog().length = 0
	await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const CONFIG_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		tone: { type: 'string' },
		text: { type: 'string' },
		nested: { type: 'object', properties: { levels: { type: 'array', items: { type: 'number' } } } },
	},
	additionalProperties: false,
}

/**
 * The first Adapter: a configuration schema, a provider object that hands its configuration to the
 * renderer through `provide`/`inject`, and a function provider with a global side effect it undoes
 * through `app.onUnmount`. Each provider records what it was installed with.
 */
const FIRST_ADAPTER = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h, inject } from 'vue';
import './first.css';

const log = () => (globalThis.__uiuxProviderLog ??= []);
const CONFIG_KEY = Symbol('first-kit-config');

export const labelPlugin = createWidgetPlugin('KitLabel').interfaces().done();

export const KitLabelRenderer = defineComponent({
  name: 'KitLabelRenderer',
  setup() {
    const config = inject(CONFIG_KEY, undefined);
    return () => h('span', { class: 'kit-label', 'data-tone': config?.tone ?? 'none' }, config?.text ?? 'no config');
  },
});

const configProvider = {
  install(app, context) {
    log().push({ name: 'first.config', context, self: this === configProvider, rendered: document.querySelector('.kit-label') !== null });
    app.provide(CONFIG_KEY, context.config);
  },
};

function sideEffectProvider(app, context) {
  log().push({ name: 'first.side-effect', context });
  document.body.setAttribute('data-first-kit', 'installed');
  app.onUnmount(() => {
    document.body.removeAttribute('data-first-kit');
    log().push({ name: 'first.cleanup' });
  });
}

export const manifest = {
  id: 'first-kit',
  apiVersion: '1.1',
  widgetPlugins: [labelPlugin],
  catalog: { widgets: { KitLabel: {} } },
  renderers: [{ type: 'KitLabel', component: KitLabelRenderer }],
  providers: [configProvider, sideEffectProvider],
  configSchema: ${JSON.stringify(CONFIG_SCHEMA)},
};
`

type SecondProvider = 'ok' | 'throws' | 'async' | 'malformed'

/** The second Adapter: no configuration schema, and one provider whose behavior the test picks. */
function secondAdapter(provider: SecondProvider): string {
	const install = {
		ok: `log().push({ name: 'second.ok', context });`,
		throws: `log().push({ name: 'second.throws', context }); throw new Error('second-kit cannot start');`,
		async: `log().push({ name: 'second.async', context }); return Promise.resolve();`,
		malformed: '',
	}[provider]
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';

const log = () => (globalThis.__uiuxProviderLog ??= []);

export const badgePlugin = createWidgetPlugin('KitBadge').interfaces().done();

export const KitBadgeRenderer = defineComponent({
  name: 'KitBadgeRenderer',
  setup() {
    return () => h('b', { class: 'kit-badge' }, 'Badge');
  },
});

export const manifest = {
  id: 'second-kit',
  apiVersion: '1.1',
  widgetPlugins: [badgePlugin],
  catalog: { widgets: { KitBadge: {} } },
  renderers: [{ type: 'KitBadge', component: KitBadgeRenderer }],
  providers: [${provider === 'malformed' ? `{ name: 'not a plugin' }` : `{ install(app, context) { ${install} } }`}],
};
`
}

type WorkspaceOptions = Readonly<{ config?: unknown; second?: SecondProvider }>

/** A current-schema Workspace whose kit has the two Adapters, the first with `config` when given. */
async function createProviderWorkspace(options: WorkspaceOptions = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-adapter-providers-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name))
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters: [
			{ moduleSpecifier: './adapters/first.mjs', ...(options.config === undefined ? {} : { config: options.config }) },
			{ moduleSpecifier: './adapters/second.mjs' },
		],
		viewports: {},
		themes: {},
	})
	const kit = join(root, 'kit')
	await mkdir(join(kit, 'adapters'), { recursive: true })
	await writeFile(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module' }))
	await writeFile(join(kit, 'adapters', 'first.mjs'), FIRST_ADAPTER)
	await writeFile(join(kit, 'adapters', 'first.css'), '.kit-label { color: rgb(1, 2, 3); }\n')
	await writeFile(join(kit, 'adapters', 'second.mjs'), secondAdapter(options.second ?? 'ok'))
	return root
}

/** Sets the first Adapter entry's `config` in the Product Kit file. */
async function setFirstConfig(root: string, config: unknown): Promise<void> {
	const path = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(path, 'utf8')) as { adapters: Array<Record<string, unknown>> }
	productKit.adapters[0] = { ...productKit.adapters[0], config }
	await writeFile(path, `${JSON.stringify(productKit, null, 2)}\n`)
}

/** Serves the selected Workspace's Preview bundle files the way the runtime route does, on a loopback port. */
async function serveRuntime(root: string): Promise<string> {
	const server = createServer((request, response) => {
		const match = /^\/api\/preview\/runtime\/([^/]+)\/(.+)$/.exec(request.url ?? '')
		void (async () => {
			const result = match ? await readPreviewRuntimeFile(root, undefined, match[1]!, decodeURIComponent(match[2]!)) : undefined
			if (!result || result.status !== 200) {
				response.writeHead(result?.status ?? 404, { 'content-type': 'application/json' })
				response.end(JSON.stringify(result?.body ?? {}))
				return
			}
			response.writeHead(200, result.headers)
			response.end(Buffer.from(result.file.contents))
		})()
	})
	servers.push(server)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('no port')
	return `http://127.0.0.1:${address.port}`
}

const VIEW_ID = '44444444-4444-4444-8444-444444444444'

function kitView(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Kit Providers View',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'l1', type: 'KitLabel' }, { id: 'b1', type: 'KitBadge' }] } } as never,
		variants: { Other: { state: {} } } as never,
		spec: { intent: 'Kit providers', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function context(overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext {
	return { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light', ...overrides }
}

type BundleModule = Readonly<{ mountPreviewRuntime: (container: HTMLElement, options: PreviewRuntimeMountOptions) => PreviewRuntimeBridge }>

/** A Preview document at `origin` with the bundle's module imported into it. */
async function previewDocument(root: string, origin: string, bundleJs: string) {
	const window = new Window({ url: `${origin}/preview` })
	globalThis.window = window as unknown as typeof globalThis.window
	globalThis.document = window.document as unknown as Document
	globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = window.Element as unknown as typeof Element
	globalThis.Node = window.Node as unknown as typeof Node
	globalThis.SVGElement = window.SVGElement as unknown as typeof SVGElement
	const file = join(root, `bundle-${randomUUID()}.mjs`)
	await writeFile(file, bundleJs)
	const module = await import(file) as BundleModule & Record<string, unknown>
	const container = window.document.createElement('div') as unknown as HTMLElement
	window.document.body.append(container as never)
	return { window, document: window.document as unknown as Document, container, mount: module.mountPreviewRuntime, module }
}

async function until(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`)
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

async function validBundle(root: string) {
	const bundle = await getSelectedWorkspacePreviewBundle(root)
	if (bundle.state !== 'valid') throw new Error(`Expected a valid bundle: ${JSON.stringify(bundle.diagnostics)}`)
	return bundle
}

function isDeepFrozen(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return true
	return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

const CONFIG = { tone: 'warm', text: 'Configured', nested: { levels: [1, 2] } }

describe('Adapter providers in a Preview Runtime construction', () => {
	it('installs every provider in Adapter-list order, then entry order, once the stylesheet has loaded and before the first render', async () => {
		const root = await createProviderWorkspace({ config: CONFIG })
		const bundle = await validBundle(root)
		// Providers run only in the Preview document: resolving and checking the set on the server ran none.
		expect(providerLog()).toEqual([])
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, {
			view: kitView(),
			context: context(),
			stylesheetHref: `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`,
			onStatusChange: status => statuses.push(status),
		})
		// The stylesheet is linked first; no provider is installed while it loads.
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).not.toBeNull()
		expect(providerLog()).toEqual([])

		await until(() => statuses.length > 0, 'the first render')
		expect(statuses).toEqual([expect.objectContaining({ status: 'ready' })])
		expect(providerLog().map(entry => entry.name)).toEqual(['first.config', 'first.side-effect', 'second.ok'])
		const [config, sideEffect, second] = providerLog()
		// An object provider's install is called with the provider as `this`, before anything rendered.
		expect(config).toMatchObject({ self: true, rendered: false })
		// The install context: frozen `{ adapterId, config }`, with a deep-frozen copy of the validated value.
		expect(config!.context).toEqual({ adapterId: 'first-kit', config: CONFIG })
		expect(Object.keys(config!.context as object).sort()).toEqual(['adapterId', 'config'])
		expect(isDeepFrozen(config!.context)).toBe(true)
		// The Adapter's providers share its context; another Adapter's has its own ID and no configuration.
		expect(sideEffect!.context).toBe(config!.context)
		expect(second!.context).toEqual({ adapterId: 'second-kit', config: undefined })
		expect(Object.hasOwn(second!.context as object, 'config')).toBe(true)
		expect(Object.isFrozen(second!.context)).toBe(true)

		// The renderer reaches the configuration only through its Adapter's provider (provide/inject).
		const label = container.querySelector('.kit-label')!
		expect(label.getAttribute('data-tone')).toBe('warm')
		expect(label.textContent).toBe('Configured')
		expect(document.body.getAttribute('data-first-kit')).toBe('installed')

		// A Variant switch and a live Locale or viewport change happen inside the construction and reinstall nothing.
		bridge.updateContext(context({ variantName: 'Other' }))
		bridge.updateContext(context({ variantName: 'Other', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 } }))
		bridge.updateView(kitView())
		expect(providerLog().map(entry => entry.name)).toEqual(['first.config', 'first.side-effect', 'second.ok'])

		// Disposing discards the app, and a provider's global side effect goes through `app.onUnmount`.
		bridge.dispose()
		expect(providerLog().map(entry => entry.name)).toEqual(['first.config', 'first.side-effect', 'second.ok', 'first.cleanup'])
		expect(document.body.hasAttribute('data-first-kit')).toBe(false)
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).toBeNull()
		expect(container.innerHTML).toBe('')
	})

	it('gives each construction its own deep-frozen copy of the configuration', async () => {
		const root = await createProviderWorkspace({ config: CONFIG })
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		const first = mount(container, { view: kitView(), context: context() })
		first.dispose()
		const second = mount(container, { view: kitView(), context: context() })
		const configs = providerLog().filter(entry => entry.name === 'first.config').map(entry => (entry.context as { config: unknown }).config)
		expect(configs).toHaveLength(2)
		expect(configs[0]).toEqual(configs[1])
		expect(configs[0]).not.toBe(configs[1])
		expect(() => (configs[1] as { nested: { levels: number[] } }).nested.levels.push(3)).toThrow(TypeError)
		second.dispose()
	})

	it('renders differently for two configuration values, each in its own bundle (Scenario 01a11a5b-183f-79b7-944c-eb7ab182cee0)', async () => {
		const root = await createProviderWorkspace({ config: CONFIG })
		const before = await validBundle(root)
		// The configuration is embedded in the bundle: anyone who can load it can read it.
		expect(before.bundleJs).toContain('Configured')

		await setFirstConfig(root, { tone: 'cool', text: 'Reconfigured' })
		const after = await validBundle(root)
		expect(after.hash).not.toBe(before.hash)
		expect(after.bundleJs).toContain('Reconfigured')
		expect(after.bundleJs).not.toContain('"Configured"')

		const origin = await serveRuntime(root)
		const rendered: Array<{ tone: string | null; text: string | null }> = []
		for (const bundle of [before, after]) {
			const { container, mount } = await previewDocument(root, origin, bundle.bundleJs)
			const bridge = mount(container, { view: kitView(), context: context() })
			const label = container.querySelector('.kit-label')!
			rendered.push({ tone: label.getAttribute('data-tone'), text: label.textContent })
			bridge.dispose()
		}
		expect(rendered).toEqual([{ tone: 'warm', text: 'Configured' }, { tone: 'cool', text: 'Reconfigured' }])
		const contexts = providerLog().filter(entry => entry.name === 'first.config').map(entry => entry.context)
		expect(contexts).toEqual([{ adapterId: 'first-kit', config: CONFIG }, { adapterId: 'first-kit', config: { tone: 'cool', text: 'Reconfigured' } }])
		expect(contexts.every(isDeepFrozen)).toBe(true)
	})

	it('builds the same bundle for an unchanged configuration, and one without the configuration when the entry has none', async () => {
		const root = await createProviderWorkspace({ config: CONFIG })
		const configured = await validBundle(root)
		expect((await validBundle(root)).hash).toBe(configured.hash)

		const path = join(root, 'product-kit.json')
		const productKit = JSON.parse(await readFile(path, 'utf8')) as { adapters: Array<Record<string, unknown>> }
		delete productKit.adapters[0]!.config
		await writeFile(path, `${JSON.stringify(productKit, null, 2)}\n`)
		const unconfigured = await validBundle(root)
		expect(unconfigured.hash).not.toBe(configured.hash)
		expect(unconfigured.bundleJs).not.toContain('Configured')

		const origin = await serveRuntime(root)
		const { container, mount } = await previewDocument(root, origin, unconfigured.bundleJs)
		const bridge = mount(container, { view: kitView(), context: context() })
		expect(providerLog().find(entry => entry.name === 'first.config')?.context).toEqual({ adapterId: 'first-kit', config: undefined })
		expect(container.querySelector('.kit-label')?.textContent).toBe('no config')
		bridge.dispose()
	})

	it('exposes no configuration channel besides the provider install context', async () => {
		const root = await createProviderWorkspace({ config: CONFIG })
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { window, module } = await previewDocument(root, origin, bundle.bundleJs)
		expect(Object.keys(module).sort()).toEqual(['describeAdapterDiagnostics', 'describeDeclaredWidgetEvents', 'mountPreviewRuntime'])
		expect(Object.keys((window as unknown as { __UIUX_PREVIEW_RUNTIME__: object }).__UIUX_PREVIEW_RUNTIME__)).toEqual(['mountPreviewRuntime'])
	})

	it('fails the construction for a provider that throws, naming the Adapter, `providers` and the entry index, and keeps nothing of it (Scenario 01a11a5b-1960-7fd0-92f5-8cab3317ef3a)', async () => {
		const root = await createProviderWorkspace({ config: CONFIG, second: 'throws' })
		// A provider runs only in the Preview, so the server cannot know it throws: the set stays valid.
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, {
			view: kitView(),
			context: context(),
			stylesheetHref: `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`,
			onStatusChange: status => statuses.push(status),
		})
		await until(() => statuses.length > 0, 'the construction to settle')
		expect(statuses).toEqual([{
			status: 'invalid',
			diagnostics: [{
				code: 'adapter.provider_install_failed',
				path: '/adapters/1/manifest/providers/0',
				message: expect.stringContaining('second-kit cannot start'),
			}],
		}])
		const message = (statuses[0] as Extract<PreviewRuntimeStatus, { status: 'invalid' }>).diagnostics[0]!.message
		expect(message).toContain('Provider 0 of Adapter second-kit (providers/0)')
		// Nothing of the construction is left: no stylesheet link, no render, and the providers that had
		// installed before the failing one have undone their global side effects.
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).toBeNull()
		expect(container.innerHTML).toBe('')
		expect(document.body.hasAttribute('data-first-kit')).toBe(false)
		expect(providerLog().map(entry => entry.name)).toEqual(['first.config', 'first.side-effect', 'second.throws', 'first.cleanup'])

		// The failed construction ignores later updates and disposes cleanly.
		bridge.updateContext(context({ locale: 'zh-TW' }))
		bridge.dispose()
		expect(statuses).toHaveLength(1)
		expect(providerLog().filter(entry => entry.name === 'first.cleanup')).toHaveLength(1)
	})

	it('fails the construction for a provider whose install returns a promise', async () => {
		const root = await createProviderWorkspace({ second: 'async' })
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		const statuses: PreviewRuntimeStatus[] = []
		mount(container, { view: kitView(), context: context(), onStatusChange: status => statuses.push(status) })
		expect(statuses).toEqual([{
			status: 'invalid',
			diagnostics: [{
				code: 'adapter.provider_install_async',
				path: '/adapters/1/manifest/providers/0',
				message: expect.stringContaining('Provider 0 of Adapter second-kit (providers/0) returned a promise'),
			}],
		}])
		expect(container.innerHTML).toBe('')
		expect(document.body.hasAttribute('data-first-kit')).toBe(false)
	})

	it('makes the Adapter invalid on the server for a provider entry that is not a Vue plugin', async () => {
		const root = await createProviderWorkspace({ second: 'malformed' })
		const diagnostic = {
			code: 'adapter.invalid_provider',
			path: '/adapters/1/manifest/providers/0',
			message: expect.stringContaining('Adapter second-kit must be a Vue plugin'),
		}
		// The resolution every surface shares (the Product Kit page, the Preview's Adapter check and the bundle).
		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution).toMatchObject({ state: 'invalid', diagnostics: [diagnostic] })
		expect(await getSelectedWorkspacePreviewBundle(root)).toMatchObject({ state: 'invalid', diagnostics: [diagnostic] })
		expect(providerLog()).toEqual([])
	})
})
