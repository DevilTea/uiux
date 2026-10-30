// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

import { extractProductAdapterManifest, productAdapterRegistryInspector } from '../src/adapters/product-integration'
import { createStandalonePreviewMount, type PreviewRuntimeBridge } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

/**
 * The Kit and Adapter fidelity batch of issue #394 (the phase-5 dogfood of Discussion #379): every new Widget
 * capability, run from the dogfood kit build output `.uiux/kit/dist/uiux.js` (built by the global setup) through
 * the Widget wrappers, since the tests load no `.vue` file. State-driven capabilities are exercised through a
 * Variant, which is how an author uses them.
 */

const KIT = join(process.cwd(), '.uiux', 'kit')
const ADAPTER = join(KIT, 'dist', 'uiux.js')
const VIEW_ID = '12345678-1234-4234-8234-123456789abc'
const CONTEXT: ResolvedRenderContext = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }

type Widget = Readonly<{ type: string; id: string; config?: Record<string, unknown>; slots?: Record<string, readonly Widget[]> }>
type Variants = Record<string, { state: Record<string, Record<string, unknown>> }>

async function mount(
	widgets: readonly Widget[],
	options: { locales?: Record<string, Record<string, string>>; variants?: Variants; context?: Partial<ResolvedRenderContext> } = {},
): Promise<Readonly<{ container: HTMLElement; bridge: PreviewRuntimeBridge }>> {
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
		name: 'Fidelity',
		ir: { type: 'RootShell', id: 'root', slots: { content: widgets } } as never,
		variants: (options.variants ?? {}) as never,
		spec: { intent: 'Fidelity', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
	let status: unknown
	const bridge = factory.mountPreviewRuntime(container, {
		view,
		context: { ...CONTEXT, ...options.context },
		onStatusChange: (next) => { status = next },
		...(options.locales ? { locales: options.locales as never } : {}),
	})
	expect(status).toMatchObject({ status: 'ready' })
	return { container, bridge }
}

const widget = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const click = (element: Element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never)
const events = (bridge: PreviewRuntimeBridge) => bridge.interactionProbe!().occurrences().map(({ widgetId, name }) => `${widgetId}:${name}`)
const hidden = (container: HTMLElement, id: string) => widget(container, id).classList.contains('uiux-ref-hidden')

async function applyVariant(bridge: PreviewRuntimeBridge, name: string): Promise<void> {
	expect(bridge.applyVariantStateLive!(name)).toEqual([])
	await tick()
}

describe('the icons the dogfood Views needed (issue #394)', () => {
	it('draws every Lucide icon of the fidelity batch, by its Lucide name, as an svg', async () => {
		const names = [
			'chevron-up', 'monitor', 'panel-right-open', 'link', 'file-code', 'user-lock', 'grip-vertical', 'file-warning', 'file-x', 'list-end', 'circle-dashed',
			'circle-help', 'arrow-left-right', 'file-pen-line', 'pencil', 'move', 'arrow-up-down', 'equal', 'scan-search', 'image-off',
		]
		const { container, bridge } = await mount(names.map(name => ({ type: 'Icon', id: `i-${name}`, config: { name } })))
		for (const name of names) expect(widget(container, `i-${name}`).querySelector('svg'), name).not.toBeNull()
		bridge.dispose()
	})
})

describe('the icons the Members and Access presets dogfood needed (issue #379, phase 5)', () => {
	it('draws every Lucide icon of the batch, by its Lucide name, as an svg', async () => {
		const names = ['user-plus', 'shield-alert', 'plug-zap', 'key-square', 'list-checks', 'user-minus', 'shield-check', 'user-round', 'user-cog', 'users', 'list-restart', 'copy-x']
		const { container, bridge } = await mount(names.map(name => ({ type: 'Icon', id: `i-${name}`, config: { name } })))
		for (const name of names) expect(widget(container, `i-${name}`).querySelector('svg'), name).not.toBeNull()
		bridge.dispose()
	})
})

describe('the Button (loading, link looks, solid neutral, disabled primary)', () => {
	it('shows a spinner instead of its icon while `loading`, is busy and disabled, and reports no click', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'save', config: { label: 'Save', icon: 'save', variant: 'primary', loading: true } },
			{ type: 'Button', id: 'idle', config: { label: 'Idle', icon: 'save' } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('save', 'click')).toBe(true)
		const button = widget(container, 'save')
		expect(button.classList.contains('is-loading')).toBe(true)
		expect(button.getAttribute('aria-busy')).toBe('true')
		expect(button.hasAttribute('disabled')).toBe(true)
		expect(button.querySelectorAll('svg')).toHaveLength(1)
		expect(button.querySelector('.kit-btn__spinner')).not.toBeNull()
		click(button)
		await tick()
		expect(events(bridge)).toEqual([])
		const idle = widget(container, 'idle')
		expect(idle.hasAttribute('aria-busy')).toBe(false)
		expect(idle.querySelector('.kit-btn__spinner')).toBeNull()
		bridge.dispose()
	})

	it('takes `loading` and `variant` as author-writable states, so a Variant switches them', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Button', id: 'go', config: { label: 'Go' } },
				{ type: 'Button', id: 'mode', config: { label: 'Side by side', variant: 'secondary' } },
			],
			{ variants: { current: { state: { go: { loading: true }, mode: { variant: 'neutral' } } } } },
		)
		expect(widget(container, 'go').classList.contains('is-loading')).toBe(false)
		expect(widget(container, 'mode').classList.contains('kit-btn--secondary')).toBe(true)
		await applyVariant(bridge, 'current')
		expect(widget(container, 'go').classList.contains('is-loading')).toBe(true)
		expect(widget(container, 'mode').classList.contains('kit-btn--neutral')).toBe(true)
		expect(widget(container, 'mode').classList.contains('kit-btn--secondary')).toBe(false)
		bridge.dispose()
	})

	it('has a muted link look and a solid neutral look next to the primary link', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'link', config: { label: 'Select all', variant: 'link' } },
			{ type: 'Button', id: 'muted', config: { label: 'Select all', variant: 'link-muted' } },
			{ type: 'Button', id: 'neutral', config: { label: 'Current', variant: 'neutral' } },
		])
		expect(widget(container, 'link').classList.contains('kit-btn--link')).toBe(true)
		expect(widget(container, 'muted').classList.contains('kit-btn--link-muted')).toBe(true)
		expect(widget(container, 'neutral').classList.contains('kit-btn--neutral')).toBe(true)
		bridge.dispose()
	})

	it('keeps the primary hue when a primary button is disabled, in the built stylesheet', async () => {
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		// The primary fill no longer depends on `:not(:disabled)`, so the generic disabled gray cannot replace it.
		expect(css).not.toContain('.kit-btn.kit-btn--primary:not(:disabled)')
		expect(css).toMatch(/\.kit-btn\.kit-btn--primary \{[^}]*background-color: var\(--kit-primary\)/)
		expect(css).toMatch(/\.kit-btn\.kit-btn--primary:disabled \{[^}]*opacity/)
		const { container, bridge } = await mount([{ type: 'Button', id: 'submit', config: { label: 'Submit', variant: 'primary', disabled: true } }])
		const button = widget(container, 'submit')
		expect(button.hasAttribute('disabled')).toBe(true)
		expect(button.classList.contains('kit-btn--primary')).toBe(true)
		bridge.dispose()
	})
})

