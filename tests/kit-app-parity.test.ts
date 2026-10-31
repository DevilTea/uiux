// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

import { extractProductAdapterManifest, productAdapterRegistryInspector } from '../src/adapters/product-integration'
import { createStandalonePreviewMount, type PreviewRuntimeBridge } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

/**
 * The Kit capabilities the Workbench app needs before it can adopt the Kit components without changing its look
 * (issue #380, PR #419): Button `xs`, the `soft` look and `pressed` toggles, `truncate` on Button and Badge, the
 * `ButtonGroup` Widget, a rotating trailing icon (`expanded`), and a legible mono face (slashed zero). The
 * behavior runs from the dogfood kit build output `.uiux/kit/dist/uiux.js` through the Widget wrappers (the
 * tests load no `.vue` file); a style is checked as a rule of the built `uiux.css`, which happy-dom does not apply.
 */

const KIT = join(process.cwd(), '.uiux', 'kit')
const ADAPTER = join(KIT, 'dist', 'uiux.js')
const VIEW_ID = '12345678-1234-4234-8234-123456789abc'
const CONTEXT: ResolvedRenderContext = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }

type Widget = Readonly<{ type: string; id: string; config?: Record<string, unknown>; slots?: Record<string, readonly Widget[]> }>
type Variants = Record<string, { state: Record<string, Record<string, unknown>> }>

async function mount(widgets: readonly Widget[], variants: Variants = {}): Promise<Readonly<{ container: HTMLElement; bridge: PreviewRuntimeBridge }>> {
	const win = new Window()
	globalThis.window = win as unknown as typeof globalThis.window
	globalThis.document = win.document as unknown as Document
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = win.Element as unknown as typeof Element
	globalThis.Node = win.Node as unknown as typeof Node
	globalThis.SVGElement = win.SVGElement as unknown as typeof SVGElement
	const namespace = await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>
	const manifest = extractProductAdapterManifest(namespace)
	const ownership = await productAdapterRegistryInspector.inspect(manifest)
	const factory = createStandalonePreviewMount({
		adapterDescriptors: [{ index: 0, id: manifest.id, apiVersion: manifest.apiVersion, widgetTypes: ownership.widgetTypes, rendererKeys: ownership.rendererKeys, namespace }],
	})
	const container = document.createElement('div')
	document.body.appendChild(container)
	const view: ViewResource = {
		id: VIEW_ID,
		name: 'App parity',
		ir: { type: 'RootShell', id: 'root', slots: { content: widgets } } as never,
		variants: variants as never,
		spec: { intent: 'App parity', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
	let status: unknown
	const bridge = factory.mountPreviewRuntime(container, { view, context: CONTEXT, onStatusChange: (next) => { status = next } })
	expect(status).toMatchObject({ status: 'ready' })
	return { container, bridge }
}

const widget = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function applyVariant(bridge: PreviewRuntimeBridge, name: string): Promise<void> {
	expect(bridge.applyVariantStateLive!(name)).toEqual([])
	await tick()
}

/** The declarations of the first rule of the built stylesheet whose selector list holds `selector` (outside a nested at-rule). */
async function declarations(selector: string): Promise<string> {
	const css = (await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
	for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		// Split the selector list at top-level commas only: `:is(:disabled, [aria-disabled=true])` holds one.
		if (list!.split(/,(?![^()]*\))/).some(entry => entry.trim() === selector)) return body!.replace(/\s+/g, ' ').trim()
	}
	throw new Error(`uiux.css has no rule for ${selector}`)
}

describe('the Widget configuration an author sees', () => {
	it('offers each capability in the Config schema of Button, Badge and ButtonGroup', async () => {
		const manifest = extractProductAdapterManifest(await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>)
		const schemaOf = (type: string) => (manifest.widgetPlugins as unknown as ReadonlyArray<{ type: string; config: { schema: { properties: Record<string, { enum?: string[]; type?: string }> } } }>)
			.find(plugin => plugin.type === type)?.config.schema.properties
		const button = schemaOf('Button')!
		expect(button.size?.enum).toEqual(['xs', 'sm', 'md', 'lg'])
		expect(button.variant?.enum).toContain('soft')
		for (const field of ['pressed', 'expanded', 'truncate']) expect(button[field]?.type, field).toBe('boolean')
		expect(schemaOf('Badge')!.truncate?.type).toBe('boolean')
		expect(Object.keys(schemaOf('ButtonGroup')!)).toEqual(expect.arrayContaining(['label', 'labelKey']))
	})
})

describe('Button xs', () => {
	it('is a 24px size, and an icon-only xs button is 24px wide', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'small', config: { label: 'Clear all', size: 'xs' } },
			{ type: 'Button', id: 'square', config: { label: 'Close', icon: 'x', iconOnly: true, size: 'xs' } },
		])
		expect(widget(container, 'small').classList.contains('kit-btn--xs')).toBe(true)
		expect(widget(container, 'square').classList.contains('kit-btn--xs')).toBe(true)
		expect(await declarations('.kit-btn.kit-btn--xs')).toMatch(/height: 24px/)
		expect(await declarations('.kit-btn.kit-btn--xs')).toMatch(/font-size: 12px/)
		expect(await declarations('.kit-btn.is-icon-only.kit-btn--xs')).toMatch(/width: 24px/)
		bridge.dispose()
	})
})

