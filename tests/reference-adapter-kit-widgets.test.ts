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
 * The Widgets of the phase-5 Kit batch (Discussion #379 owner decisions of 2026-10-29, issue #380), run from
 * the dogfood kit build output `.uiux/kit/dist/uiux.js` (built by the global setup): Icon, Skeleton, ListItem,
 * Checkbox, Select and SelectOption, Disclosure, CodeBlock, Table and TableRow, DiffItem, Breadcrumb and
 * BreadcrumbItem (Kit components), GraphCanvas and Image (Adapter only), and the extensions of Stack, Alert,
 * Badge and TextInput. As in `reference-adapter-widgets.test.ts`, the Kit components are exercised through
 * their Widget wrappers, since the tests load no `.vue` file.
 */

const ADAPTER = join(process.cwd(), '.uiux', 'kit', 'dist', 'uiux.js')
const VIEW_ID = '12345678-1234-4234-8234-123456789abc'
const CONTEXT: ResolvedRenderContext = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }

type Widget = Readonly<{ type: string; id: string; config?: Record<string, unknown>; slots?: Record<string, readonly Widget[]> }>

async function mount(widgets: readonly Widget[], locales?: Record<string, Record<string, string>>): Promise<Readonly<{ container: HTMLElement; bridge: PreviewRuntimeBridge }>> {
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
		name: 'Phase 5 Kit widgets',
		ir: { type: 'RootShell', id: 'root', slots: { content: widgets } } as never,
		variants: {},
		spec: { intent: 'Phase 5 Kit widgets', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
	let status: unknown
	const bridge = factory.mountPreviewRuntime(container, { view, context: CONTEXT, onStatusChange: (next) => { status = next }, ...(locales ? { locales: locales as never } : {}) })
	expect(status).toMatchObject({ status: 'ready' })
	return { container, bridge }
}

const widget = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const click = (element: Element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never)
const key = (element: Element, name: string) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }) as never)
const events = (bridge: PreviewRuntimeBridge) => bridge.interactionProbe!().occurrences().map(({ widgetId, name }) => `${widgetId}:${name}`)

describe('the catalog of the phase-5 Widgets', () => {
	it('registers every new Widget with a plugin, a renderer and a Catalog entry, Image with an image Asset field', async () => {
		const manifest = extractProductAdapterManifest(await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>)
		const ownership = await productAdapterRegistryInspector.inspect(manifest)
		const types = ['Icon', 'Skeleton', 'ListItem', 'Checkbox', 'Select', 'SelectOption', 'Disclosure', 'CodeBlock', 'Table', 'TableRow', 'DiffItem', 'Breadcrumb', 'BreadcrumbItem', 'GraphCanvas', 'Image', 'Menu', 'MenuItem', 'MenuLabel', 'Tooltip', 'Sheet', 'RadioGroup', 'Radio', 'FileInput', 'NumberField', 'Progress']
		expect(ownership.widgetTypes).toEqual(expect.arrayContaining(types))
		expect(ownership.rendererKeys).toEqual(expect.arrayContaining(types))
		for (const type of types) expect(manifest.catalog.widgets, type).toHaveProperty(type)
		expect(manifest.catalog.widgets.Image?.assetFields).toEqual({ source: { acceptedCategories: ['image'] } })
		expect(Object.keys(manifest.catalog.widgets.Select?.i18n?.fields ?? {})).toEqual(['label', 'help', 'placeholder', 'value', 'searchPlaceholder'])
		// The Widgets whose text interpolates {value}, {value2} and {value3} map each parameter to its Property (Select and TextInput, whose own `value` is content, take them from `argument`).
		for (const [type, field] of [['TextInput', 'label'], ['Checkbox', 'description'], ['Select', 'help'], ['SelectOption', 'label'], ['CodeBlock', 'label'], ['Menu', 'label'], ['MenuItem', 'label'], ['MenuItem', 'description'], ['MenuLabel', 'label'], ['MenuLabel', 'description'], ['Radio', 'label'], ['Radio', 'description'], ['Tooltip', 'text']] as const) {
			expect(manifest.catalog.widgets[type]?.i18n?.fields[field]?.params, `${type}.${field}`).toEqual({ value: 'valueText', value2: 'value2Text', value3: 'value3Text' })
		}
		expect(Object.keys(manifest.catalog.widgets.GraphCanvas?.i18n?.fields ?? {})).toEqual(['label', 'entryLabel', 'endLabel', 'unreachableLabel', 'baseLabel', 'problemsLabel'])
		expect(Object.keys(manifest.catalog.widgets.Alert?.i18n?.fields ?? {})).toContain('dismissLabel')
		// Sheet and Progress interpolate the same parameters; the form controls name plain fields.
		for (const [type, field] of [['Sheet', 'title'], ['Sheet', 'description'], ['Progress', 'label']] as const) {
			expect(manifest.catalog.widgets[type]?.i18n?.fields[field]?.params, `${type}.${field}`).toEqual({ value: 'valueText', value2: 'value2Text', value3: 'value3Text' })
		}
		expect(Object.keys(manifest.catalog.widgets.FileInput?.i18n?.fields ?? {})).toEqual(['title', 'description', 'removeLabel', 'error'])
		expect(Object.keys(manifest.catalog.widgets.NumberField?.i18n?.fields ?? {})).toEqual(['label', 'help', 'error', 'roleDescription'])
	})

	it('translates a lowered `<field>Key` through the Locale, as every other Widget does', async () => {
		const { container, bridge } = await mount(
			[{ type: 'Checkbox', id: 'agree', config: { labelKey: 'agree.label', descriptionKey: 'agree.desc', description: 'literal' } }],
			{ 'en-US': { 'agree.label': 'I agree', 'agree.desc': 'Read the terms first' } },
		)
		const root = widget(container, 'agree')
		expect(root.textContent).toContain('I agree')
		expect(root.textContent).toContain('Read the terms first')
		expect(root.textContent).not.toContain('literal')
		bridge.dispose()
	})
})