describe('text interpolation and inline code', () => {
	const locales = {
		'en-US': {
			'k.stored': 'Stored in {value}.',
			'k.next': 'Next: {value}',
			'k.count': '{value} problems',
			'k.alertTitle': 'Showing the first {value} files',
			'k.alertDesc': 'Open {value} to read the rest.',
			'k.disclosure': '{value} autosaves with no net change',
			'k.tick': 'A ` tick stays {value}',
		},
	}

	it('renders the interpolated `{value}` of a Text as inline code with `valueCode`, and as plain text without it', async () => {
		const { container, bridge } = await mount([
			{ type: 'Text', id: 'stored', config: { textKey: 'k.stored', value: 'product-kit.json', valueCode: true } },
			{ type: 'Text', id: 'plain', config: { textKey: 'k.stored', value: 'product-kit.json' } },
			{ type: 'Text', id: 'tick', config: { textKey: 'k.tick', value: 'x', valueCode: true } },
		], { locales })
		const stored = widget(container, 'stored')
		expect(stored.textContent).toBe('Stored in product-kit.json.')
		const code = stored.querySelectorAll('code.uiux-ref-code')
		expect(code).toHaveLength(1)
		expect(code[0]!.textContent).toBe('product-kit.json')
		expect(widget(container, 'plain').textContent).toBe('Stored in product-kit.json.')
		expect(widget(container, 'plain').querySelector('code')).toBeNull()
		// A backtick of the message itself is not a code boundary the author asked for, but a lone one stays literal.
		const tick = widget(container, 'tick')
		expect(tick.textContent).toBe('A ` tick stays x')
		expect(tick.querySelectorAll('code')).toHaveLength(1)
		bridge.dispose()
	})

	it('interpolates `{value2}` and `{value3}` next to `{value}` in Text, Button, Alert and Disclosure, and leaves a code run to `{value}` alone', async () => {
		const three = { 'en-US': { 'k.three': '{value} is editing {value2} until {value3}' } }
		const config = { value: 'Mina', value2: 'Checkout', value3: '15:05' }
		const { container, bridge } = await mount([
			{ type: 'Text', id: 'text', config: { textKey: 'k.three', ...config } },
			{ type: 'Button', id: 'button', config: { labelKey: 'k.three', ...config, valueCode: true } },
			{ type: 'Alert', id: 'alert', config: { titleKey: 'k.three', ...config } },
			{ type: 'Disclosure', id: 'disclosure', config: { labelKey: 'k.three', ...config } },
		], { locales: three })
		expect(widget(container, 'text').textContent).toBe('Mina is editing Checkout until 15:05')
		expect(widget(container, 'button').textContent).toBe('Mina is editing Checkout until 15:05')
		expect(Array.from(widget(container, 'button').querySelectorAll('code')).map(node => node.textContent)).toEqual(['Mina'])
		expect(widget(container, 'alert').querySelector('.uiux-ref-alert-title')!.textContent).toBe('Mina is editing Checkout until 15:05')
		expect(widget(container, 'disclosure').querySelector('.kit-disclosure__label')!.textContent).toBe('Mina is editing Checkout until 15:05')
		bridge.dispose()
	})

	it('interpolates `{value}` into a Button label, as code with `valueCode`', async () => {
		const { container, bridge } = await mount([
			{ type: 'Button', id: 'next', config: { labelKey: 'k.next', value: '#signin-submit', valueCode: true } },
			{ type: 'Button', id: 'count', config: { labelKey: 'k.count', value: 2 } },
		], { locales })
		const next = widget(container, 'next')
		expect(next.textContent).toBe('Next: #signin-submit')
		expect(next.querySelector('code.uiux-ref-code')!.textContent).toBe('#signin-submit')
		expect(widget(container, 'count').textContent).toBe('2 problems')
		bridge.dispose()
	})

	it('interpolates `{value}` into the title and the description of an Alert, with inline code', async () => {
		const { container, bridge } = await mount([
			{ type: 'Alert', id: 'alert', config: { titleKey: 'k.alertTitle', descriptionKey: 'k.alertDesc', value: '2,000', valueCode: true } },
		], { locales })
		const alert = widget(container, 'alert')
		expect(alert.querySelector('.uiux-ref-alert-title')!.textContent).toBe('Showing the first 2,000 files')
		const description = alert.querySelector('.uiux-ref-alert-desc')!
		expect(description.textContent).toBe('Open 2,000 to read the rest.')
		expect(description.querySelector('code')!.textContent).toBe('2,000')
		bridge.dispose()
	})

	it('interpolates `{value}` into the label of a Disclosure', async () => {
		const { container, bridge } = await mount([{ type: 'Disclosure', id: 'quiet', config: { labelKey: 'k.disclosure', value: 2 } }], { locales })
		expect(widget(container, 'quiet').querySelector('.kit-disclosure__label')!.textContent).toBe('2 autosaves with no net change')
		bridge.dispose()
	})

	it('reports no translation warning for the interpolating fields, and declares `value` for each in the Catalog', async () => {
		const manifest = extractProductAdapterManifest(await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>)
		for (const [type, field] of [['Text', 'text'], ['Button', 'label'], ['Alert', 'title'], ['Alert', 'description'], ['Panel', 'title'], ['Panel', 'description'], ['Disclosure', 'label'], ['Badge', 'label']] as const)
			expect(manifest.catalog.widgets[type]?.i18n?.fields[field]?.params, `${type}.${field}`).toMatchObject({ value: 'valueText' })
		const { bridge } = await mount([
			{ type: 'Button', id: 'next', config: { labelKey: 'k.next', value: 'x' } },
			{ type: 'Alert', id: 'alert', config: { titleKey: 'k.alertTitle', value: 3 } },
			{ type: 'Disclosure', id: 'quiet', config: { labelKey: 'k.disclosure', value: 4 } },
			{ type: 'Select', id: 'select', config: { valueKey: 'k.next', labelKey: 'k.count' } },
			{ type: 'TextInput', id: 'field', config: { valueKey: 'k.next' } },
			{ type: 'SelectOption', id: 'option', config: { labelKey: 'k.next', descriptionKey: 'k.count' } },
			{ type: 'Panel', id: 'panel', config: { titleKey: 'k.next', descriptionKey: 'k.count', closeLabelKey: 'k.count', value: 'x' } },
			{ type: 'Segment', id: 'segment', config: { labelKey: 'k.next', badgeKey: 'k.count' } },
		], { locales })
		const evaluation = bridge.evaluateTranslations!()
		// Every Catalog-mapped result Property was evaluated (none is missing), and only the parameter `{value}`
		// the Catalog maps is interpolated: a placeholder whose argument a Widget cannot supply warns.
		expect(evaluation.missing).toEqual([])
		expect(evaluation.entries.length).toBeGreaterThanOrEqual(14)
		const warned = evaluation.entries.filter(entry => entry.warnings.length > 0).map(entry => entry.occurrence)
		// `k.next` and `k.count` use `{value}` that the Select, TextInput, SelectOption, Panel (its close label) and Segment do not supply.
		expect(warned.every(occurrence => ['select', 'field', 'option', 'panel', 'segment'].includes((occurrence as { widgetId?: string }).widgetId ?? ''))).toBe(true)
		const interpolating = evaluation.entries.filter(entry => ['next', 'alert', 'quiet'].includes((entry.occurrence as { widgetId?: string }).widgetId ?? ''))
		expect(interpolating.length).toBeGreaterThanOrEqual(3)
		expect(interpolating.flatMap(entry => entry.warnings)).toEqual([])
		bridge.dispose()
	})
})