describe('the soft look and pressed toggles', () => {
	it('is a toggle only when it has `pressed`: aria-pressed follows the state, and a pressed button takes the soft look', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Button', id: 'plain', config: { label: 'Plain' } },
				{ type: 'Button', id: 'mine', config: { label: 'Mine', variant: 'outline', pressed: false } },
				{ type: 'Button', id: 'quiet', config: { label: 'Quiet', variant: 'soft' } },
			],
			{ on: { state: { mine: { pressed: true } } } },
		)
		expect(widget(container, 'plain').getAttribute('aria-pressed')).toBeNull()
		expect(widget(container, 'mine').getAttribute('aria-pressed')).toBe('false')
		expect(widget(container, 'mine').classList.contains('is-pressed')).toBe(false)
		expect(widget(container, 'quiet').classList.contains('kit-btn--soft')).toBe(true)
		await applyVariant(bridge, 'on')
		expect(widget(container, 'mine').getAttribute('aria-pressed')).toBe('true')
		expect(widget(container, 'mine').classList.contains('is-pressed')).toBe(true)
		expect(widget(container, 'plain').getAttribute('aria-pressed')).toBeNull()
		bridge.dispose()
	})

	it('draws soft and pressed as the elevated fill without a border, moving to the accented step on hover', async () => {
		const soft = await declarations('.kit-btn.kit-btn--soft:not(:is(:disabled, [aria-disabled=true]))')
		expect(soft).toMatch(/background-color: var\(--kit-bg-surface-elevated\)/)
		expect(soft).toMatch(/border-color: transparent/)
		expect(soft).not.toMatch(/--kit-text-highlighted/)
		expect(await declarations('.kit-btn.is-pressed:not(:is(:disabled, [aria-disabled=true]))')).toBe(soft)
		expect(await declarations('.kit-btn.kit-btn--soft:hover:not(:is(:disabled, [aria-disabled=true]))')).toMatch(/--kit-bg-accented/)
	})
})

describe('a Button that is neither a toggle nor a disclosure', () => {
	it('has no aria-pressed or aria-expanded, also where another Widget renders the Kit Button without those props', async () => {
		const { container, bridge } = await mount([
			{ type: 'Alert', id: 'alert', config: { title: 'Saved', dismissible: true, dismissLabel: 'Close alert' } },
		])
		const close = widget(container, 'alert').querySelector('button')!
		expect(close.getAttribute('aria-label')).toBe('Close alert')
		expect(close.hasAttribute('aria-pressed')).toBe(false)
		expect(close.hasAttribute('aria-expanded')).toBe(false)
		expect(close.classList.contains('is-pressed')).toBe(false)
		bridge.dispose()
	})
})

