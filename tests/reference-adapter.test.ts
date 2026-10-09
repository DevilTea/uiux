// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { defineComponent, h } from 'vue'
import { createWidgetPlugin } from '@deviltea/widget-core'

import {
	extractProductAdapterManifest,
	productAdapterRegistryInspector,
	productAdapterApiCompatibility,
} from '../src/adapters/product-integration'
import { validateAdapterManifest } from '../src/domain/adapters/schema'
import {
	resolveSelectedWorkspaceAdapters,
} from '../src/server/workspace-adapters'
import { createStandalonePreviewMount } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

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

describe('UIUX Reference Adapter', () => {
	it('exports a valid canonical AdapterManifest with all reference widgets', async () => {
		const mod = await import('../design/adapters/reference.ts')
		const manifest = extractProductAdapterManifest(mod)

		expect(manifest.id).toBe('uiux-reference-adapter')
		expect(manifest.apiVersion).toBe('1')
		expect(productAdapterApiCompatibility.isCompatible(manifest.apiVersion)).toBe(true)

		const validation = validateAdapterManifest(manifest)
		expect(validation.ok).toBe(true)
		expect(validation.diagnostics).toEqual([])

		const ownership = await productAdapterRegistryInspector.inspect(manifest)
		const expectedWidgets = ['Stack', 'Panel', 'Text', 'Button', 'Badge', 'TextInput', 'NavItem', 'Divider']

		expect(ownership.widgetTypes).toEqual(expect.arrayContaining(expectedWidgets))
		expect(ownership.rendererKeys).toEqual(expect.arrayContaining(expectedWidgets))
		expect(ownership.widgetTypes).not.toContain('RootShell')
		expect(ownership.rendererKeys).not.toContain('RootShell')
	})

	it('renders a non-empty widget tree with correct data-widget-id attributes', async () => {
		const workspaceRoot = join(process.cwd(), 'design')
		await resolveSelectedWorkspaceAdapters(workspaceRoot)
		// Even if workspace.json is not yet updated, we can test bundling with the adapter directly
		const mod = await import('../design/adapters/reference.ts')
		const manifest = extractProductAdapterManifest(mod)
		const ownership = await productAdapterRegistryInspector.inspect(manifest)

		const mountFactory = createStandalonePreviewMount({
			adapterDescriptors: [
				{
					index: 0,
					id: manifest.id,
					apiVersion: manifest.apiVersion,
					widgetTypes: ownership.widgetTypes,
					rendererKeys: ownership.rendererKeys,
					namespace: mod as unknown as Record<string, unknown>,
				},
			],
		})

		setupDom()
		const container = document.createElement('div')
		document.body.appendChild(container)

		const TEST_VIEW_ID = '12345678-1234-4234-8234-123456789abc'
		const sampleView: ViewResource = {
			id: TEST_VIEW_ID,
			name: 'Reference Adapter Render Test',
			ir: {
				type: 'RootShell',
				id: 'root',
				slots: {
					content: [
						{
							type: 'Panel',
							id: 'main-panel',
							config: { title: 'Test Panel', variant: 'card' },
							slots: {
								header: [
									{ type: 'Badge', id: 'panel-badge', config: { label: 'Active', tone: 'success' } },
								],
								content: [
									{
										type: 'Stack',
										id: 'content-stack',
										config: { direction: 'horizontal', gap: 12 },
										slots: {
											content: [
												{ type: 'Text', id: 'heading-text', config: { text: 'Title text', variant: 'h2' } },
												{ type: 'Button', id: 'action-btn', config: { label: 'Click Me', variant: 'primary' } },
												{ type: 'TextInput', id: 'search-input', config: { placeholder: 'Search...' } },
												{ type: 'NavItem', id: 'item-1', config: { label: 'Nav Choice', selected: true } },
												{ type: 'Divider', id: 'sep-1', config: { orientation: 'vertical' } },
											],
										},
									},
								],
							},
						},
					],
				},
			} as never,
			variants: {},
			spec: {
				intent: 'Testing reference adapter render path',
				entryConditions: [],
				interactionRules: [],
				constraints: [],
				accessibility: [],
				references: [],
				decisions: [],
			},
		}

		const context: ResolvedRenderContext = {
			viewId: TEST_VIEW_ID,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'dark',
		}

		let reportedStatus: unknown
		const bridge = mountFactory.mountPreviewRuntime(container, {
			view: sampleView,
			context,
			onStatusChange: (s) => { reportedStatus = s },
		})

		expect(reportedStatus).toEqual({
			status: 'ready',
			supportedTypes: expect.arrayContaining(['RootShell', 'Stack', 'Panel', 'Text', 'Button', 'Badge', 'TextInput', 'NavItem', 'Divider']),
		})

		// Verify data-widget-id attributes are correctly exposed on rendered DOM
		expect(container.querySelector('[data-widget-id="main-panel"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="panel-badge"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="content-stack"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="heading-text"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="action-btn"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="search-input"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="item-1"]')).not.toBeNull()
		expect(container.querySelector('[data-widget-id="sep-1"]')).not.toBeNull()

		// Verify content rendered
		expect(container.innerHTML).toContain('Test Panel')
		expect(container.innerHTML).toContain('Active')
		expect(container.innerHTML).toContain('Title text')
		expect(container.innerHTML).toContain('Click Me')

		bridge.dispose()
		expect(container.innerHTML).toBe('')
	})

	describe('RootShell isolation regression', () => {
		it('fails closed when an adapter attempts to register or override RootShell widget plugin', () => {
			const rogueRootPlugin = createWidgetPlugin('RootShell').description('Test RootShell Widget.').interfaces<Record<never, never>>().done()
			const dummyRenderer = defineComponent({ render: () => h('div') })

			const rogueManifest = {
				id: 'rogue-adapter',
				apiVersion: '1',
				widgetPlugins: [rogueRootPlugin],
				catalog: { widgets: { RootShell: {} } },
				renderers: [{ type: 'RootShell', component: dummyRenderer }],
				providers: [],
				styles: [],
				tokens: [],
			}

			setupDom()
			const container = document.createElement('div')

			const mountFactory = createStandalonePreviewMount({
				adapterDescriptors: [
					{
						index: 0,
						id: rogueManifest.id,
						apiVersion: rogueManifest.apiVersion,
						widgetTypes: ['RootShell'],
						rendererKeys: ['RootShell'],
						namespace: { default: rogueManifest },
					},
				],
			})

			let reportedStatus: { status: string; diagnostics?: readonly { code: string }[] } | undefined
			mountFactory.mountPreviewRuntime(container, {
				view: {
					id: 'dummy',
					name: 'dummy',
					ir: { type: 'RootShell', id: 'root', slots: { content: [] } } as never,
					variants: {},
					spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
				},
				context: { viewId: 'dummy', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
				onStatusChange: (s) => { reportedStatus = s as typeof reportedStatus },
			})

			expect(reportedStatus?.status).toBe('invalid')
			expect(reportedStatus?.diagnostics?.some(d => d.code === 'adapter.reserved_root_shell_type')).toBe(true)
		})
	})
})
