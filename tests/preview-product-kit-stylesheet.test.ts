import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

import { getSelectedWorkspacePreviewBundle } from '../src/server/workspace-adapters'
import { clearPreviewBundleCache, PREVIEW_BUNDLE_STYLESHEET, previewRuntimeFileUrl } from '../src/server/preview-bundler'
import { readPreviewRuntimeFile } from '../src/server/preview-runtime-http'
import type { PreviewRuntimeBridge, PreviewRuntimeMountOptions, PreviewRuntimeStatus } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The Product Kit stylesheet (issue #141, Part 14 decision 6): the Preview bundler builds the style
 * entries and every CSS file the module graph imports into one stylesheet with its fonts and images
 * as files (Rule 01a11bb1-acdc-799f-aed7-c85ddbaf0d28, Clause 01a11bb1-8787-786a-a87e-49672393abd1),
 * served with source maps (Rule 01a11bb1-ae8c-721f-b1e4-f6936ffe5d5a); a construction links it first
 * and renders once it has loaded (Rules 01a11a5a-4d38-7f2c-98be-755d8c404d98,
 * 01a11bb1-ad41-761c-ad47-a0e7ed5b8240), fails when it does not load (Rules
 * 01a11be8-6078-7669-8e6d-6005d42c16dd, 01a11a5a-5059-716e-b0a5-d178395be034), removes it on dispose
 * or failure (Rule 01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5), and sets and swaps the active theme's root
 * attributes (Rules 01a11bb1-ada4-7dd7-b3da-733de7a85df4, 01a11bb1-ae0b-7120-888f-97234df0aa3b).
 *
 * The kit uses `fake-ui`, a component library that imports its CSS from JavaScript, the way a Vue
 * component library built by a bundler ships it (Scenario 01a11bb1-c318-76ba-b849-1a9050d129c9).
 */

const temporaryRoots: string[] = []
const servers: Server[] = []

afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const FONT_BYTES = Buffer.from('wOF2 fake font bytes for the test')
const THEMES = {
	dark: { 'data-kit-theme': 'dark' },
	light: { 'data-kit-theme': 'light', 'data-kit-contrast': 'normal' },
}

const ADAPTER_SOURCE = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { buttonClass } from 'fake-ui';

export const buttonPlugin = createWidgetPlugin('KitButton').interfaces().done();

export const KitButtonRenderer = defineComponent({
  name: 'KitButtonRenderer',
  setup() {
    return () => h('button', { class: buttonClass }, 'Styled');
  },
});

export const manifest = {
  id: 'fake-ui-kit',
  apiVersion: '1',
  widgetPlugins: [buttonPlugin],
  catalog: { widgets: { KitButton: {} } },
  renderers: [{ type: 'KitButton', component: KitButtonRenderer }],
  providers: [],
};
`

type KitOptions = Readonly<{
	styles?: readonly string[]
	buttonCss?: string
	files?: Readonly<Record<string, string>>
}>

/** A current-schema Workspace whose kit uses `fake-ui`, with `styles` and `themes` in its Product Kit file. */
async function createKitWorkspace(options: KitOptions = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-kit-stylesheet-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name))
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters: [{ moduleSpecifier: './adapters/kit.mjs' }],
		viewports: {},
		themes: {},
	})
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	await writeFile(productKitPath, `${JSON.stringify({ ...productKit, styles: options.styles ?? ['fake-ui/theme.css', './styles/base.css'], themes: THEMES }, null, 2)}\n`)

	const kit = join(root, 'kit')
	const library = join(kit, 'node_modules', 'fake-ui')
	await mkdir(join(kit, 'adapters'), { recursive: true })
	await mkdir(join(kit, 'styles'), { recursive: true })
	await mkdir(library, { recursive: true })
	await writeFile(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module', dependencies: { 'fake-ui': '1.0.0' } }))
	await writeFile(join(kit, 'adapters', 'kit.mjs'), ADAPTER_SOURCE)
	await writeFile(join(kit, 'styles', 'base.css'), '.uiux-kit-base { margin-top: 3px; }\n')
	await writeFile(join(library, 'package.json'), JSON.stringify({
		name: 'fake-ui',
		version: '1.0.0',
		type: 'module',
		exports: { '.': './index.js', './theme.css': './theme.css' },
	}))
	// The library's JavaScript imports its own CSS, which loads a font next to it.
	await writeFile(join(library, 'index.js'), `import './button.css';\nexport const buttonClass = 'fui-button';\n`)
	await writeFile(join(library, 'button.css'), options.buttonCss ?? [
		`@font-face { font-family: FakeUi; src: url('./fake-ui.woff2') format('woff2'); }`,
		`.fui-button { color: rgb(10, 20, 30); font-family: FakeUi; }`,
		`[data-kit-theme="dark"] .fui-button { background-color: rgb(0, 0, 0); }`,
		'',
	].join('\n'))
	await writeFile(join(library, 'fake-ui.woff2'), FONT_BYTES)
	await writeFile(join(library, 'theme.css'), ':root { --fui-accent: rgb(1, 2, 3); }\n')
	for (const [path, content] of Object.entries(options.files ?? {})) {
		await mkdir(join(kit, path, '..'), { recursive: true })
		await writeFile(join(kit, path), content)
	}
	return root
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

function buttonView(): ViewResource {
	return {
		id: '33333333-3333-4333-8333-333333333333',
		name: 'Kit Button View',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'b1', type: 'KitButton' }] } } as never,
		variants: {},
		spec: { intent: 'Kit styling', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function context(themeId: string): ResolvedRenderContext {
	return { viewId: '33333333-3333-4333-8333-333333333333', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId }
}

/** A Preview document at `origin` with the bundle's module imported into it. */
async function previewDocument(root: string, origin: string, bundleJs: string) {
	const window = new Window({ url: `${origin}/preview` })
	globalThis.window = window as unknown as typeof globalThis.window
	globalThis.document = window.document as unknown as Document
	globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = window.Element as unknown as typeof Element
	globalThis.Node = window.Node as unknown as typeof Node
	globalThis.SVGElement = window.SVGElement as unknown as typeof SVGElement
	// UIUX's own Preview stylesheet, which the Product Kit stylesheet must follow.
	const own = window.document.createElement('style')
	own.textContent = 'body { margin: 0; }'
	window.document.head.append(own)
	const file = join(root, `bundle-${randomUUID()}.mjs`)
	await writeFile(file, bundleJs)
	const module = await import(file) as { mountPreviewRuntime: (container: HTMLElement, options: PreviewRuntimeMountOptions) => PreviewRuntimeBridge }
	const container = window.document.createElement('div') as unknown as HTMLElement
	window.document.body.append(container as never)
	return { window, document: window.document as unknown as Document, container, mount: module.mountPreviewRuntime }
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

describe('Product Kit stylesheet bundling', () => {
	it('builds the style entries, then the CSS the module graph imports, into one stylesheet with the font as a file', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)

		expect(bundle.stylesheet).toBe(PREVIEW_BUNDLE_STYLESHEET)
		expect(bundle.themes).toEqual(THEMES)
		const paths = [...bundle.files.keys()]
		expect(paths).toEqual(expect.arrayContaining(['runtime.js', 'runtime.js.map', 'runtime.css', 'runtime.css.map']))
		const font = paths.find(path => /^assets\/fake-ui-[A-Z0-9]+\.woff2$/.test(path))
		expect(font).toBeDefined()
		expect(Buffer.from(bundle.files.get(font!)!.contents)).toEqual(FONT_BYTES)

		const css = new TextDecoder().decode(bundle.files.get('runtime.css')!.contents)
		// The `styles` entries in their order, then the CSS that JavaScript imports.
		const order = ['--fui-accent', '.uiux-kit-base', '.fui-button'].map(text => css.indexOf(text))
		expect(order.every(index => index >= 0)).toBe(true)
		expect([...order].sort((a, b) => a - b)).toEqual(order)
		// The font is referenced where the runtime route serves it.
		expect(css).toContain(previewRuntimeFileUrl(bundle.hash, font!))
		expect(css).toContain(`/*# sourceMappingURL=${previewRuntimeFileUrl(bundle.hash, 'runtime.css.map')} */`)
		// The CSS lives only in the stylesheet, so the module evaluates on the server too.
		expect(bundle.bundleJs).not.toContain('fui-button {')
	})

	it('serves the font and the stylesheet by content hash, and rebuilds when a style file changes', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const font = [...bundle.files.keys()].find(path => path.endsWith('.woff2'))!

		const served = await readPreviewRuntimeFile(root, undefined, bundle.hash, font)
		expect(served.status).toBe(200)
		if (served.status !== 200) return
		expect(served.headers['Content-Type']).toBe('font/woff2')
		expect(served.headers['Content-Security-Policy']).toContain('sandbox')
		expect(Buffer.from(served.file.contents)).toEqual(FONT_BYTES)
		const stylesheet = await readPreviewRuntimeFile(root, undefined, bundle.hash, 'runtime.css')
		expect(stylesheet.status === 200 && stylesheet.headers['Content-Type']).toBe('text/css; charset=utf-8')
		expect((await readPreviewRuntimeFile(root, undefined, bundle.hash, 'assets/missing.woff2')).status).toBe(404)

		await writeFile(join(root, 'kit', 'styles', 'base.css'), '.uiux-kit-base { margin-top: 4px; }\n')
		const rebuilt = await validBundle(root)
		expect(rebuilt.hash).not.toBe(bundle.hash)
		expect(new TextDecoder().decode(rebuilt.files.get('runtime.css')!.contents)).toContain('4px')
		// The earlier bundle stays servable by its own hash while a Preview may still load it.
		expect((await readPreviewRuntimeFile(root, undefined, bundle.hash, 'runtime.css')).status).toBe(200)
	})

	it('keeps the eight most recently used bundles servable and evicts the least recently used one', async () => {
		const root = await createKitWorkspace()
		const base = join(root, 'kit', 'styles', 'base.css')
		// Each generation of base.css has its own content and mtime, so the same generation rebuilds to the same hash.
		const generation = async (n: number): Promise<string> => {
			await writeFile(base, `.uiux-kit-base { margin-top: ${n}px; }\n`)
			const time = new Date(Date.UTC(2026, 0, 1, 0, 0, n))
			await utimes(base, time, time)
			return (await validBundle(root)).hash
		}
		const servable = async (hash: string) => (await readPreviewRuntimeFile(root, undefined, hash, 'runtime.css')).status

		const hashes: string[] = []
		for (let n = 0; n < 8; n++) hashes.push(await generation(n))
		expect(new Set(hashes).size).toBe(8)
		// The current bundle is generation 7; the seven earlier ones are still served from the cache.
		for (const hash of hashes) expect(await servable(hash)).toBe(200)

		// Using generation 0 again makes it the most recent, so the ninth bundle evicts generation 1.
		expect(await generation(0)).toBe(hashes[0])
		const ninth = await generation(8)
		expect(await servable(ninth)).toBe(200)
		expect(await servable(hashes[0]!)).toBe(200)
		expect(await servable(hashes[1]!)).toBe(404)
		for (const hash of hashes.slice(2)) expect(await servable(hash)).toBe(200)
	})

	it('serves source maps that name no host path, in their sources or their sourcesContent', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const hostPaths = [...new Set([root, await realpath(root), process.cwd(), await realpath(process.cwd())])]
		for (const file of ['runtime.js.map', 'runtime.css.map']) {
			const served = await readPreviewRuntimeFile(root, undefined, bundle.hash, file)
			expect(served.status, file).toBe(200)
			if (served.status !== 200) continue
			const text = new TextDecoder().decode(served.file.contents)
			const map = JSON.parse(text) as { sources: string[]; sourcesContent?: Array<string | null> }
			expect(map.sources.length, file).toBeGreaterThan(0)
			for (const hostPath of hostPaths) expect(text, `${file} names ${hostPath}`).not.toContain(hostPath)
			expect(text, file).not.toMatch(/\/(?:private|var|Users|tmp|home)\//)
			expect(text, file).not.toContain('file://')
			for (const source of map.sources) expect(source, file).toMatch(/^(?:workspace|uiux|external):\/\/\/|^<stdin>$/)
		}
		// The generated entry is mapped, but its content (absolute import paths) is not served.
		const js = JSON.parse(new TextDecoder().decode(bundle.files.get('runtime.js.map')!.contents)) as { sources: string[]; sourcesContent: Array<string | null> }
		const entry = js.sources.indexOf('<stdin>')
		expect(entry).toBeGreaterThanOrEqual(0)
		expect(js.sourcesContent[entry]).toBeNull()
	})

	it('makes the Preview invalid for a style that does not resolve or names no CSS file, and for CSS it cannot bundle', async () => {
		const unresolved = await createKitWorkspace({ styles: ['./styles/missing.css'] })
		expect(await getSelectedWorkspacePreviewBundle(unresolved)).toMatchObject({
			state: 'invalid',
			diagnostics: [{ code: 'product_kit.style_unresolved', path: '/styles/0' }],
		})

		// Without a declared build, a ./ style is any CSS file inside kit/ but outside kit/node_modules/,
		// contained like a ./ Adapter (Clause 01a11bb1-8e98-7270-9662-682c048f9929).
		const dependency = await createKitWorkspace({ styles: ['./node_modules/fake-ui/theme.css'] })
		expect(await getSelectedWorkspacePreviewBundle(dependency)).toMatchObject({
			state: 'invalid',
			diagnostics: [{ code: 'product_kit.style_unresolved', path: '/styles/0' }],
		})

		const notCss = await createKitWorkspace({ styles: ['./styles/notes.txt'], files: { 'styles/notes.txt': 'not css' } })
		expect(await getSelectedWorkspacePreviewBundle(notCss)).toMatchObject({
			state: 'invalid',
			diagnostics: [{ code: 'product_kit.style_not_css', path: '/styles/0' }],
		})

		const broken = await createKitWorkspace({ buttonCss: `.fui-button { background: url('./missing.png'); }\n` })
		const result = await getSelectedWorkspacePreviewBundle(broken)
		expect(result).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'preview.bundle_failed', path: '/product-kit' }] })
		// The esbuild error names the file by its path inside the Workspace and no host path, though the
		// temporary directory's path runs through a symlink on some hosts (`/var` on macOS).
		const message = JSON.stringify(result)
		expect(message).toContain('missing.png')
		expect(message).toContain('kit/node_modules/fake-ui/button.css')
		expect(message).not.toMatch(/\/(?:private|var|Users|tmp|home)\//)
		expect(message).not.toMatch(/private|\.\.\//)
	})
})

/** Sets every file under `dir` to a fixed past modification time, so no input is newer than a build that reads it. */
async function backdate(dir: string): Promise<void> {
	const time = new Date(Date.UTC(2026, 0, 1))
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
		if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), time, time)
}

/**
 * The Preview bundle's cache key covers its whole module graph (issue #250): every file the build
 * read for the style entries and the Adapter modules, without the host packages it aliases.
 */
describe('Preview bundle cache', () => {
	it('builds again when a module or a CSS file the Adapter imports changes, though no entry changed', async () => {
		const root = await createKitWorkspace()
		const library = join(root, 'kit', 'node_modules', 'fake-ui')
		const moduleSource = await readFile(join(library, 'index.js'), 'utf8')
		const css = await readFile(join(library, 'button.css'), 'utf8')
		const first = await validBundle(root)

		// A module the Adapter entry imports.
		await writeFile(join(library, 'index.js'), moduleSource.replace(`'fui-button'`, `'fui-button fui-edited'`))
		const moduleEdited = await validBundle(root)
		expect(moduleEdited.hash).not.toBe(first.hash)
		expect(moduleEdited.bundleJs).toContain('fui-edited')

		// A stylesheet that module imports.
		await writeFile(join(library, 'button.css'), css.replace('.fui-button {', '.fui-button, .fui-edited-css {'))
		const cssEdited = await validBundle(root)
		expect(cssEdited.hash).not.toBe(moduleEdited.hash)
		const served = await readPreviewRuntimeFile(root, undefined, cssEdited.hash, 'runtime.css')
		expect(served.status).toBe(200)
		expect(served.status === 200 && new TextDecoder().decode(served.file.contents)).toContain('.fui-edited-css')

		// The hash follows the bytes: the files as they were give the first bundle's hash again.
		await writeFile(join(library, 'index.js'), moduleSource)
		await writeFile(join(library, 'button.css'), css)
		expect((await validBundle(root)).hash).toBe(first.hash)
	}, 20_000)

	it('reuses the bundle while its module graph is unchanged, without building again', async () => {
		const root = await createKitWorkspace()
		await backdate(join(root, 'kit'))
		const first = await validBundle(root)
		const again = await validBundle(root)
		expect(again.hash).toBe(first.hash)
		// The same output files: nothing was built again.
		expect(again.files).toBe(first.files)

		// A file written again with the same bytes changes its stat, not the graph.
		const css = join(root, 'kit', 'node_modules', 'fake-ui', 'button.css')
		await writeFile(css, await readFile(css))
		expect((await validBundle(root)).files).toBe(first.files)
	})

	it('builds again when an input changed at or after the start of the build that read it', async () => {
		const root = await createKitWorkspace()
		await backdate(join(root, 'kit'))
		// A modification time after the build started: esbuild may have read other bytes than the digest's.
		const css = join(root, 'kit', 'node_modules', 'fake-ui', 'button.css')
		const later = new Date(Date.now() + 60_000)
		await utimes(css, later, later)
		const first = await validBundle(root)
		const again = await validBundle(root)
		expect(again.hash).toBe(first.hash)
		// Other output files: it was built again (an identity check; `not.toBe` would diff the two maps).
		expect(again.files === first.files).toBe(false)
	})

	it('leaves the host packages it aliases to UIUX\'s own copies out of the graph', async () => {
		const root = await createKitWorkspace()
		// The kit's own `vue`, which the Preview bundle never reads: `vue` resolves to UIUX's copy.
		const kitVue = join(root, 'kit', 'node_modules', 'vue')
		await mkdir(kitVue, { recursive: true })
		await writeFile(join(kitVue, 'package.json'), JSON.stringify({ name: 'vue', version: '3.5.0', type: 'module', exports: './index.js' }))
		const kitVueSource = `export * from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules', 'vue', 'index.mjs')).href)};\n`
		await writeFile(join(kitVue, 'index.js'), kitVueSource)
		await backdate(join(root, 'kit'))
		const first = await validBundle(root)
		const map = JSON.parse(new TextDecoder().decode(first.files.get('runtime.js.map')!.contents)) as { sources: string[] }
		expect(map.sources.some(source => source.startsWith('workspace:///kit/node_modules/vue/'))).toBe(false)
		expect(map.sources.some(source => source.includes('runtime-core'))).toBe(true)

		await writeFile(join(kitVue, 'index.js'), `${kitVueSource}// edited\n`)
		const again = await validBundle(root)
		expect(again.hash).toBe(first.hash)
		expect(again.files).toBe(first.files)
	})
})