describe('`visible` and the other states a Variant switches (Badge, Text, Icon, ListItem, TableRow, Stack outline)', () => {
	it('hides a Badge, a Text, an Icon, a ListItem and a TableRow through the `visible` state, and shows them again by default', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Badge', id: 'badge', config: { label: 'Building' } },
				{ type: 'Text', id: 'text', config: { text: 'Hello' } },
				{ type: 'Icon', id: 'icon', config: { name: 'check' } },
				{ type: 'ListItem', id: 'row' },
				{ type: 'Table', id: 'table', slots: { rows: [{ type: 'TableRow', id: 'tr' }] } },
				{ type: 'Badge', id: 'late', config: { label: 'Later', visible: false } },
			],
			{ variants: { gone: { state: { badge: { visible: false }, text: { visible: false }, icon: { visible: false }, row: { visible: false }, tr: { visible: false }, late: { visible: true } } } } },
		)
		const ids = ['badge', 'text', 'icon', 'row', 'tr']
		for (const id of ids) expect(hidden(container, id), id).toBe(false)
		expect(hidden(container, 'late')).toBe(true)
		await applyVariant(bridge, 'gone')
		for (const id of ids) expect(hidden(container, id), id).toBe(true)
		expect(hidden(container, 'late')).toBe(false)
		bridge.dispose()
	})

	it('takes the Stack `outline` as a state: a Variant adds, switches and removes it', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Stack', id: 'frame' },
				{ type: 'Stack', id: 'base', config: { outline: 'modified' } },
			],
			{ variants: { added: { state: { frame: { outline: 'added' }, base: { outline: 'none' } } } } },
		)
		const outlined = (id: string) => Array.from(widget(container, id).classList).filter(name => name.startsWith('is-outline-'))
		expect(outlined('frame')).toEqual([])
		expect(outlined('base')).toEqual(['is-outline-modified'])
		await applyVariant(bridge, 'added')
		expect(outlined('frame')).toEqual(['is-outline-added'])
		expect(outlined('base')).toEqual([])
		bridge.dispose()
	})
})