describe('the Icon Widget (Kit Icon)', () => {
	it('renders the named icon at its size and tone, decorative without a label', async () => {
		const { container, bridge } = await mount([{ type: 'Icon', id: 'flag', config: { name: 'flag', size: 20, tone: 'primary' } }])
		const root = widget(container, 'flag')
		expect(root.classList.contains('tone-primary')).toBe(true)
		expect(root.getAttribute('aria-hidden')).toBe('true')
		expect(root.hasAttribute('role')).toBe(false)
		const svg = root.querySelector('svg')!
		expect(svg.getAttribute('width')).toBe('20')
		expect(svg.getAttribute('height')).toBe('20')
		bridge.dispose()
	})

	it('is an image with an accessible name once it has a label, and renders an unknown name as literal text', async () => {
		const { container, bridge } = await mount([
			{ type: 'Icon', id: 'lock', config: { name: 'lock', label: 'Locked' } },
			{ type: 'Icon', id: 'glyph', config: { name: '★' } },
		])
		const lock = widget(container, 'lock')
		expect(lock.getAttribute('role')).toBe('img')
		expect(lock.getAttribute('aria-label')).toBe('Locked')
		expect(lock.hasAttribute('aria-hidden')).toBe(false)
		expect(widget(container, 'glyph').querySelector('svg')).toBeNull()
		expect(widget(container, 'glyph').textContent).toBe('★')
		bridge.dispose()
	})

	it('has every Lucide icon the phase-5 batch added to the Kit set', async () => {
		const names = ['flag', 'play', 'arrow-right', 'folder', 'folder-open', 'file', 'list', 'save', 'trash-2', 'columns-2', 'lock', 'git-compare-arrows', 'step-forward', 'arrow-up', 'arrow-down', 'loader-circle', 'diff', 'minus']
		const { container, bridge } = await mount(names.map(name => ({ type: 'Icon', id: `i-${name}`, config: { name } })))
		for (const name of names) expect(widget(container, `i-${name}`).querySelector('svg'), name).not.toBeNull()
		bridge.dispose()
	})
})

describe('the Skeleton Widget (Kit Skeleton)', () => {
	it('takes its width, height and radius, with numbers as px', async () => {
		const { container, bridge } = await mount([{ type: 'Skeleton', id: 'line', config: { width: 120, height: '1.5rem', radius: 8 } }])
		const root = widget(container, 'line')
		expect(root.classList.contains('kit-skeleton')).toBe(true)
		expect(root.style.width).toBe('120px')
		expect(root.style.height).toBe('1.5rem')
		expect(root.style.borderRadius).toBe('8px')
		bridge.dispose()
	})

	it('is a busy status region with a label, and hidden from assistive technology without one', async () => {
		const { container, bridge } = await mount([
			{ type: 'Skeleton', id: 'named', config: { label: 'Loading versions' } },
			{ type: 'Skeleton', id: 'plain' },
		])
		const named = widget(container, 'named')
		expect(named.getAttribute('role')).toBe('status')
		expect(named.getAttribute('aria-busy')).toBe('true')
		expect(named.getAttribute('aria-label')).toBe('Loading versions')
		const plain = widget(container, 'plain')
		expect(plain.getAttribute('aria-hidden')).toBe('true')
		expect(plain.hasAttribute('role')).toBe(false)
		bridge.dispose()
	})
})

