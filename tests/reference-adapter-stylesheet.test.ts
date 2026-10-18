import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'

import { getSelectedWorkspacePreviewBundle } from '../src/server/workspace-adapters'
import { clearPreviewBundleCache, PREVIEW_BUNDLE_STYLESHEET, previewRuntimeFileUrl } from '../src/server/preview-bundler'
import { readPreviewRuntimeFile } from '../src/server/preview-runtime-http'
import type { PreviewRuntimeBridge, PreviewRuntimeMountOptions, PreviewRuntimeStatus } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The reference Adapter's CSS reaches the Preview only through the one Product Kit stylesheet
 * (Discussion #241 R1): `reference.ts` imports `reference.css`, which the Preview bundler builds into
 * that stylesheet with the rest of the Adapter module graph (Rule 01a11bb1-acdc-799f-aed7-c85ddbaf0d28),
 * and no renderer inserts a `<style>` element of its own. The kit is a private copy of the dogfood
 * `.uiux/kit/adapters/`, so the dogfood Workspace is only read.
 */

const DOGFOOD_ADAPTERS = join(process.cwd(), '.uiux', 'kit', 'adapters')
const VIEW_ID = '12345678-1234-4234-8234-123456789abc'

const temporaryRoots: string[] = []
const servers: Server[] = []

afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A current-schema Workspace whose kit holds a copy of the reference Adapter and its CSS, with no Product Kit `styles`. */
async function referenceWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-reference-stylesheet-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name))
	// The reference Adapter imports the public authoring entry `@deviltea/uiux/adapter`, which the dogfood
	// kit reaches as a self-reference of this repository; the copy reaches it as an installed package.
	await symlink(process.cwd(), join(root, 'node_modules', '@deviltea', 'uiux'))
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters: [{ moduleSpecifier: './adapters/reference.ts' }],
		viewports: {},
		themes: {},
	})
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	for (const file of ['reference.ts', 'reference.css'])
		await copyFile(join(DOGFOOD_ADAPTERS, file), join(root, 'kit', 'adapters', file))
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

function badgeView(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Reference Badge',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'badge', type: 'Badge', config: { label: 'Active', tone: 'success' } }] } } as never,
		variants: {},
		spec: { intent: 'Reference styling', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

const CONTEXT: ResolvedRenderContext = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'dark' }

async function until(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`)
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

describe('Reference Adapter styles', () => {
	it('builds the CSS that reference.ts imports into the Product Kit stylesheet, not into the module', async () => {
		const root = await referenceWorkspace()
		const bundle = await getSelectedWorkspacePreviewBundle(root)
		if (bundle.state !== 'valid') throw new Error(`Expected a valid bundle: ${JSON.stringify(bundle.diagnostics)}`)

		expect(bundle.stylesheet).toBe(PREVIEW_BUNDLE_STYLESHEET)
		const css = new TextDecoder().decode(bundle.files.get(PREVIEW_BUNDLE_STYLESHEET)!.contents)
		for (const selector of ['.uiux-ref-scope', '.uiux-theme-dark', '.uiux-ref-badge', '.uiux-ref-empty'])
			expect(css, selector).toContain(selector)
		expect(bundle.bundleJs).not.toContain('.uiux-ref-badge {')
		expect(bundle.bundleJs).not.toContain('uiux-reference-adapter-styles')
	})

	it('renders the reference Widgets styled from the linked stylesheet, inserting no style element of its own', async () => {
		const root = await referenceWorkspace()
		const bundle = await getSelectedWorkspacePreviewBundle(root)
		if (bundle.state !== 'valid') throw new Error(`Expected a valid bundle: ${JSON.stringify(bundle.diagnostics)}`)
		const origin = await serveRuntime(root)

		const window = new Window({ url: `${origin}/preview` })
		globalThis.window = window as unknown as typeof globalThis.window
		globalThis.document = window.document as unknown as Document
		globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement
		globalThis.Element = window.Element as unknown as typeof Element
		globalThis.Node = window.Node as unknown as typeof Node
		globalThis.SVGElement = window.SVGElement as unknown as typeof SVGElement
		const file = join(root, `bundle-${randomUUID()}.mjs`)
		await writeFile(file, bundle.bundleJs)
		const module = await import(file) as { mountPreviewRuntime: (container: HTMLElement, options: PreviewRuntimeMountOptions) => PreviewRuntimeBridge }
		const container = window.document.createElement('div') as unknown as HTMLElement
		window.document.body.append(container as never)

		const statuses: PreviewRuntimeStatus[] = []
		const bridge = module.mountPreviewRuntime(container, {
			view: badgeView(),
			context: CONTEXT,
			stylesheetHref: `${origin}${previewRuntimeFileUrl(bundle.hash, bundle.stylesheet!)}`,
			onStatusChange: status => statuses.push(status),
		})
		await until(() => statuses.length > 0, 'the first render')
		expect(statuses).toEqual([expect.objectContaining({ status: 'ready' })])

		const badge = container.querySelector('[data-widget-id="badge"]')!
		expect(badge.classList.contains('uiux-ref-badge')).toBe(true)
		const style = window.getComputedStyle(badge as never)
		expect(style.display).toBe('inline-flex')
		expect(style.fontSize).toBe('12px')
		expect(style.borderRadius).toBe('4px')
		// The Product Kit stylesheet is the document's only stylesheet.
		expect(window.document.querySelectorAll('style')).toHaveLength(0)
		expect(window.document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1)

		bridge.dispose()
	})
})