describe('the Stack: a capped scrolling list and a dashed card', () => {
	it('caps its height and scrolls inside with `maxHeight` and `scrollY`', async () => {
		const { container, bridge } = await mount([{ type: 'Stack', id: 'list', config: { scrollY: true, maxHeight: '224px', card: true } }])
		const list = widget(container, 'list')
		expect(list.style.maxHeight).toBe('224px')
		expect(list.style.overflowY).toBe('auto')
		bridge.dispose()
	})

	it('draws a dashed boundary with `dashed`, alone or on a card', async () => {
		const { container, bridge } = await mount([
			{ type: 'Stack', id: 'alone', config: { dashed: true } },
			{ type: 'Stack', id: 'card', config: { card: true, dashed: true } },
			{ type: 'Stack', id: 'solid', config: { card: true } },
		])
		expect(widget(container, 'alone').classList.contains('is-dashed')).toBe(true)
		expect(widget(container, 'card').classList.contains('is-dashed')).toBe(true)
		expect(widget(container, 'card').classList.contains('is-card')).toBe(true)
		expect(widget(container, 'solid').classList.contains('is-dashed')).toBe(false)
		bridge.dispose()
	})
})

describe('the Checkbox: a mono label and a 44px row', () => {
	it('sets the label in mono with `mono` and makes the row a 44px target with `touch`', async () => {
		const { container, bridge } = await mount([
			{ type: 'Checkbox', id: 'evidence', config: { label: 'payment-declined', mono: true, touch: true, meta: 'a4f19c0e' } },
			{ type: 'Checkbox', id: 'plain', config: { label: 'Plain' } },
		])
		const evidence = widget(container, 'evidence')
		expect(evidence.classList.contains('is-mono')).toBe(true)
		expect(evidence.classList.contains('is-touch')).toBe(true)
		const plain = widget(container, 'plain')
		expect(plain.classList.contains('is-mono')).toBe(false)
		expect(plain.classList.contains('is-touch')).toBe(false)
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toMatch(/\.kit-checkbox\.is-touch \{[^}]*min-height: 44px/)
		expect(css).toMatch(/\.kit-checkbox\.is-mono \.kit-checkbox__label \{[^}]*font-family: var\(--kit-font-mono\)[^}]*font-size: 12px/)
		bridge.dispose()
	})
})