describe('the ListItem Widget (Kit ListItem)', () => {
	const row: Widget = {
		type: 'ListItem',
		id: 'row',
		config: { interactive: true, selected: true, level: 2, divided: true },
		slots: {
			leading: [{ type: 'Icon', id: 'lead', config: { name: 'folder' } }],
			content: [{ type: 'Text', id: 'name', config: { text: 'Checkout' } }],
			trailing: [{ type: 'Badge', id: 'count', config: { label: '3', variant: 'count' } }],
		},
	}

	it('lays out its three slots and reflects selection, indent and the divider', async () => {
		const { container, bridge } = await mount([row])
		const root = widget(container, 'row')
		expect(root.querySelector('.kit-list-item__leading [data-widget-id="lead"]')).not.toBeNull()
		expect(root.querySelector('.kit-list-item__content [data-widget-id="name"]')).not.toBeNull()
		expect(root.querySelector('.kit-list-item__trailing [data-widget-id="count"]')).not.toBeNull()
		expect(root.classList.contains('is-selected')).toBe(true)
		expect(root.classList.contains('is-divided')).toBe(true)
		expect(root.getAttribute('aria-current')).toBe('true')
		expect(root.style.getPropertyValue('--kit-list-item-level')).toBe('2')
		bridge.dispose()
	})

	it('is one button-like target when interactive: it reports the press and Enter, and a plain row reports nothing', async () => {
		const { container, bridge } = await mount([row, { type: 'ListItem', id: 'plain', config: { dimmed: true } }])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('row', 'click')).toBe(true)
		expect(probe.watch('plain', 'click')).toBe(true)
		const root = widget(container, 'row')
		expect(root.getAttribute('role')).toBe('button')
		expect(root.getAttribute('tabindex')).toBe('0')
		click(root)
		key(root, 'Enter')
		click(widget(container, 'plain'))
		expect(events(bridge)).toEqual(['row:click', 'row:click'])
		const plain = widget(container, 'plain')
		expect(plain.hasAttribute('role')).toBe(false)
		expect(plain.hasAttribute('tabindex')).toBe(false)
		expect(plain.classList.contains('is-dimmed')).toBe(true)
		bridge.dispose()
	})
})

