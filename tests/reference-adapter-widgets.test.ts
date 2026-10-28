// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

import { extractProductAdapterManifest, productAdapterRegistryInspector } from '../src/adapters/product-integration'
import { createStandalonePreviewMount, type PreviewRuntimeBridge } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

/**
 * The reference Adapter's Widgets that wrap Kit components (Button, TextInput, Pin), run from the dogfood
 * kit build output `.uiux/kit/dist/uiux.js` (built by the global setup): what a Widget's Config and State
 * turn into in the DOM, and what a user's action in the DOM turns into (a Widget Event, a State write).
 * The Kit components themselves are exercised through these wrappers, since the tests load no `.vue` file.
 */

const ADAPTER = join(process.cwd(), '.uiux', 'kit', 'dist', 'uiux.js')
const VIEW_ID = '12345678-1234-4234-8234-123456789abc'
const CONTEXT: ResolvedRenderContext = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }

type Widget = Readonly<{ type: string; id: string; config?: Record<string, unknown> }>

async function mount(widgets: readonly Widget[]): Promise<Readonly<{ container: HTMLElement; bridge: PreviewRuntimeBridge }>> {
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
		name: 'Kit wrappers',
		ir: { type: 'RootShell', id: 'root', slots: { content: widgets } } as never,
		variants: {},
		spec: { intent: 'Kit wrappers', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
	let status: unknown
	const bridge = factory.mountPreviewRuntime(container, { view, context: CONTEXT, onStatusChange: (next) => { status = next } })
	expect(status).toMatchObject({ status: 'ready' })
	return { container, bridge }
}

const widget = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the Button Widget (Kit Button)', () => {
	it('renders the Kit button with its variant, size and label, and keeps the Widget id and theme on the root', async () => {
		const { container, bridge } = await mount([{ type: 'Button', id: 'save', config: { label: 'Save', variant: 'primary', size: 'lg' } }])
		const button = widget(container, 'save')
		expect(button.tagName).toBe('BUTTON')
		expect(button.getAttribute('type')).toBe('button')
		expect(button.classList.contains('kit-btn')).toBe(true)
		expect(button.classList.contains('kit-btn--primary')).toBe(true)
		expect(button.classList.contains('kit-btn--lg')).toBe(true)
		expect(button.classList.contains('uiux-theme-light')).toBe(true)
		expect(button.textContent).toBe('Save')
		bridge.dispose()
	})

	it('reports a click as the Widget Event, and not while it is disabled', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'enabled', config: { label: 'Go' } },
			{ type: 'Button', id: 'disabled', config: { label: 'Stop', disabled: true } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('enabled', 'click')).toBe(true)
		expect(probe.watch('disabled', 'click')).toBe(true)
		widget(container, 'enabled').dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never)
		widget(container, 'disabled').dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never)
		expect(widget(container, 'disabled').hasAttribute('disabled')).toBe(true)
		expect(probe.occurrences().map(({ widgetId, name }) => `${widgetId}:${name}`)).toEqual(['enabled:click'])
		bridge.dispose()
	})

	it('keeps the label as the accessible name of an icon-only button and shows no text', async () => {
		const { container, bridge } = await mount([{ type: 'Button', id: 'close', config: { label: 'Close', icon: 'x', iconOnly: true, variant: 'ghost' } }])
		const button = widget(container, 'close')
		expect(button.classList.contains('is-icon-only')).toBe(true)
		expect(button.getAttribute('aria-label')).toBe('Close')
		expect(button.getAttribute('title')).toBe('Close')
		expect(button.querySelector('svg')).not.toBeNull()
		expect(button.textContent).toBe('')
		bridge.dispose()
	})
})