describe('the ListItem: height, top alignment and a neutral current row', () => {
	it('takes a row height, top-aligns its end slots and marks the current row neutrally', async () => {
		const { container, bridge } = await mount([
			{ type: 'ListItem', id: 'tall', config: { size: 'lg', align: 'start', selected: true, selectedLook: 'neutral' } },
			{ type: 'ListItem', id: 'mid', config: { size: 'md' } },
			{ type: 'ListItem', id: 'plain', config: { selected: true } },
		])
		const tall = widget(container, 'tall')
		for (const name of ['kit-list-item--lg', 'is-align-start', 'is-selected', 'is-selected-neutral']) expect(tall.classList.contains(name), name).toBe(true)
		expect(widget(container, 'mid').classList.contains('kit-list-item--md')).toBe(true)
		const plain = widget(container, 'plain')
		expect(plain.classList.contains('kit-list-item--sm')).toBe(true)
		expect(plain.classList.contains('is-selected-neutral')).toBe(false)
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toMatch(/\.kit-list-item\.kit-list-item--lg \{[^}]*min-height: 48px/)
		expect(css).toMatch(/\.kit-list-item\.is-selected\.is-selected-neutral \{[^}]*background-color: var\(--kit-bg-surface-elevated\)/)
		bridge.dispose()
	})
})

describe('the Select: a localizable value, and options with a description and a mono label', () => {
	const locales = {
		'en-US': { 'sel.ir': 'IR', 'sel.irVariant': 'IR, Variant' },
		'zh-TW': { 'sel.ir': '版面結構', 'sel.irVariant': '版面結構、Variant' },
	}
	const triggerText = (container: HTMLElement, id: string) => widget(container, id).querySelector('.kit-select__value')!.textContent

	it('shows the translated label of `valueKey` in the render context\'s Locale, instead of the literal `value`', async () => {
		const select: Widget = { type: 'Select', id: 'domains', config: { label: 'Domains', valueKey: 'sel.ir', value: 'literal' } }
		const en = await mount([select], { locales })
		expect(triggerText(en.container, 'domains')).toBe('IR')
		en.bridge.dispose()
		const zh = await mount([select], { locales, context: { locale: 'zh-TW' } })
		expect(triggerText(zh.container, 'domains')).toBe('版面結構')
		zh.bridge.dispose()
	})

	it('lets a Variant localize the chosen label through the `valueKey` state, and keeps a literal `value` literal', async () => {
		const { container, bridge } = await mount(
			[
				{ type: 'Select', id: 'domains', config: { label: 'Domains', multiple: true, placeholder: 'Choose' } },
				{ type: 'Select', id: 'literal', config: { label: 'Literal', value: 'Kept as is' } },
			],
			{ locales, context: { locale: 'zh-TW' }, variants: { chosen: { state: { domains: { valueKey: 'sel.irVariant' } } } } },
		)
		expect(triggerText(container, 'domains')).toBe('Choose')
		await applyVariant(bridge, 'chosen')
		expect(triggerText(container, 'domains')).toBe('版面結構、Variant')
		expect(triggerText(container, 'literal')).toBe('Kept as is')
		bridge.dispose()
	})

	it('maps `value` as an `$i18n` field of Select and TextInput, lowered to `valueKey`, with derived Property names', async () => {
		const manifest = extractProductAdapterManifest(await import(pathToFileURL(ADAPTER).href) as Record<string, unknown>)
		for (const type of ['Select', 'TextInput'] as const)
			expect(manifest.catalog.widgets[type]?.i18n?.fields.value, type).toEqual({ configField: 'valueKey' })
	})

	it('gives an option a description line and a mono label', async () => {
		const { container, bridge } = await mount([
			{
				type: 'Select',
				id: 'event',
				config: { label: 'Event', open: true },
				slots: { options: [
					{ type: 'SelectOption', id: 'o1', config: { label: 'click#signin-submit', description: 'Press the sign-in button', mono: true } },
					{ type: 'SelectOption', id: 'o2', config: { label: 'Plain' } },
				] },
			},
		])
		const described = widget(container, 'o1')
		expect(described.classList.contains('is-mono')).toBe(true)
		expect(described.querySelector('.kit-select-option__description')!.textContent).toBe('Press the sign-in button')
		expect(described.querySelector('.kit-select-option__label')!.textContent).toBe('click#signin-submit')
		const plain = widget(container, 'o2')
		expect(plain.classList.contains('is-mono')).toBe(false)
		expect(plain.querySelector('.kit-select-option__description')).toBeNull()
		bridge.dispose()
	})
})