describe('the Checkbox Widget (Kit Checkbox)', () => {
	it('is a native checkbox named by its label and described by its description, with the meta at the end', async () => {
		const { container, bridge } = await mount([{ type: 'Checkbox', id: 'cb', config: { label: 'Keep draft', description: 'Stays on this host', meta: 'v3' } }])
		const root = widget(container, 'cb')
		const input = root.querySelector('input')!
		expect(input.getAttribute('type')).toBe('checkbox')
		expect(root.querySelector(`#${input.getAttribute('aria-labelledby')}`)!.textContent).toBe('Keep draft')
		expect(root.querySelector(`#${input.getAttribute('aria-describedby')}`)!.textContent).toBe('Stays on this host')
		expect(root.querySelector('.kit-checkbox__meta')!.textContent).toBe('v3')
		expect(input.hasAttribute('data-widget-id')).toBe(false)
		bridge.dispose()
	})

	it('writes `checked` and reports `toggle` on a change, and does nothing while disabled', async () => {
		const { container, bridge } = await mount([
			{ type: 'Checkbox', id: 'on', config: { label: 'A' } },
			{ type: 'Checkbox', id: 'off', config: { label: 'B', disabled: true } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('on', 'toggle')).toBe(true)
		expect(probe.watch('off', 'toggle')).toBe(true)
		const input = widget(container, 'on').querySelector('input')!
		input.checked = true
		input.dispatchEvent(new window.Event('change', { bubbles: true }) as never)
		await tick()
		expect(probe.readState('on', 'checked')).toEqual({ found: true, value: true })
		expect(input.checked).toBe(true)
		const disabled = widget(container, 'off').querySelector('input')!
		expect(disabled.hasAttribute('disabled')).toBe(true)
		disabled.checked = true
		disabled.dispatchEvent(new window.Event('change', { bubbles: true }) as never)
		await tick()
		expect(probe.readState('off', 'checked')).toEqual({ found: true, value: false })
		expect(disabled.checked).toBe(false)
		expect(events(bridge)).toEqual(['on:toggle'])
		bridge.dispose()
	})

	it('shows the mixed state, and a press clears it', async () => {
		const { container, bridge } = await mount([{ type: 'Checkbox', id: 'mixed', config: { label: 'All', indeterminate: true } }])
		const probe = bridge.interactionProbe!()
		const input = widget(container, 'mixed').querySelector('input')!
		expect(input.indeterminate).toBe(true)
		input.checked = true
		input.dispatchEvent(new window.Event('change', { bubbles: true }) as never)
		await tick()
		expect(probe.readState('mixed', 'indeterminate')).toEqual({ found: true, value: false })
		expect(input.indeterminate).toBe(false)
		bridge.dispose()
	})

	it('gives a warning description an icon, so color is not the only signal', async () => {
		const { container, bridge } = await mount([
			{ type: 'Checkbox', id: 'warn', config: { label: 'A', description: 'Replaces the file', descriptionTone: 'warning' } },
			{ type: 'Checkbox', id: 'calm', config: { label: 'B', description: 'Optional' } },
		])
		const warn = widget(container, 'warn').querySelector('.kit-checkbox__description')!
		expect(warn.classList.contains('is-warning')).toBe(true)
		expect(warn.querySelector('svg')).not.toBeNull()
		const calm = widget(container, 'calm').querySelector('.kit-checkbox__description')!
		expect(calm.classList.contains('is-muted')).toBe(true)
		expect(calm.querySelector('svg')).toBeNull()
		bridge.dispose()
	})
})

describe('the Select Widget (Kit Select)', () => {
	const options = [
		{ type: 'SelectOption', id: 'a', config: { label: 'Alpha', selected: true } },
		{ type: 'SelectOption', id: 'b', config: { label: 'Beta', disabled: true } },
	]

	it('is a labelled select-only combobox showing its placeholder until it has a value', async () => {
		const { container, bridge } = await mount([{ type: 'Select', id: 'sel', config: { label: 'Domain', help: 'Pick one', placeholder: 'Choose', required: true, invalid: true }, slots: { options } }])
		const root = widget(container, 'sel')
		const trigger = root.querySelector('button')!
		expect(trigger.getAttribute('role')).toBe('combobox')
		expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		expect(trigger.getAttribute('aria-required')).toBe('true')
		expect(trigger.getAttribute('aria-invalid')).toBe('true')
		expect(root.querySelector(`#${trigger.getAttribute('aria-labelledby')}`)!.textContent).toBe('Domain')
		expect(root.querySelector('label')!.classList.contains('is-required')).toBe(true)
		expect(root.querySelector(`#${trigger.getAttribute('aria-describedby')}`)!.textContent).toBe('Pick one')
		const value = root.querySelector('.kit-select__value')!
		expect(value.textContent).toBe('Choose')
		expect(value.classList.contains('is-placeholder')).toBe(true)
		expect(root.querySelector('[role="listbox"]')).toBeNull()
		bridge.dispose()
	})

	it('shows its SelectOption children as a listbox panel while open', async () => {
		const { container, bridge } = await mount([{ type: 'Select', id: 'sel', config: { label: 'Domain', open: true, value: 'Alpha' }, slots: { options } }])
		const root = widget(container, 'sel')
		const trigger = root.querySelector('button')!
		expect(trigger.getAttribute('aria-expanded')).toBe('true')
		const listbox = root.querySelector('[role="listbox"]')!
		expect(trigger.getAttribute('aria-controls')).toBe(listbox.getAttribute('id'))
		const rows = Array.from(listbox.querySelectorAll('[role="option"]'))
		expect(rows.map(row => row.textContent)).toEqual(['Alpha', 'Beta'])
		expect(rows.map(row => row.getAttribute('aria-selected'))).toEqual(['true', 'false'])
		expect(rows[0]!.querySelector('svg')).not.toBeNull()
		expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
		expect(root.querySelector('.kit-select__value')!.textContent).toBe('Alpha')
		bridge.dispose()
	})

	it('shows a multiple select\'s chosen values comma-joined, as the Workbench\'s own select does', async () => {
		const { container, bridge } = await mount([{ type: 'Select', id: 'sel', config: { label: 'Domains', multiple: true, open: true, value: ['Flows', 'History'] }, slots: { options } }])
		const root = widget(container, 'sel')
		expect(root.querySelector('.kit-select__value')!.textContent).toBe('Flows, History')
		expect(root.querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe('true')
		bridge.dispose()
	})

	it('opens and closes on the trigger, and closes on Escape, reporting each as `toggle`', async () => {
		const { container, bridge } = await mount([{ type: 'Select', id: 'sel', config: { label: 'Domain' }, slots: { options } }])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('sel', 'toggle')).toBe(true)
		const root = widget(container, 'sel')
		click(root.querySelector('button')!)
		await tick()
		expect(probe.readState('sel', 'open')).toEqual({ found: true, value: true })
		expect(root.querySelector('[role="listbox"]')).not.toBeNull()
		key(root.querySelector('button')!, 'Escape')
		await tick()
		expect(probe.readState('sel', 'open')).toEqual({ found: true, value: false })
		expect(root.querySelector('[role="listbox"]')).toBeNull()
		expect(events(bridge)).toEqual(['sel:toggle', 'sel:toggle'])
		bridge.dispose()
	})

	it('does not open while disabled, and a SelectOption reports its press unless it is disabled', async () => {
		const { container, bridge } = await mount([
			{ type: 'Select', id: 'locked', config: { label: 'A', disabled: true } },
			{ type: 'Select', id: 'sel', config: { label: 'B', open: true }, slots: { options } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('locked', 'toggle')).toBe(true)
		expect(probe.watch('a', 'click')).toBe(true)
		expect(probe.watch('b', 'click')).toBe(true)
		const locked = widget(container, 'locked').querySelector('button')!
		expect(locked.hasAttribute('disabled')).toBe(true)
		click(locked)
		click(widget(container, 'a'))
		click(widget(container, 'b'))
		key(widget(container, 'a'), 'Enter')
		expect(events(bridge)).toEqual(['a:click', 'a:click'])
		bridge.dispose()
	})
})

describe('the Disclosure Widget (Kit Disclosure)', () => {
	const content = [{ type: 'Text', id: 'body', config: { text: 'Details' } }]

	it('keeps its content in the document while closed, hidden, and shows it while open', async () => {
		const { container, bridge } = await mount([
			{ type: 'Disclosure', id: 'closed', config: { label: 'Changes', meta: 4 }, slots: { content } },
			{ type: 'Disclosure', id: 'open', config: { label: 'Open one', open: true }, slots: { content: [{ type: 'Text', id: 'body2', config: { text: 'More' } }] } },
		])
		const closed = widget(container, 'closed')
		const header = closed.querySelector('button')!
		expect(header.getAttribute('aria-expanded')).toBe('false')
		expect(closed.querySelector('.kit-disclosure__trailing')!.textContent).toBe('4')
		const region = closed.querySelector('[role="region"]') as HTMLElement
		expect(header.getAttribute('aria-controls')).toBe(region.getAttribute('id'))
		expect(region.style.display).toBe('none')
		expect(region.querySelector('[data-widget-id="body"]')).not.toBeNull()
		const open = widget(container, 'open')
		expect(open.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
		expect((open.querySelector('[role="region"]') as HTMLElement).style.display).not.toBe('none')
		bridge.dispose()
	})

	it('writes `open` and reports `toggle` when the header is pressed', async () => {
		const { container, bridge } = await mount([{ type: 'Disclosure', id: 'd', config: { label: 'Changes' }, slots: { content } }])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('d', 'toggle')).toBe(true)
		click(widget(container, 'd').querySelector('button')!)
		await tick()
		expect(probe.readState('d', 'open')).toEqual({ found: true, value: true })
		expect(widget(container, 'd').querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
		expect(events(bridge)).toEqual(['d:toggle'])
		bridge.dispose()
	})
})

describe('the CodeBlock Widget (Kit CodeBlock)', () => {
	it('shows the code literally in a focusable mono block, named once it has a label', async () => {
		const code = '{\n  "a": "<b>&amp;</b>"\n}'
		const { container, bridge } = await mount([{ type: 'CodeBlock', id: 'code', config: { code, label: 'Request body', maxHeight: 120, wrap: true } }])
		const root = widget(container, 'code')
		expect(root.tagName).toBe('PRE')
		expect(root.textContent).toBe(code)
		expect(root.querySelector('b')).toBeNull()
		expect(root.getAttribute('role')).toBe('region')
		expect(root.getAttribute('aria-label')).toBe('Request body')
		expect(root.getAttribute('tabindex')).toBe('0')
		expect(root.getAttribute('translate')).toBe('no')
		expect(root.style.maxHeight).toBe('120px')
		expect(root.classList.contains('is-wrap')).toBe(true)
		bridge.dispose()
	})
})

describe('the Table and TableRow Widgets (Kit Table, TableRow)', () => {
	it('lines the cells of every row up on the table\'s column grid, with a header and a selected row', async () => {
		const cell = (id: string, text: string): Widget => ({ type: 'Text', id, config: { text } })
		const { container, bridge } = await mount([{
			type: 'Table',
			id: 'table',
			config: { columns: '2fr 1fr 80px', label: 'Versions' },
			slots: {
				rows: [
					{ type: 'TableRow', id: 'head', config: { header: true }, slots: { cells: [cell('h1', 'Name'), cell('h2', 'Kind'), cell('h3', 'Size')] } },
					{ type: 'TableRow', id: 'r1', config: { selected: true }, slots: { cells: [cell('c1', 'Checkout'), cell('c2', 'View'), cell('c3', '12')] } },
				],
			},
		}])
		const table = widget(container, 'table')
		expect(table.getAttribute('role')).toBe('list')
		expect(table.getAttribute('aria-label')).toBe('Versions')
		expect(table.style.getPropertyValue('--kit-table-columns')).toBe('2fr 1fr 80px')
		const head = widget(container, 'head')
		expect(head.classList.contains('is-header')).toBe(true)
		expect(head.getAttribute('role')).toBe('listitem')
		expect(Array.from(head.children).map(child => child.textContent)).toEqual(['Name', 'Kind', 'Size'])
		const row = widget(container, 'r1')
		expect(row.classList.contains('is-selected')).toBe(true)
		expect(row.getAttribute('aria-current')).toBe('true')
		expect(head.hasAttribute('aria-current')).toBe(false)
		bridge.dispose()
	})
})

describe('the DiffItem Widget (Kit DiffItem)', () => {
	it('shows the operation with its words, the field, the changed thing as mono text, and a struck and inserted value', async () => {
		const { container, bridge } = await mount([{ type: 'DiffItem', id: 'diff', config: { op: 'changed', opLabel: 'Changed', field: 'Name', label: 'views/checkout', before: 'Cart', after: 'Checkout' } }])
		const root = widget(container, 'diff')
		expect(root.classList.contains('kit-diff-item--changed')).toBe(true)
		expect(root.getAttribute('data-op')).toBe('changed')
		expect(root.querySelector('.kit-diff-item__op')!.textContent).toBe('Changed')
		expect(root.querySelector('.kit-diff-item__field')!.textContent).toBe('Name')
		const label = root.querySelector('code')!
		expect(label.textContent).toBe('views/checkout')
		expect(label.getAttribute('translate')).toBe('no')
		expect(root.querySelector('del')!.textContent).toBe('Cart')
		expect(root.querySelector('ins')!.textContent).toBe('Checkout')
		bridge.dispose()
	})

	it('picks an icon and a tone for each operation', async () => {
		const ops = ['added', 'removed', 'changed', 'moved']
		const { container, bridge } = await mount(ops.map(op => ({ type: 'DiffItem', id: op, config: { op, opLabel: op } })))
		for (const op of ops) {
			const root = widget(container, op)
			expect(root.classList.contains(`kit-diff-item--${op}`), op).toBe(true)
			expect(root.querySelector('.kit-diff-item__head svg'), op).not.toBeNull()
		}
		bridge.dispose()
	})

	it('lists finer changes with their values, reading each operation to assistive technology', async () => {
		const { container, bridge } = await mount([{
			type: 'DiffItem',
			id: 'diff',
			config: {
				op: 'changed',
				label: 'Widget #pay',
				changes: [
					{ label: '/config/label', before: 'Pay', after: 'Pay now', opLabel: 'Changed' },
					{ label: '/config/icon', after: 'lock', opLabel: 'Added' },
				],
			},
		}])
		const items = Array.from(widget(container, 'diff').querySelectorAll('.kit-diff-item__changes li'))
		expect(items).toHaveLength(2)
		expect(items[0]!.textContent).toContain('/config/label')
		expect(items[0]!.querySelector('del')!.textContent).toBe('Pay')
		expect(items[0]!.querySelector('ins')!.textContent).toBe('Pay now')
		expect(items[0]!.querySelector('.kit-diff-item__sr')!.textContent).toBe('Changed')
		expect(items[1]!.querySelector('del')).toBeNull()
		expect(items[1]!.querySelector('ins')!.textContent).toBe('lock')
		bridge.dispose()
	})
})

describe('the Breadcrumb and BreadcrumbItem Widgets (Kit Breadcrumb, BreadcrumbItem)', () => {
	it('is a named navigation landmark with one list item per step, the last marked as the current step', async () => {
		const { container, bridge } = await mount([{
			type: 'Breadcrumb',
			id: 'path',
			config: { label: 'Flow path' },
			slots: {
				items: [
					{ type: 'BreadcrumbItem', id: 's1', config: { index: 1, variant: 'Base', label: 'Cart' } },
					{ type: 'BreadcrumbItem', id: 's2', config: { index: 2, variant: 'Empty', label: 'Checkout', trailing: 'from Workbench', icon: 'step-forward', current: true } },
				],
			},
		}])
		const nav = widget(container, 'path')
		expect(nav.tagName).toBe('NAV')
		expect(nav.getAttribute('aria-label')).toBe('Flow path')
		expect(nav.querySelector('ol')!.children).toHaveLength(2)
		const first = widget(container, 's1')
		expect(first.tagName).toBe('LI')
		expect(first.querySelector('.kit-breadcrumb-item__index')!.textContent).toBe('1')
		expect(first.querySelector('.kit-breadcrumb-item__variant')!.textContent).toBe('Base')
		expect(first.querySelector('.kit-breadcrumb-item__label')!.textContent).toBe('Cart')
		expect(first.hasAttribute('aria-current')).toBe(false)
		const current = widget(container, 's2')
		expect(current.getAttribute('aria-current')).toBe('step')
		expect(current.classList.contains('is-current')).toBe(true)
		expect(current.querySelector('.kit-breadcrumb-item__trailing')!.textContent).toBe('from Workbench')
		expect(current.querySelector('svg')).not.toBeNull()
		bridge.dispose()
	})
})

describe('the GraphCanvas Widget', () => {
	const config = {
		label: 'Flow graph',
		entryLabel: 'Entry',
		endLabel: 'End',
		unreachableLabel: 'Unreachable',
		baseLabel: 'Base',
		problemsLabel: 'Problems',
		nodes: [
			{ key: 'a', label: 'Cart', entry: true, col: 0, row: 0.5 },
			{ key: 'b', label: 'Checkout', variantName: 'Empty', col: 1, row: 0, problems: 2 },
			{ key: 'c', label: 'Receipt', terminal: true, col: 2, row: 0 },
			{ key: 'd', label: 'Orphan', unreachable: true, col: 3, row: 0 },
		],
		edges: [
			{ from: 'a', to: 'b', trigger: 'pay#click' },
			{ from: 'b', to: 'c', trigger: 'confirm#click', tone: 'problem' },
			{ from: 'c', to: 'a', trigger: 'again#click' },
			{ from: 'b', to: 'b', trigger: 'retry#click' },
			{ from: 'c', to: 'gone', trigger: 'next#click' },
		],
	}
	const node = (container: HTMLElement, graphKey: string) => container.querySelector<HTMLElement>(`[data-graph-node="${graphKey}"]`)!

	it('places the nodes on the column and row grid and sizes the canvas to them', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config }])
		const root = widget(container, 'graph')
		const surface = root.querySelector<HTMLElement>('[role="group"]')!
		expect(surface.getAttribute('aria-label')).toBe('Flow graph')
		// 4 columns of 216 with 192 gaps and 48 padding each side; the lowest node ends at 88 + 0.5 * (76 + 48) + 76, then 48 padding and 56 for back edges.
		expect(surface.style.width).toBe(`${48 * 2 + 4 * 216 + 3 * 192}px`)
		expect(surface.style.height).toBe(`${88 + 0.5 * (76 + 48) + 76 + 48 + 56}px`)
		expect(node(container, 'a').style.left).toBe('48px')
		expect(node(container, 'a').style.top).toBe(`${88 + 0.5 * (76 + 48)}px`)
		expect(node(container, 'b').style.left).toBe(`${48 + 216 + 192}px`)
		expect(node(container, 'b').style.top).toBe('88px')
		expect(node(container, 'b').style.width).toBe('216px')
		expect(node(container, 'b').style.height).toBe('76px')
		bridge.dispose()
	})

	it('draws every edge with an arrow, a problem edge dashed, a dangling edge without one, and a mono trigger label for each', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config }])
		const root = widget(container, 'graph')
		const paths = Array.from(root.querySelectorAll('.uiux-ref-graph-edge'))
		expect(paths).toHaveLength(5)
		expect(paths[1]!.classList.contains('is-problem')).toBe(true)
		expect(paths[0]!.getAttribute('marker-end')).toContain('arrow-rest')
		expect(paths[1]!.getAttribute('marker-end')).toContain('arrow-problem')
		expect(paths[4]!.hasAttribute('marker-end')).toBe(false)
		const labels = Array.from(root.querySelectorAll<HTMLElement>('.uiux-ref-graph-edge-label'))
		expect(labels.map(label => label.textContent)).toEqual(['pay#click', 'confirm#click', 'again#click', 'retry#click', 'next#click'])
		expect(labels[0]!.getAttribute('aria-label')).toBe('pay#click → Checkout')
		expect(root.querySelectorAll('marker')).toHaveLength(3)
		bridge.dispose()
	})

	it('marks the entry, the variant or the base state, the problem count, the end and the unreachable step, in words', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config }])
		expect(node(container, 'a').querySelector('svg')).not.toBeNull()
		expect(node(container, 'a').getAttribute('aria-label')).toBe('Cart, Base, Entry')
		expect(node(container, 'a').textContent).toContain('Base')
		expect(node(container, 'b').getAttribute('aria-label')).toBe('Checkout, Empty, Problems 2')
		expect(node(container, 'b').querySelector('.kit-badge--mono')!.textContent).toBe('Empty')
		expect(node(container, 'b').querySelector('.kit-badge--tone-danger')!.textContent).toBe('2')
		expect(node(container, 'c').getAttribute('aria-label')).toBe('Receipt, Base, End')
		expect(node(container, 'd').getAttribute('aria-label')).toBe('Orphan, Base, Unreachable')
		expect(node(container, 'd').classList.contains('is-unreachable')).toBe(true)
		bridge.dispose()
	})

	it('writes `selection` and reports `select` when a node or an edge label is chosen, and shows the selection', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config }])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('graph', 'select')).toBe(true)
		click(node(container, 'b'))
		await tick()
		expect(probe.readState('graph', 'selection')).toEqual({ found: true, value: 'b' })
		expect(node(container, 'b').classList.contains('is-selected')).toBe(true)
		expect(node(container, 'b').getAttribute('aria-pressed')).toBe('true')
		expect(node(container, 'a').getAttribute('aria-pressed')).toBe('false')
		click(container.querySelector('[data-graph-edge="0"]')!)
		await tick()
		expect(probe.readState('graph', 'selection')).toEqual({ found: true, value: 'edge:0' })
		expect(container.querySelector('[data-graph-edge="0"]')!.classList.contains('is-selected')).toBe(true)
		expect(container.querySelector('.uiux-ref-graph-edge.is-selected')).not.toBeNull()
		expect(node(container, 'b').classList.contains('is-selected')).toBe(false)
		expect(events(bridge)).toEqual(['graph:select', 'graph:select'])
		bridge.dispose()
	})

	it('keeps one tab stop, the selected node or else the first, and travels along edges with the arrow keys', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config: { ...config, selection: 'b' } }])
		const probe = bridge.interactionProbe!()
		expect(node(container, 'b').getAttribute('tabindex')).toBe('0')
		expect(node(container, 'a').getAttribute('tabindex')).toBe('-1')
		key(node(container, 'b'), 'ArrowRight')
		await tick()
		expect(probe.readState('graph', 'selection')).toEqual({ found: true, value: 'c' })
		key(node(container, 'c'), 'ArrowLeft')
		await tick()
		// `c` has the edges `c > a` and `b > c`; ArrowLeft goes to the first edge's source into `c`.
		expect(probe.readState('graph', 'selection')).toEqual({ found: true, value: 'b' })
		key(node(container, 'b'), 'Escape')
		await tick()
		expect(probe.readState('graph', 'selection')).toEqual({ found: true, value: '' })
		expect(node(container, 'a').getAttribute('tabindex')).toBe('0')
		bridge.dispose()
	})

	it('renders an empty graph, and ignores malformed nodes and edges', async () => {
		const { container, bridge } = await mount([{ type: 'GraphCanvas', id: 'graph', config: { nodes: [{ key: 'only', label: 'Only' }, { label: 'no key' }, { key: 'only', label: 'dup' }], edges: [{ from: 'nowhere', to: 'only' }, { from: 'only' }] } }])
		expect(container.querySelectorAll('[data-graph-node]')).toHaveLength(1)
		expect(container.querySelectorAll('.uiux-ref-graph-edge')).toHaveLength(0)
		bridge.dispose()
	})
})