describe('Product Kit stylesheet in a Preview Runtime construction', () => {
	it('links the stylesheet after UIUX\'s own, renders the library styled once it has loaded, and swaps the theme attributes live', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount, window } = await previewDocument(root, origin, bundle.bundleJs)

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, {
			view: buttonView(),
			context: context('dark'),
			stylesheetHref: `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`,
			themes: bundle.themes,
			onStatusChange: status => statuses.push(status),
		})

		// Linked first, at the end of the head; the active theme's attributes are already set.
		const link = document.head.lastElementChild as HTMLLinkElement
		expect(link.tagName).toBe('LINK')
		expect(link.rel).toBe('stylesheet')
		expect(link.hasAttribute('data-uiux-product-kit-stylesheet')).toBe(true)
		expect(document.documentElement.getAttribute('data-kit-theme')).toBe('dark')
		// The first render waits for the stylesheet.
		expect(statuses).toEqual([])
		expect(container.innerHTML).toBe('')

		await until(() => statuses.length > 0, 'the first render')
		expect(statuses).toEqual([{ status: 'ready', supportedTypes: expect.arrayContaining(['KitButton']) }])
		const button = container.querySelector('button.fui-button')!
		expect(button).not.toBeNull()
		const style = window.getComputedStyle(button as never)
		expect(style.color).toBe('rgb(10, 20, 30)')
		expect(style.backgroundColor).toBe('rgb(0, 0, 0)')

		// A live theme change swaps the root attributes in this construction.
		bridge.updateContext(context('light'))
		expect(document.documentElement.getAttribute('data-kit-theme')).toBe('light')
		expect(document.documentElement.getAttribute('data-kit-contrast')).toBe('normal')
		bridge.updateContext(context('dark'))
		expect(document.documentElement.getAttribute('data-kit-theme')).toBe('dark')
		expect(document.documentElement.hasAttribute('data-kit-contrast')).toBe(false)
		// A theme the Product Kit does not map sets no attribute.
		bridge.updateContext(context('sepia'))
		expect(document.documentElement.hasAttribute('data-kit-theme')).toBe(false)
		expect(statuses).toHaveLength(1)

		bridge.dispose()
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).toBeNull()
		expect(container.innerHTML).toBe('')
	})

	it('restores the document element\'s own attributes on dispose', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)
		document.documentElement.setAttribute('data-kit-theme', 'host')

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, { view: buttonView(), context: context('dark'), themes: bundle.themes, onStatusChange: status => statuses.push(status) })
		// Without a stylesheet the construction renders at once.
		expect(statuses).toEqual([expect.objectContaining({ status: 'ready' })])
		expect(document.documentElement.getAttribute('data-kit-theme')).toBe('dark')
		bridge.dispose()
		expect(document.documentElement.getAttribute('data-kit-theme')).toBe('host')
	})

	it('sets only class and data-* theme attributes, ignoring any other name that reaches it', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		// A Product Kit file the validator would refuse (Clause 01a11bb1-8efc-77df-a0bb-78033bb35d56).
		const themes = { dark: { 'onclick': 'globalThis.pwned = true', 'style': 'color: red', 'href': 'javascript:void 0', 'data-': 'x', 'class': 'kit-dark', 'data-kit-theme': 'dark' } }
		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, { view: buttonView(), context: context('dark'), themes, onStatusChange: status => statuses.push(status) })
		expect(statuses).toEqual([expect.objectContaining({ status: 'ready' })])
		const element = document.documentElement
		expect(element.getAttributeNames().sort()).toEqual(['class', 'data-kit-theme'])
		expect(element.getAttribute('class')).toBe('kit-dark')
		bridge.dispose()
		expect(element.getAttributeNames()).toEqual([])
	})

	it('lowercases theme attribute names, so a mixed-case name leaves nothing behind on a swap or dispose', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		// A Product Kit file the validator would refuse: HTML stores `data-X` as `data-x`.
		const themes = { dark: { 'data-X': 'a', 'data-x': 'b', 'CLASS': 'kit-dark' }, light: { 'data-mode': 'light' } }
		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, { view: buttonView(), context: context('dark'), themes, onStatusChange: status => statuses.push(status) })
		expect(statuses).toEqual([expect.objectContaining({ status: 'ready' })])
		const element = document.documentElement
		expect(element.getAttributeNames().sort()).toEqual(['class', 'data-x'])
		expect(element.getAttribute('data-x')).toBe('b')

		bridge.updateContext(context('light'))
		expect(element.getAttributeNames()).toEqual(['data-mode'])
		bridge.updateContext(context('dark'))
		bridge.dispose()
		expect(element.getAttributeNames()).toEqual([])
	})

	it('fails the construction when the stylesheet does not load, naming it, and keeps nothing of it', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)
		const href = `${origin}${previewRuntimeFileUrl('0000000000000000', 'runtime.css')}`

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, {
			view: buttonView(),
			context: context('dark'),
			stylesheetHref: href,
			themes: bundle.themes,
			onStatusChange: status => statuses.push(status),
		})
		await until(() => statuses.length > 0, 'the construction to fail')
		expect(statuses).toEqual([{
			status: 'invalid',
			diagnostics: [{ code: 'preview.stylesheet_load_failed', path: '/product-kit', message: expect.stringContaining(href) }],
		}])
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).toBeNull()
		expect(document.documentElement.hasAttribute('data-kit-theme')).toBe(false)
		expect(container.innerHTML).toBe('')
		// A failed construction takes no update and reports nothing more.
		bridge.updateContext(context('light'))
		bridge.updateView(buttonView())
		expect(document.documentElement.hasAttribute('data-kit-theme')).toBe(false)
		expect(statuses).toHaveLength(1)
		bridge.dispose()
	})

	it('reports no status while the stylesheet is linking, then the status of the latest update instead of ready', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { container, mount } = await previewDocument(root, origin, bundle.bundleJs)
		const stylesheetHref = `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`
		const unsupported: ViewResource = { ...buttonView(), ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'g1', type: 'GhostWidget' }] } } as never }

		// An update that reports while linking holds its status until the first render.
		const held: PreviewRuntimeStatus[] = []
		const first = mount(container, { view: buttonView(), context: context('dark'), stylesheetHref, themes: bundle.themes, onStatusChange: status => held.push(status) })
		first.updateView(unsupported)
		first.updateContext(context('light'))
		expect(held).toEqual([])
		expect(container.innerHTML).toBe('')
		await until(() => held.length > 0, 'the first render')
		expect(held).toEqual([expect.objectContaining({ status: 'adapter_unavailable', unsupportedTypes: ['GhostWidget'] })])
		first.dispose()

		// A later update back to a supported View while linking reports ready, once.
		const recovered: PreviewRuntimeStatus[] = []
		const second = mount(container, { view: buttonView(), context: context('dark'), stylesheetHref, themes: bundle.themes, onStatusChange: status => recovered.push(status) })
		second.updateView(unsupported)
		second.updateView(buttonView())
		expect(recovered).toEqual([])
		await until(() => recovered.length > 0, 'the first render')
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(recovered).toEqual([{ status: 'ready', supportedTypes: expect.arrayContaining(['KitButton']) }])
		expect(container.querySelector('button.fui-button')).not.toBeNull()
		second.dispose()
	})

	it('removes the link of a construction disposed before its stylesheet loaded', async () => {
		const root = await createKitWorkspace()
		const bundle = await validBundle(root)
		const origin = await serveRuntime(root)
		const { document, container, mount } = await previewDocument(root, origin, bundle.bundleJs)

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = mount(container, {
			view: buttonView(),
			context: context('dark'),
			stylesheetHref: `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`,
			themes: bundle.themes,
			onStatusChange: status => statuses.push(status),
		})
		bridge.dispose()
		expect(document.querySelector('link[data-uiux-product-kit-stylesheet]')).toBeNull()
		expect(document.documentElement.hasAttribute('data-kit-theme')).toBe(false)
		await new Promise(resolve => setTimeout(resolve, 100))
		expect(statuses).toEqual([])
		expect(container.innerHTML).toBe('')
	})
})