describe('the Panel dialog: description, close button, separators and backdrop', () => {
	it('shows the description under the title and a close button that reports `close`', async () => {
		const { container, bridge } = await mount([
			{ type: 'Panel', id: 'dialog', config: { variant: 'dialog', title: 'Create Checkpoint', description: 'Pin this version in the timeline.', closable: true, closeLabel: 'Close dialog', backdrop: true } },
			{ type: 'Panel', id: 'quiet', config: { variant: 'dialog', title: 'No extras' } },
		])
		const probe = bridge.interactionProbe!()
		expect(probe.watch('dialog', 'close')).toBe(true)
		const dialog = widget(container, 'dialog')
		expect(dialog.querySelector('.uiux-ref-panel-title')!.textContent).toBe('Create Checkpoint')
		expect(dialog.querySelector('.uiux-ref-panel-description')!.textContent).toBe('Pin this version in the timeline.')
		expect(dialog.classList.contains('has-backdrop')).toBe(true)
		const close = dialog.querySelector<HTMLElement>('.uiux-ref-panel-close')!
		expect(close.getAttribute('aria-label')).toBe('Close dialog')
		click(close)
		await tick()
		expect(events(bridge)).toEqual(['dialog:close'])
		const quiet = widget(container, 'quiet')
		expect(quiet.querySelector('.uiux-ref-panel-description')).toBeNull()
		expect(quiet.querySelector('.uiux-ref-panel-close')).toBeNull()
		expect(quiet.classList.contains('has-backdrop')).toBe(false)
		bridge.dispose()
	})

	it('translates the description and the close label, and wraps the footer slot so a dialog can separate it', async () => {
		const { container, bridge } = await mount(
			[{
				type: 'Panel',
				id: 'dialog',
				config: { variant: 'dialog', title: 'T', descriptionKey: 'p.desc', closable: true, closeLabelKey: 'p.close' },
				slots: { footer: [{ type: 'Button', id: 'ok', config: { label: 'OK' } }] },
			}],
			{ locales: { 'en-US': { 'p.desc': 'Described', 'p.close': 'Dismiss' } } },
		)
		const dialog = widget(container, 'dialog')
		expect(dialog.querySelector('.uiux-ref-panel-description')!.textContent).toBe('Described')
		expect(dialog.querySelector('.uiux-ref-panel-close')!.getAttribute('aria-label')).toBe('Dismiss')
		expect(dialog.querySelector('.uiux-ref-panel-footer [data-widget-id="ok"]')).not.toBeNull()
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toContain('.uiux-ref-panel.variant-dialog .uiux-ref-panel-footer:has(> *)')
		expect(css).toContain('.uiux-ref-panel.variant-dialog.has-backdrop')
		bridge.dispose()
	})
})