describe('the Image Widget', () => {
	const source = { url: '/api/assets/49bd68d5-55ce-49c9-b342-a8cfbef4ce45/content', mediaType: 'image/svg+xml', contentDigest: 'sha256:abc' }

	it('renders the resolved Asset with its alternative text, size and fit', async () => {
		const { container, bridge } = await mount([{ type: 'Image', id: 'pic', config: { source, alt: 'Test icon', width: 64, height: '4rem', fit: 'cover', radius: 8 } }])
		const img = widget(container, 'pic')
		expect(img.tagName).toBe('IMG')
		expect(img.getAttribute('src')).toBe(source.url)
		expect(img.getAttribute('alt')).toBe('Test icon')
		expect(img.getAttribute('data-media-type')).toBe('image/svg+xml')
		expect(img.getAttribute('data-content-digest')).toBe('sha256:abc')
		expect(img.style.width).toBe('64px')
		expect(img.style.height).toBe('4rem')
		expect(img.style.objectFit).toBe('cover')
		expect(img.style.borderRadius).toBe('8px')
		bridge.dispose()
	})

	it('is decorative with an empty alternative text, and a dashed placeholder without a resolved source', async () => {
		const { container, bridge } = await mount([
			{ type: 'Image', id: 'decor', config: { source } },
			{ type: 'Image', id: 'none', config: { alt: 'Missing picture' } },
			{ type: 'Image', id: 'quiet' },
		])
		expect(widget(container, 'decor').getAttribute('alt')).toBe('')
		const none = widget(container, 'none')
		expect(none.tagName).toBe('SPAN')
		expect(none.classList.contains('is-empty')).toBe(true)
		expect(none.getAttribute('role')).toBe('img')
		expect(none.getAttribute('aria-label')).toBe('Missing picture')
		expect(widget(container, 'quiet').getAttribute('aria-hidden')).toBe('true')
		bridge.dispose()
	})
})