describe('truncate', () => {
	it('ends a Button label in an ellipsis and keeps the full text as the title', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'long', config: { label: 'A very long saved filter name', truncate: true } },
			{ type: 'Button', id: 'short', config: { label: 'Short' } },
		])
		const long = widget(container, 'long')
		expect(long.classList.contains('is-truncate')).toBe(true)
		expect(long.getAttribute('title')).toBe('A very long saved filter name')
		expect(long.querySelector('.kit-btn__label')?.textContent).toBe('A very long saved filter name')
		expect(widget(container, 'short').getAttribute('title')).toBeNull()
		expect(await declarations('.kit-btn.is-truncate')).toMatch(/max-width: 100%/)
		const label = await declarations('.kit-btn.is-truncate .kit-btn__label')
		expect(label).toMatch(/overflow: hidden/)
		expect(label).toMatch(/text-overflow: ellipsis/)
		expect(label).toMatch(/min-width: 0/)
		bridge.dispose()
	})

	it('ends a Badge label in an ellipsis and keeps the full text as the title, without changing a plain Badge', async () => {
		const { container, bridge } = await mount([
			{ type: 'Badge', id: 'long', config: { label: 'workspace/views/checkout', variant: 'mono', truncate: true } },
			{ type: 'Badge', id: 'plain', config: { label: 'Open' } },
		])
		const long = widget(container, 'long')
		expect(long.classList.contains('is-truncate')).toBe(true)
		expect(long.getAttribute('title')).toBe('workspace/views/checkout')
		expect(long.querySelector('.kit-badge__label')?.textContent).toBe('workspace/views/checkout')
		const plain = widget(container, 'plain')
		expect(plain.getAttribute('title')).toBeNull()
		expect(plain.querySelector('.kit-badge__label')).toBeNull()
		expect(plain.textContent).toBe('Open')
		expect(await declarations('.kit-badge.is-truncate')).toMatch(/max-width: 100%/)
		expect(await declarations('.kit-badge .kit-badge__label')).toMatch(/text-overflow: ellipsis/)
		bridge.dispose()
	})
})

describe('ButtonGroup', () => {
	it('is a named group landmark holding its Buttons as direct children, and is in the Catalog', async () => {
		const manifest = extractProductAdapterManifest(await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>)
		const ownership = await productAdapterRegistryInspector.inspect(manifest)
		expect(ownership.widgetTypes).toContain('ButtonGroup')
		expect(ownership.rendererKeys).toContain('ButtonGroup')
		expect(Object.keys(manifest.catalog.widgets.ButtonGroup?.i18n?.fields ?? {})).toEqual(['label'])
		const { container, bridge } = await mount([{
			type: 'ButtonGroup',
			id: 'split',
			config: { label: 'Resolve' },
			slots: { buttons: [
				{ type: 'Button', id: 'resolve', config: { label: 'Resolve', variant: 'primary', icon: 'check', size: 'sm' } },
				{ type: 'Button', id: 'menu', config: { label: 'Resolve options', variant: 'primary', icon: 'chevron-down', iconOnly: true, size: 'sm' } },
			] },
		}])
		const group = widget(container, 'split')
		expect(group.getAttribute('role')).toBe('group')
		expect(group.getAttribute('aria-label')).toBe('Resolve')
		expect(group.classList.contains('kit-btn-group')).toBe(true)
		expect([...group.children].map(child => child.getAttribute('data-widget-id'))).toEqual(['resolve', 'menu'])
		bridge.dispose()
	})

	it('has no name unless it is given one', async () => {
		const { container, bridge } = await mount([{ type: 'ButtonGroup', id: 'g', slots: { buttons: [{ type: 'Button', id: 'a', config: { label: 'A' } }] } }])
		expect(widget(container, 'g').hasAttribute('aria-label')).toBe(false)
		bridge.dispose()
	})

	it('squares off the inner corners and overlaps the shared border, and lifts the hovered or focused button above its neighbors', async () => {
		expect(await declarations('.kit-btn-group > .kit-btn:not(:first-child)')).toMatch(/margin-inline-start: -1px.*border-start-start-radius: 0.*border-end-start-radius: 0/)
		expect(await declarations('.kit-btn-group > .kit-btn:not(:last-child)')).toMatch(/border-start-end-radius: 0.*border-end-end-radius: 0/)
		expect(await declarations('.kit-btn-group > .kit-btn:focus-visible')).toMatch(/z-index: 1/)
	})
})