describe('the TextInput Widget (Kit Field)', () => {
	it('labels the control, ties it to the label and to the help text, and keeps the Widget id on the root', async () => {
		const { container, bridge } = await mount([{ type: 'TextInput', id: 'name', config: { label: 'Name', help: 'As on the card', placeholder: 'Jane' } }])
		const root = widget(container, 'name')
		expect(root.tagName).toBe('DIV')
		expect(root.classList.contains('kit-field')).toBe(true)
		const input = root.querySelector('input')!
		const label = root.querySelector('label')!
		expect(label.getAttribute('for')).toBe('name-field')
		expect(input.getAttribute('id')).toBe('name-field')
		// Neither the Widget id nor the root's class leaks onto the control.
		expect(input.hasAttribute('data-widget-id')).toBe(false)
		const help = root.querySelector('.kit-field__help')!
		expect(help.textContent).toBe('As on the card')
		expect(input.getAttribute('aria-describedby')).toBe(help.getAttribute('id'))
		bridge.dispose()
	})

	it('describes the control by the error text, with an alert, while invalid', async () => {
		const { container, bridge } = await mount([{ type: 'TextInput', id: 'name', config: { label: 'Name', help: 'As on the card', error: 'Required', invalid: true } }])
		const root = widget(container, 'name')
		const input = root.querySelector('input')!
		const error = root.querySelector('.kit-field__error')!
		expect(error.getAttribute('role')).toBe('alert')
		expect(error.textContent).toContain('Required')
		expect(root.querySelector('.kit-field__help')).toBeNull()
		expect(input.getAttribute('aria-describedby')).toBe(error.getAttribute('id'))
		expect(input.getAttribute('aria-invalid')).toBe('true')
		bridge.dispose()
	})

	it('writes the typed text to the Widget State (update:modelValue), and a read-only field writes nothing', async () => {
		const { container, bridge } = await mount([
			{ type: 'TextInput', id: 'editable', config: { label: 'A' } },
			{ type: 'TextInput', id: 'locked', config: { label: 'B', value: 'fixed', readOnly: true } },
		])
		const probe = bridge.interactionProbe!()
		const type = async (id: string, text: string) => {
			const input = widget(container, id).querySelector('input')!
			input.value = text
			input.dispatchEvent(new window.Event('input', { bubbles: true }) as never)
			await tick()
		}
		await type('editable', 'hello')
		await type('locked', 'changed')
		expect(probe.readState('editable', 'value')).toEqual({ found: true, value: 'hello' })
		expect(probe.readState('locked', 'value')).toEqual({ found: true, value: 'fixed' })
		expect(widget(container, 'locked').querySelector('input')!.hasAttribute('readonly')).toBe(true)
		bridge.dispose()
	})

	it('renders a textarea for rows and takes its aria-label from the placeholder without a label', async () => {
		const { container, bridge } = await mount([{ type: 'TextInput', id: 'note', config: { placeholder: 'Write a note', rows: 3 } }])
		const area = widget(container, 'note').querySelector('textarea')!
		expect(area.getAttribute('rows')).toBe('3')
		expect(area.getAttribute('aria-label')).toBe('Write a note')
		expect(widget(container, 'note').querySelector('label')).toBeNull()
		bridge.dispose()
	})
})

describe('the Pin Widget (Kit CommentPin)', () => {
	it('reports its activation as the Widget Event click', async () => {
		const { container, bridge } = await mount([{ type: 'Pin', id: 'pin', config: { initials: 'ML', label: 'Comment by meilin', x: '10px', y: '20px' } }])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('pin', 'click')).toBe(true)
		const pin = widget(container, 'pin')
		expect(pin.getAttribute('aria-label')).toBe('Comment by meilin')
		expect(pin.textContent).toBe('ML')
		expect(pin.style.left).toBe('10px')
		expect(pin.style.top).toBe('20px')
		pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never)
		expect(probe.occurrences().map(({ widgetId, name }) => `${widgetId}:${name}`)).toEqual(['pin:click'])
		bridge.dispose()
	})

	it('maps its status to the Kit pin variant and badge, and its selection to the open ring', async () => {
		const { container, bridge } = await mount([
			{ type: 'Pin', id: 'ready', config: { initials: 'JS', status: 'ready', selected: true, label: 'Ready' } },
			{ type: 'Pin', id: 'done', config: { status: 'resolved', label: 'Done' } },
		])
		const ready = widget(container, 'ready')
		expect(ready.classList.contains('is-open')).toBe(true)
		expect(ready.getAttribute('aria-expanded')).toBe('true')
		expect(ready.querySelector('.kit-comment-pin__badge.is-ready')).not.toBeNull()
		const done = widget(container, 'done')
		expect(done.classList.contains('is-resolved')).toBe(true)
		expect(done.querySelector('svg')).not.toBeNull()
		bridge.dispose()
	})
})