describe('the extensions of Stack, Alert, Badge and TextInput', () => {
	it('outlines a Stack as an added, removed, modified or moved region', async () => {
		const outlines = ['added', 'removed', 'modified', 'moved']
		const { container, bridge } = await mount([
			...outlines.map(outline => ({ type: 'Stack', id: `s-${outline}`, config: { outline } })),
			{ type: 'Stack', id: 's-plain' },
		])
		for (const outline of outlines) expect(widget(container, `s-${outline}`).classList.contains(`is-outline-${outline}`), outline).toBe(true)
		expect(Array.from(widget(container, 's-plain').classList).some(name => name.startsWith('is-outline-'))).toBe(false)
		bridge.dispose()
	})

	it('adds a dismiss button to a dismissible Alert, which hides it and reports `dismiss`', async () => {
		const { container, bridge } = await mount([
			{ type: 'Alert', id: 'alert', config: { tone: 'info', title: 'Saved', dismissible: true, dismissLabel: 'Close alert' } },
			{ type: 'Alert', id: 'sticky', config: { title: 'Pinned' } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('alert', 'dismiss')).toBe(true)
		expect(widget(container, 'sticky').querySelector('button')).toBeNull()
		const button = widget(container, 'alert').querySelector('button')!
		expect(button.getAttribute('aria-label')).toBe('Close alert')
		click(button)
		await tick()
		expect(probe.readState('alert', 'visible')).toEqual({ found: true, value: false })
		expect(widget(container, 'alert').classList.contains('uiux-ref-hidden')).toBe(true)
		expect(events(bridge)).toEqual(['alert:dismiss'])
		bridge.dispose()
	})

	it('spins the icon of a Badge', async () => {
		const { container, bridge } = await mount([
			{ type: 'Badge', id: 'busy', config: { label: 'Capturing', icon: 'loader-circle', spin: true } },
			{ type: 'Badge', id: 'idle', config: { label: 'Idle', icon: 'loader-circle' } },
		])
		expect(widget(container, 'busy').classList.contains('is-spin')).toBe(true)
		expect(widget(container, 'idle').classList.contains('is-spin')).toBe(false)
		bridge.dispose()
	})

	it('marks a required TextInput: the label asterisk and aria-required', async () => {
		const { container, bridge } = await mount([
			{ type: 'TextInput', id: 'req', config: { label: 'Name', required: true } },
			{ type: 'TextInput', id: 'opt', config: { label: 'Note' } },
		])
		expect(widget(container, 'req').querySelector('label')!.classList.contains('is-required')).toBe(true)
		expect(widget(container, 'req').querySelector('input')!.getAttribute('aria-required')).toBe('true')
		expect(widget(container, 'opt').querySelector('label')!.classList.contains('is-required')).toBe(false)
		expect(widget(container, 'opt').querySelector('input')!.hasAttribute('aria-required')).toBe(false)
		bridge.dispose()
	})
})