describe('the Panel title and description interpolate {value}, {value2} and {value3}', () => {
	it('fills the placeholders of a translated title and description from the literal values, and reports no warning for them', async () => {
		const locales = { 'en-US': { 'p.title': 'Remove {value}?', 'p.desc': 'Single use, expires {value}. It signs one browser in as {value2}.', 'p.three': '{value} is editing {value2} until {value3}' } }
		const { container, bridge } = await mount([
			{ type: 'Panel', id: 'remove', config: { variant: 'dialog', titleKey: 'p.title', value: 'dana' } },
			{ type: 'Panel', id: 'invite', config: { variant: 'dialog', title: 'Link', descriptionKey: 'p.desc', value: 'Nov 3, 2026', value2: 'dana' } },
			{ type: 'Panel', id: 'three', config: { variant: 'dialog', titleKey: 'p.three', value: 'claude', value2: 'Checkout', value3: '15:05' } },
			{ type: 'Panel', id: 'literal', config: { variant: 'dialog', title: 'Plain {value}' } },
		], { locales })
		expect(widget(container, 'remove').querySelector('.uiux-ref-panel-title')!.textContent).toBe('Remove dana?')
		expect(widget(container, 'invite').querySelector('.uiux-ref-panel-description')!.textContent).toBe('Single use, expires Nov 3, 2026. It signs one browser in as dana.')
		expect(widget(container, 'three').querySelector('.uiux-ref-panel-title')!.textContent).toBe('claude is editing Checkout until 15:05')
		expect(widget(container, 'literal').querySelector('.uiux-ref-panel-title')!.textContent).toBe('Plain {value}')
		const warned = bridge.evaluateTranslations!().entries.filter(entry => entry.warnings.length > 0)
		expect(warned).toEqual([])
		bridge.dispose()
	})
})

describe('the Table: a minimum width that scrolls, and top-aligned cells', () => {
	it('gives every row the table\'s `minWidth` and top-aligns the cells of a row with `align`', async () => {
		const { container, bridge } = await mount([
			{ type: 'Table', id: 'table', config: { columns: '2fr 1fr', minWidth: '640px' }, slots: { rows: [
				{ type: 'TableRow', id: 'head', config: { header: true } },
				{ type: 'TableRow', id: 'row', config: { align: 'start' } },
				{ type: 'TableRow', id: 'centered' },
			] } },
		])
		expect(widget(container, 'table').style.getPropertyValue('--kit-table-min-width')).toBe('640px')
		expect(widget(container, 'row').classList.contains('is-align-start')).toBe(true)
		expect(widget(container, 'centered').classList.contains('is-align-start')).toBe(false)
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toMatch(/\.kit-table \{[^}]*overflow-x: auto/)
		expect(css).toMatch(/\.kit-table-row \{[^}]*min-width: var\(--kit-table-min-width, 0\)/)
		bridge.dispose()
	})
})