describe('a rotating trailing icon', () => {
	it('is a disclosure toggle only when it has `expanded`: aria-expanded follows the state and the chevron turns while expanded', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Button', id: 'plain', config: { label: 'Plain', trailingIcon: 'chevron-down' } },
				{ type: 'Button', id: 'evidence', config: { label: '2 evidence', variant: 'link-muted', size: 'xs', trailingIcon: 'chevron-down', expanded: false } },
			],
			{ open: { state: { evidence: { expanded: true } } } },
		)
		const evidence = widget(container, 'evidence')
		expect(widget(container, 'plain').getAttribute('aria-expanded')).toBeNull()
		expect(evidence.getAttribute('aria-expanded')).toBe('false')
		expect(evidence.classList.contains('is-expanded')).toBe(false)
		expect(evidence.querySelector('svg.kit-btn__trailing')).not.toBeNull()
		await applyVariant(bridge, 'open')
		expect(evidence.getAttribute('aria-expanded')).toBe('true')
		expect(evidence.classList.contains('is-expanded')).toBe(true)
		expect(await declarations('.kit-btn.is-expanded .kit-btn__trailing')).toMatch(/transform: rotate\(180deg\)/)
		expect(await declarations('.kit-btn .kit-btn__trailing')).toMatch(/transition: transform/)
		bridge.dispose()
	})

	it('stands still under prefers-reduced-motion', async () => {
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.kit-btn \.kit-btn__trailing \{\s*transition: none;/)
	})
})

describe('a legible mono face', () => {
	it('declares the slashed zero once, as a token of the mono face', async () => {
		expect(await readFile(join(KIT, 'src', 'tokens', 'tokens.css'), 'utf8')).toMatch(/--kit-font-mono-features:\s*"zero" 1;/)
	})

	it('puts the key cap and the mono chip in it, so a capital O and a 0 differ', async () => {
		expect(await declarations('.kit-kbd')).toMatch(/font-family: var\(--kit-font-mono\);\s*font-feature-settings: var\(--kit-font-mono-features\)/)
		expect(await declarations('.kit-badge.kit-badge--mono')).toMatch(/font-feature-settings: var\(--kit-font-mono-features\)/)
	})

	it('has no Kit rule that sets the mono family without it', async () => {
		const files = [
			...(await readdir(join(KIT, 'src', 'ui'))).filter(name => name.endsWith('.vue')).map(name => join(KIT, 'src', 'ui', name)),
			join(KIT, 'adapters', 'reference.css'),
		]
		const bare: string[] = []
		for (const file of files) {
			const source = await readFile(file, 'utf8')
			for (const [, block] of source.matchAll(/\{([^{}]*font-family:\s*var\(--kit-font-mono\)[^{}]*)\}/g)) {
				if (!block!.includes('font-feature-settings: var(--kit-font-mono-features)')) bare.push(`${file.slice(process.cwd().length + 1)}: ${block!.trim().slice(0, 60)}`)
			}
		}
		expect(bare).toEqual([])
	})
})