describe('the GraphCanvas fill option', () => {
	it('fills the space its parent leaves with `fill`, which keeps the dot ground and the centering on the Widget itself', async () => {
		const { container, bridge } = await mount([
			{ type: 'GraphCanvas', id: 'filled', config: { fill: true, nodes: [{ key: 'a', label: 'Cart' }] } },
			{ type: 'GraphCanvas', id: 'content', config: { nodes: [{ key: 'a', label: 'Cart' }] } },
		])
		expect(widget(container, 'filled').classList.contains('is-fill')).toBe(true)
		expect(widget(container, 'content').classList.contains('is-fill')).toBe(false)
		const css = await readFile(join(KIT, 'dist', 'uiux.css'), 'utf8')
		expect(css).toMatch(/\.uiux-ref-graph\.is-fill \{[^}]*flex: 1 1 auto/)
		expect(css).toMatch(/\.uiux-ref-graph-surface \{[^}]*margin: auto/)
		expect(css).toMatch(/\.uiux-ref-graph \{[^}]*radial-gradient\(var\(--kit-canvas-dot\)/)
		bridge.dispose()
	})
})

describe('the SegmentedControl pills and the Segment badge', () => {
	it('is a tab list of rounded pills, with a translatable badge after the label of a tab', async () => {
		const { container, bridge } = await mount(
			[{
				type: 'SegmentedControl',
				id: 'tabs',
				config: { appearance: 'pills', label: 'Sections' },
				slots: { content: [
					{ type: 'Segment', id: 'overview', config: { appearance: 'pills', label: 'Overview', selected: true, badgeKey: 'seg.unsaved' } },
					{ type: 'Segment', id: 'styles', config: { appearance: 'pills', label: 'Styles' } },
				] },
			}],
			{ locales: { 'en-US': { 'seg.unsaved': 'Unsaved' } } },
		)
		const tabs = widget(container, 'tabs')
		expect(tabs.getAttribute('role')).toBe('tablist')
		expect(tabs.classList.contains('appearance-pills')).toBe(true)
		const overview = widget(container, 'overview')
		expect(overview.getAttribute('role')).toBe('tab')
		expect(overview.getAttribute('aria-selected')).toBe('true')
		expect(overview.classList.contains('appearance-pills')).toBe(true)
		expect(overview.querySelector('.kit-badge')!.textContent).toBe('Unsaved')
		expect(widget(container, 'styles').querySelector('.kit-badge')).toBeNull()
		bridge.dispose()
	})
})

describe('the Segment badge as a state', () => {
	it('shows a badge on a tab while a Variant sets the `badgeKey` state, and none before', async () => {
		const { container, bridge } = await mount(
			[{
				type: 'SegmentedControl',
				id: 'tabs',
				config: { appearance: 'pills' },
				slots: { content: [{ type: 'Segment', id: 'styles', config: { appearance: 'pills', label: 'Styles' } }] },
			}],
			{
				locales: { 'en-US': { 'seg.unsaved': 'Unsaved' } },
				variants: { draft: { state: { styles: { badgeKey: 'seg.unsaved' } } } },
			},
		)
		expect(widget(container, 'styles').querySelector('.kit-badge')).toBeNull()
		await applyVariant(bridge, 'draft')
		expect(widget(container, 'styles').querySelector('.kit-badge')!.textContent).toBe('Unsaved')
		bridge.dispose()
	})
})

describe('the EmptyState compact look', () => {
	it('is the one-line dashed block with `compact`, and the icon-disc layout without it', async () => {
		const { container, bridge } = await mount([
			{ type: 'EmptyState', id: 'compact', config: { title: 'No packages', compact: true } },
			{ type: 'EmptyState', id: 'full', config: { title: 'No packages', icon: 'package' } },
		])
		expect(widget(container, 'compact').classList.contains('is-compact')).toBe(true)
		expect(widget(container, 'full').classList.contains('is-compact')).toBe(false)
		bridge.dispose()
	})
})

describe('the Disclosure: a leading icon, a trailing chevron and a link look', () => {
	it('puts the chevron after the label with `chevron: "end"`, adds an icon and the link look', async () => {
		const { container, bridge } = await mount([
			{ type: 'Disclosure', id: 'quiet', config: { label: 'Autosaves', icon: 'circle-dashed', chevron: 'end' } },
			{ type: 'Disclosure', id: 'log', config: { label: 'Show log', appearance: 'link', chevron: 'end' } },
			{ type: 'Disclosure', id: 'row', config: { label: 'Default' } },
		])
		const header = (id: string) => widget(container, id).querySelector<HTMLElement>('.kit-disclosure__header')!
		const order = (id: string) => Array.from(header(id).children).map(node => node.tagName === 'svg' ? 'icon' : node.className.replace('kit-disclosure__', ''))
		expect(order('quiet')).toEqual(['icon', 'label', 'trailing', 'icon'])
		expect(order('row')).toEqual(['icon', 'label', 'trailing'])
		expect(header('log').classList.contains('is-link')).toBe(true)
		expect(header('row').classList.contains('is-link')).toBe(false)
		bridge.dispose()
	})
})

describe('the TextInput: a localizable value and a hidden label', () => {
	const locales = { 'en-US': { 'note.sample': 'Reviewed with design.' }, 'zh-TW': { 'note.sample': '已與設計確認。' } }

	it('shows the translated `valueKey` in the render context\'s Locale, and typing replaces it with the typed text', async () => {
		const field: Widget = { type: 'TextInput', id: 'note', config: { label: 'Note', rows: 2, valueKey: 'note.sample' } }
		const en = await mount([field], { locales })
		const textarea = widget(en.container, 'note').querySelector('textarea')!
		expect(textarea.value).toBe('Reviewed with design.')
		en.bridge.dispose()
		const zh = await mount([field], { locales, context: { locale: 'zh-TW' } })
		const zhArea = widget(zh.container, 'note').querySelector('textarea')!
		expect(zhArea.value).toBe('已與設計確認。')
		zhArea.value = 'typed'
		zhArea.dispatchEvent(new window.Event('input', { bubbles: true }) as never)
		await tick()
		expect(widget(zh.container, 'note').querySelector('textarea')!.value).toBe('typed')
		expect(zh.bridge.interactionProbe!().readState('note', 'valueKey')).toEqual({ found: true, value: '' })
		zh.bridge.dispose()
	})

	it('keeps the label for assistive technology only with `hideLabel`', async () => {
		const { container, bridge } = await mount([
			{ type: 'TextInput', id: 'hidden', config: { label: 'Adapter config', hideLabel: true } },
			{ type: 'TextInput', id: 'shown', config: { label: 'Shown' } },
		])
		const label = widget(container, 'hidden').querySelector('label')!
		expect(label.textContent).toBe('Adapter config')
		expect(label.classList.contains('is-visually-hidden')).toBe(true)
		expect(widget(container, 'hidden').querySelector('input')!.id).toBe(label.getAttribute('for'))
		expect(widget(container, 'shown').querySelector('label')!.classList.contains('is-visually-hidden')).toBe(false)
		bridge.dispose()
	})
})
