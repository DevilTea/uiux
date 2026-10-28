import {
	createWidgetPlugin,
	createWidgetValueContract,
	type UnknownTargetDependencyOperations,
	type WidgetConfigJsonSchema,
} from '@deviltea/widget-core'
import { defineComponent, h, type VNode } from 'vue'
import { useWidget } from '@deviltea/widget-vue'
import {
	STRING_VALUE_CONTRACT_ID,
	TRANSLATION_RESULT_VALUE_CONTRACT_ID,
	WIDGET_ID_ATTRIBUTE,
	type AdapterManifest,
	type AdapterWidgetCatalogEntry,
	type I18nFieldMapping,
	type TranslationResult,
} from '@deviltea/uiux/adapter'
// The reference CSS ("Quiet Canvas" tokens from DESIGN.md) reaches the Preview only through the one
// Product Kit stylesheet, which the Preview bundler builds from CSS imported anywhere in the Adapter
// module graph (Discussion #241 R1, Rule 01a11bb1-acdc-799f-aed7-c85ddbaf0d28).
import './reference.css'
// The Kit components this Adapter wraps as Widgets (kit/src/ui/). Their styles come after reference.css
// on purpose: a component's own rules follow the scope rules the wrappers add.
import KitBadge from '../src/ui/Badge.vue'
import KitButton from '../src/ui/Button.vue'
import KitCommentPin from '../src/ui/CommentPin.vue'
import KitField from '../src/ui/Field.vue'
import KitIcon from '../src/ui/Icon.vue'
import KitKbd from '../src/ui/Kbd.vue'

// ---------------------------------------------------------------------------
// Render-context helpers (theme, viewport tier, locale) shared by every Widget
// ---------------------------------------------------------------------------

/**
 * UIUX TranslationResult and string value contracts. Like a third-party Adapter, the reference
 * Adapter takes their IDs from the public authoring entry `@deviltea/uiux/adapter` and builds the
 * contracts with the host's `@deviltea/widget-core`.
 */
const TRANSLATION_RESULT = createWidgetValueContract<TranslationResult>(TRANSLATION_RESULT_VALUE_CONTRACT_ID)
const STRING = createWidgetValueContract<string>(STRING_VALUE_CONTRACT_ID)

type RootOps = UnknownTargetDependencyOperations<'property', false>
type DepResult = Readonly<{ ok: boolean; value?: unknown }>
type Translate = (key: string, params: Readonly<Record<string, string>>) => DepResult

/**
 * Viewport tiers derived from the RootShell render-context viewport width.
 * - `compact`: phones (< 640px)
 * - `medium`: tablets and small laptops (640px – 1279px)
 * - `wide`: desktop and larger (>= 1280px)
 */
export type ViewportTier = 'compact' | 'medium' | 'wide'
const COMPACT_MAX_WIDTH = 640
const MEDIUM_MAX_WIDTH = 1280

/** Responsive overrides cascade desktop-first: `medium` applies below 1280px, `compact` adds to it below 640px. */
export type Responsive<T> = Readonly<{ medium?: Partial<T>; compact?: Partial<T> }>

type ViewportValue = Readonly<{ id: string; width: number; height: number }>

function readViewport(result: DepResult): ViewportValue | null {
	if (!result.ok || typeof result.value !== 'object' || result.value === null) return null
	const value = result.value as Record<string, unknown>
	if (typeof value.id !== 'string' || typeof value.width !== 'number' || typeof value.height !== 'number') return null
	return { id: value.id, width: value.width, height: value.height }
}

function tierOf(viewport: ViewportValue | null): ViewportTier {
	if (!viewport) return 'wide'
	if (viewport.width < COMPACT_MAX_WIDTH) return 'compact'
	if (viewport.width < MEDIUM_MAX_WIDTH) return 'medium'
	return 'wide'
}

/** The Workspace theme IDs the reference CSS styles; the manifest's `themeSupport` rejects every other one. */
const REFERENCE_THEME_IDS: ReadonlySet<string> = new Set(['light', 'dark'])

/**
 * Theme ids are opaque Workspace keys; `light` and `dark` are styled explicitly. UIUX never renders
 * another theme with this Adapter (its `themeSupport` rejects it), so the OS-scheme `uiux-theme-auto`
 * is left only for a RootShell `themeId` that cannot be read.
 */
function themeClassOf(result: DepResult): string {
	const themeId = result.ok && typeof result.value === 'string' ? result.value : ''
	if (themeId === 'light') return 'uiux-theme-light'
	if (themeId === 'dark') return 'uiux-theme-dark'
	return 'uiux-theme-auto'
}

function themeProperty() {
	return {
		valueContract: STRING,
		registerDeps: ({ dep }: { dep: { root: RootOps } }) => ({ themeId: dep.root.state.get('themeId') }),
		compute: ({ deps }: { deps: { themeId: () => DepResult } }) => themeClassOf(deps.themeId()),
	}
}

function viewportDeps({ dep }: { dep: { root: RootOps } }) {
	return { viewport: dep.root.state.get('viewport') }
}

function definedEntries<T extends object>(value: Partial<T> | undefined): Partial<T> {
	if (!value || typeof value !== 'object') return {}
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function cascade<T extends object>(base: T, responsive: Responsive<T> | undefined, tier: ViewportTier): T {
	if (tier === 'wide' || !responsive) return base
	const medium = { ...base, ...definedEntries<T>(responsive.medium) }
	return tier === 'medium' ? medium : { ...medium, ...definedEntries<T>(responsive.compact) }
}

function px(value: number | string | undefined, fallback: string): string {
	if (typeof value === 'number') return `${value}px`
	return value ?? fallback
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback
}

function stringFromResult(result: DepResult): string {
	return result.ok && typeof result.value === 'string' ? result.value : ''
}

function isTranslationResult(value: unknown): value is TranslationResult {
	return typeof value === 'object' && value !== null
		&& typeof (value as { text?: unknown }).text === 'string'
		&& Array.isArray((value as { warnings?: unknown }).warnings)
}

/** Resolves one Catalog-mapped field: a lowered `$i18n` key wins over the literal authored text. */
function translateField(key: string | null, literal: string, translate: Translate, params: Readonly<Record<string, string>> = {}): TranslationResult {
	if (key === null) return { text: literal, warnings: [] }
	const result = translate(key, params)
	if (result.ok && isTranslationResult(result.value)) return result.value
	return { text: `⟦missing:${key}⟧`, warnings: [] }
}

function textOfResult(result: DepResult): string {
	return result.ok && isTranslationResult(result.value) ? result.value.text : ''
}

function translateDeps({ dep }: { dep: { root: RootOps } }) {
	return { t: dep.root.methods.invoke('t').validate((value): value is TranslationResult => isTranslationResult(value)) }
}

/** A Catalog-mapped translatable field as resolved config: the lowered key (if any) and the literal fallback. */
type FieldSource = Readonly<{ key: string | null; literal: string }>
type TranslateOnlyDeps = Readonly<{ t: Translate }>

/** `<field>Result` property definition for Widgets whose translated field needs no runtime parameters. */
function translatedResult<C>(pick: (config: C) => FieldSource) {
	return {
		valueContract: TRANSLATION_RESULT,
		registerDeps: translateDeps,
		compute: ({ config, deps }: { config: C; deps: TranslateOnlyDeps }): TranslationResult => {
			const source = pick(config)
			return translateField(source.key, source.literal, (key, params) => deps.t(key, params))
		},
	}
}

/** `<field>` text property definition paired with {@link translatedResult}; it resolves the same binding. */
function translatedText<C>(pick: (config: C) => FieldSource) {
	return {
		valueContract: STRING,
		registerDeps: translateDeps,
		compute: ({ config, deps }: { config: C; deps: TranslateOnlyDeps }): string => {
			const source = pick(config)
			return translateField(source.key, source.literal, (key, params) => deps.t(key, params)).text
		},
	}
}

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const RESPONSIVE_SCHEMA = {
	type: 'object',
	properties: { medium: { type: 'object' }, compact: { type: 'object' } },
	additionalProperties: false,
} as const

function configSchema(properties: Record<string, WidgetConfigJsonSchema>): WidgetConfigJsonSchema {
	return {
		$schema: SCHEMA_DIALECT,
		type: 'object',
		properties: { ...properties, responsive: RESPONSIVE_SCHEMA },
	}
}

// widget-core validates an omitted Config as `null` (0.0.5+), so every Config here accepts `null` and its
// `raw` type includes it: a Widget may omit its Config and resolves to the defaults.
const isConfigOrOmitted = (input: unknown): boolean => input === null || (typeof input === 'object' && !Array.isArray(input))
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

function splitResponsive<T extends object>(raw: (T & { responsive?: Responsive<T> }) | null): { base: T; responsive?: Responsive<T> } {
	if (!raw) return { base: {} as T }
	const { responsive, ...base } = raw
	return responsive && typeof responsive === 'object' ? { base: base as T, responsive } : { base: base as T }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}


function iconNode(name: string | undefined | null, size = 16, extraClass = ''): VNode | null {
	if (!name) return null
	return h(KitIcon, { name, size, class: extraClass || undefined })
}

function kbdNode(keys: string): VNode {
	return h(KitKbd, { keys })
}

type CssStyle = Record<string, string>

/** Whether the render context implies a coarse pointer (tablet and phone tiers get 44px targets). */
function isTouchTier(tier: ViewportTier): boolean {
	return tier !== 'wide'
}

const visibleState = {
	authorWritable: true,
	validate: isBoolean,
	default: () => true,
}

// ---------------------------------------------------------------------------
// 1. Stack Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface StackLayout {
	direction?: 'horizontal' | 'vertical'
	gap?: number | string
	align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline'
	justify?: 'start' | 'center' | 'end' | 'between' | 'around'
	padding?: number | string
	wrap?: boolean
	flex?: string | number
	grow?: boolean
	width?: string
	height?: string
	minHeight?: string
	minWidth?: string
	maxWidth?: string
	/** Grow to at least the render-context viewport height (replaces `100vh` arithmetic). */
	fillViewport?: boolean
	/** Pins the region to exactly the render-context viewport height, so inner panels scroll instead of the page. */
	lockViewport?: boolean
	/** Paints a themed background for top-level layout regions. */
	surface?: 'none' | 'app' | 'surface' | 'panel' | 'muted' | 'elevated' | 'canvas'
	order?: number
	hidden?: boolean
	/** Horizontal overflow scrolls instead of wrapping (e.g. compact tab strips). */
	scrollX?: boolean
	/** Vertical overflow scrolls inside this region. */
	scrollY?: boolean
	/** Hairline separators on individual edges. */
	borderTop?: boolean
	borderBottom?: boolean
	borderLeft?: boolean
	borderRight?: boolean
	/** Outlined 8px card for discrete objects in a collection. */
	card?: boolean
	/** Absolutely positioned layer covering its positioned parent (pin layers). Children stay clickable. */
	overlay?: boolean
	/** Center this region horizontally inside its parent. */
	centered?: boolean
	/** Initial value of the author-writable `visible` state (Variants flip it). */
	visible?: boolean
	/** Literal fill for content inside a previewed View (product swatches, brand marks); chrome uses `surface`. */
	background?: string
	radius?: number | string
}

export interface StackInterfaces {
	config: {
		raw: (StackLayout & { responsive?: Responsive<StackLayout> }) | null
		resolved: { base: StackLayout; responsive?: Responsive<StackLayout> }
	}
	slots: 'content'
	state: { visible: boolean }
	properties: {
		layout: { style: CssStyle; surface: string; hidden: boolean; overlay: boolean; card: boolean }
		theme: string
	}
}

const ALIGN: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', baseline: 'baseline', stretch: 'stretch' }
const JUSTIFY: Record<string, string> = { center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', start: 'flex-start' }
const HAIRLINE = '1px solid var(--kit-border)'

export const stackPlugin = createWidgetPlugin('Stack')
	.description('Responsive layout container for horizontal and vertical stacking with gap, alignment, hairline edges, scroll regions, viewport-tier overrides, and an author-writable `visible` state for Variants.')
	.interfaces<StackInterfaces>()
	.config({
		description: 'Stack configuration. `responsive.medium` applies below 1280px viewport width, `responsive.compact` below 640px.',
		schema: configSchema({
			direction: { enum: ['horizontal', 'vertical'] },
			gap: { type: ['number', 'string'] },
			align: { enum: ['start', 'center', 'end', 'stretch', 'baseline'] },
			justify: { enum: ['start', 'center', 'end', 'between', 'around'] },
			padding: { type: ['number', 'string'] },
			wrap: { type: 'boolean' },
			flex: { type: ['number', 'string'] },
			grow: { type: 'boolean' },
			width: { type: 'string' },
			height: { type: 'string' },
			minHeight: { type: 'string' },
			minWidth: { type: 'string' },
			maxWidth: { type: 'string' },
			fillViewport: { type: 'boolean' },
			lockViewport: { type: 'boolean' },
			surface: { enum: ['none', 'app', 'surface', 'panel', 'muted', 'elevated', 'canvas'] },
			order: { type: 'number' },
			hidden: { type: 'boolean' },
			scrollX: { type: 'boolean' },
			scrollY: { type: 'boolean' },
			borderTop: { type: 'boolean' },
			borderBottom: { type: 'boolean' },
			borderLeft: { type: 'boolean' },
			borderRight: { type: 'boolean' },
			card: { type: 'boolean' },
			overlay: { type: 'boolean' },
			centered: { type: 'boolean' },
			visible: { type: 'boolean' },
			background: { type: 'string' },
			radius: { type: ['number', 'string'] },
		}),
		validate: (c): c is StackInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => splitResponsive<StackLayout>(raw),
	})
	.slots({ content: { description: 'Nested child widgets' } })
	.state(state => state.visible({ ...visibleState, default: ({ config }) => config.base.visible !== false }))
	.properties(p => p
		.layout({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const viewport = readViewport(deps.viewport())
				const layout = cascade(config.base, config.responsive, tierOf(viewport))
				const flex = layout.flex !== undefined ? String(layout.flex) : (layout.grow ? '1 1 auto' : '')
				const style: CssStyle = {
					flexDirection: layout.direction === 'horizontal' ? 'row' : 'column',
					gap: px(layout.gap, '8px'),
					alignItems: ALIGN[layout.align ?? 'stretch'] ?? 'stretch',
					justifyContent: JUSTIFY[layout.justify ?? 'start'] ?? 'flex-start',
					padding: px(layout.padding, '0px'),
					flexWrap: layout.wrap ? 'wrap' : 'nowrap',
					...(flex ? { flex } : {}),
					...(layout.width ? { width: layout.width } : {}),
					...(layout.height ? { height: layout.height } : {}),
					...(layout.maxWidth ? { maxWidth: layout.maxWidth } : {}),
					...(layout.minWidth ? { minWidth: layout.minWidth } : {}),
					...(layout.order !== undefined ? { order: String(layout.order) } : {}),
					...(layout.scrollX ? { overflowX: 'auto' } : {}),
					...(layout.scrollY ? { overflowY: 'auto', minHeight: '0' } : {}),
					...(layout.borderTop ? { borderTop: HAIRLINE } : {}),
					...(layout.borderBottom ? { borderBottom: HAIRLINE } : {}),
					...(layout.borderLeft ? { borderLeft: HAIRLINE } : {}),
					...(layout.borderRight ? { borderRight: HAIRLINE } : {}),
					...(layout.centered ? { marginLeft: 'auto', marginRight: 'auto' } : {}),
					...(layout.background ? { background: layout.background } : {}),
					...(layout.radius !== undefined ? { borderRadius: px(layout.radius, '0px') } : {}),
				}
				if (layout.lockViewport && viewport) {
					style.height = `${viewport.height}px`
					style.overflow = 'hidden'
				}
				else if (layout.fillViewport && viewport) style.minHeight = `${viewport.height}px`
				else if (layout.minHeight) style.minHeight = layout.minHeight
				return {
					style,
					surface: layout.surface ?? 'none',
					hidden: Boolean(layout.hidden),
					overlay: Boolean(layout.overlay),
					card: Boolean(layout.card),
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const StackRenderer = defineComponent({
	name: 'StackRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties, useState } = useWidget(stackPlugin)
		const props = useProperties()
		const state = useState()

		return (): VNode => {
			const layout = props.layout.value
			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: [
					'uiux-ref-scope',
					'uiux-ref-stack',
					props.theme.value,
					`surface-${layout?.surface ?? 'none'}`,
					layout?.overlay ? 'is-overlay' : '',
					layout?.card ? 'is-card' : '',
					layout?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				style: layout?.style,
			}, [
				h(WidgetSlot, { name: 'content' }),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 2. Panel Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface PanelLayout {
	padding?: number | string
	border?: boolean
	width?: string
	height?: string
	minWidth?: string
	maxWidth?: string
	flex?: string | number
	scrollable?: boolean
	order?: number
	hidden?: boolean
	/** Initial value of the author-writable `visible` state (Variants flip it). */
	visible?: boolean
}

type PanelVariant = 'default' | 'surface' | 'sidebar' | 'canvas' | 'card' | 'dialog'

export interface PanelInterfaces {
	config: {
		raw: (PanelLayout & {
			title?: string
			titleKey?: string
			variant?: PanelVariant
			responsive?: Responsive<PanelLayout>
		}) | null
		resolved: {
			title: string
			titleKey: string | null
			variant: PanelVariant
			base: PanelLayout
			responsive?: Responsive<PanelLayout>
		}
	}
	slots: 'header' | 'content' | 'footer'
	state: { visible: boolean }
	properties: {
		titleResult: TranslationResult
		title: string
		variant: string
		frame: { style: CssStyle; bodyStyle: CssStyle; bordered: boolean; hidden: boolean }
		theme: string
	}
}

export const panelPlugin = createWidgetPlugin('Panel')
	.description('Surface container with optional translatable title, header, footer, styling variants, viewport-tier overrides, and an author-writable `visible` state.')
	.interfaces<PanelInterfaces>()
	.config({
		description: 'Panel configuration. `title` accepts an `$i18n` binding (lowered to `titleKey`).',
		schema: configSchema({
			title: { type: 'string' },
			titleKey: { type: 'string' },
			variant: { enum: ['default', 'surface', 'sidebar', 'canvas', 'card', 'dialog'] },
			padding: { type: ['number', 'string'] },
			border: { type: 'boolean' },
			width: { type: 'string' },
			height: { type: 'string' },
			minWidth: { type: 'string' },
			maxWidth: { type: 'string' },
			flex: { type: ['number', 'string'] },
			scrollable: { type: 'boolean' },
			order: { type: 'number' },
			hidden: { type: 'boolean' },
			visible: { type: 'boolean' },
		}),
		validate: (c): c is PanelInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { title, titleKey, variant, ...layout } = raw ?? {}
			const split = splitResponsive<PanelLayout>(layout)
			return {
				title: typeof title === 'string' ? title : '',
				titleKey: optionalString(titleKey),
				variant: variant ?? 'default',
				...split,
			}
		},
	})
	.slots({
		header: { description: 'Custom header widgets' },
		content: { description: 'Main panel body' },
		footer: { description: 'Bottom actions or status' },
	})
	.state(state => state.visible({ ...visibleState, default: ({ config }) => config.base.visible !== false }))
	.properties(p => p
		.titleResult(translatedResult<PanelInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedText<PanelInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.variant({ compute: ({ config }) => config.variant })
		.frame({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const layout = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				const style: CssStyle = {
					...(layout.width ? { width: layout.width } : {}),
					...(layout.height ? { height: layout.height } : {}),
					...(layout.minWidth ? { minWidth: layout.minWidth } : {}),
					...(layout.maxWidth ? { maxWidth: layout.maxWidth } : {}),
					...(layout.flex !== undefined ? { flex: String(layout.flex) } : {}),
					...(layout.order !== undefined ? { order: String(layout.order) } : {}),
				}
				const bodyStyle: CssStyle = {
					padding: px(layout.padding, '12px'),
					overflow: layout.scrollable ? 'auto' : 'visible',
				}
				return { style, bodyStyle, bordered: layout.border ?? true, hidden: Boolean(layout.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const PanelRenderer = defineComponent({
	name: 'PanelRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties, useState } = useWidget(panelPlugin)
		const props = useProperties()
		const state = useState()

		return (): VNode => {
			const title = props.title.value ?? ''
			const frame = props.frame.value
			return h('section', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				'aria-label': title || undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-panel',
					props.theme.value,
					`variant-${props.variant.value}`,
					frame?.bordered ? 'is-bordered' : '',
					frame?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				style: frame?.style,
			}, [
				title
					? h('div', { class: 'uiux-ref-panel-header' }, [
							h('h2', { class: 'uiux-ref-panel-title' }, title),
							h(WidgetSlot, { name: 'header' }),
						])
					: h(WidgetSlot, { name: 'header' }),
				h('div', { class: 'uiux-ref-panel-body', style: frame?.bodyStyle }, [
					h(WidgetSlot, { name: 'content' }),
				]),
				h(WidgetSlot, { name: 'footer' }),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 3. Text Widget Plugin & Renderer
// ---------------------------------------------------------------------------
type TextVariant = 'display' | 'headline' | 'title' | 'body' | 'ui' | 'label' | 'mono' | 'h1' | 'h2' | 'h3' | 'h4' | 'caption' | 'code'
type TextTone = 'default' | 'highlighted' | 'muted' | 'subtle' | 'primary' | 'annotation' | 'success' | 'warning' | 'danger' | 'info'
export interface TextPresentation {
	variant?: TextVariant
	truncate?: boolean
	/** Clamp to this many lines with an ellipsis. */
	lines?: number
	align?: 'start' | 'center' | 'end'
	hidden?: boolean
}

export interface TextInterfaces {
	config: {
		raw: (TextPresentation & {
			text?: string
			textKey?: string
			/** Interpolated into a translated template as `{value}`. */
			value?: string | number
			weight?: 'normal' | 'medium' | 'semibold' | 'bold'
			tone?: TextTone
			mono?: boolean
			/** Semantic heading level for the rendered element, independent of the visual variant. */
			level?: 1 | 2 | 3 | 4
			responsive?: Responsive<TextPresentation>
		}) | null
		resolved: {
			text: string
			textKey: string | null
			value: string
			weight: string
			tone: string
			mono: boolean
			level: number
			base: TextPresentation
			responsive?: Responsive<TextPresentation>
		}
	}
	properties: {
		valueText: string
		textResult: TranslationResult
		text: string
		weight: string
		tone: string
		mono: boolean
		level: number
		presentation: { variant: TextVariant; truncate: boolean; lines: number; align: string; hidden: boolean }
		theme: string
	}
}

export const textPlugin = createWidgetPlugin('Text')
	.description('Typography element on the Quiet Canvas scale (display, headline, title, body, ui, label, mono) with tonal accents and translatable text.')
	.interfaces<TextInterfaces>()
	.config({
		description: 'Text configuration. `text` accepts an `$i18n` binding (lowered to `textKey`); `{value}` interpolates `value`. Legacy variants h1–h4, caption and code map onto the same scale; nothing renders below 12px.',
		schema: configSchema({
			text: { type: 'string' },
			textKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			variant: { enum: ['display', 'headline', 'title', 'body', 'ui', 'label', 'mono', 'h1', 'h2', 'h3', 'h4', 'caption', 'code'] },
			weight: { enum: ['normal', 'medium', 'semibold', 'bold'] },
			tone: { enum: ['default', 'highlighted', 'muted', 'subtle', 'primary', 'annotation', 'success', 'warning', 'danger', 'info'] },
			mono: { type: 'boolean' },
			level: { enum: [1, 2, 3, 4] },
			truncate: { type: 'boolean' },
			lines: { type: 'number' },
			align: { enum: ['start', 'center', 'end'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is TextInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { text, textKey, value, weight, tone, mono, level, ...presentation } = raw ?? {}
			return {
				text: typeof text === 'string' ? text : '',
				textKey: optionalString(textKey),
				value: value === undefined ? '' : String(value),
				weight: weight ?? '',
				tone: tone ?? 'default',
				mono: Boolean(mono),
				level: typeof level === 'number' ? level : 0,
				...splitResponsive<TextPresentation>(presentation),
			}
		},
	})
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.textResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({ ...translateDeps({ dep }), value: dep.self.properties.get('valueText') }),
			compute: ({ config, deps }) => translateField(config.textKey, config.text, (key, params) => deps.t(key, params), {
				value: stringFromResult(deps.value()),
			}),
		})
		.text({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('textResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.weight({ compute: ({ config }) => config.weight })
		.tone({ compute: ({ config }) => config.tone })
		.mono({ compute: ({ config }) => config.mono })
		.level({ compute: ({ config }) => config.level })
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return {
					variant: presentation.variant ?? 'body',
					truncate: Boolean(presentation.truncate),
					lines: typeof presentation.lines === 'number' ? presentation.lines : 0,
					align: presentation.align ?? 'start',
					hidden: Boolean(presentation.hidden),
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

const TEXT_TAGS: Record<TextVariant, string> = {
	display: 'p', headline: 'p', title: 'p', body: 'p', ui: 'span', label: 'span', mono: 'code',
	h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', code: 'code', caption: 'span',
}

export const TextRenderer = defineComponent({
	name: 'TextRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(textPlugin)
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const variant = presentation?.variant ?? 'body'
			const level = props.level.value ?? 0
			const tag = level >= 1 && level <= 4 ? `h${level}` : TEXT_TAGS[variant]
			const style: CssStyle = {}
			if (presentation?.align && presentation.align !== 'start') style.textAlign = presentation.align
			if (presentation?.lines) style.webkitLineClamp = String(presentation.lines)
			return h(tag, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: [
					'uiux-ref-scope',
					'uiux-ref-text',
					props.theme.value,
					`variant-${variant}`,
					props.weight.value ? `weight-${props.weight.value}` : '',
					props.tone.value !== 'default' ? `tone-${props.tone.value}` : '',
					props.mono.value ? 'is-mono' : '',
					presentation?.truncate ? 'is-truncate' : '',
					presentation?.lines ? 'is-clamped' : '',
					presentation?.hidden ? 'uiux-ref-hidden' : '',
				],
				style,
			}, props.text.value ?? '')
		}
	},
})

// ---------------------------------------------------------------------------
// 4. Button Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface ButtonPresentation {
	size?: 'sm' | 'md' | 'lg'
	/** Shows only the icon; the translated label stays available as the accessible name. */
	iconOnly?: boolean
	fullWidth?: boolean
	hidden?: boolean
	/** Hide the keyboard shortcut hint (touch tiers). */
	hideKbd?: boolean
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'annotation' | 'link' | 'brand' | 'display'

export interface ButtonInterfaces {
	config: {
		raw: (ButtonPresentation & {
			label?: string
			labelKey?: string
			variant?: ButtonVariant
			disabled?: boolean
			icon?: string
			trailingIcon?: string
			kbd?: string
			responsive?: Responsive<ButtonPresentation>
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			variant: string
			disabled: boolean
			icon: string
			trailingIcon: string
			kbd: string
			base: ButtonPresentation
			responsive?: Responsive<ButtonPresentation>
		}
	}
	state: {
		disabled: boolean
		visible: boolean
	}
	events: {
		click: readonly []
	}
	properties: {
		labelResult: TranslationResult
		label: string
		variant: string
		icon: string
		presentation: { size: string; iconOnly: boolean; fullWidth: boolean; hidden: boolean; touch: boolean; kbd: string; trailingIcon: string }
		theme: string
	}
}

export const buttonPlugin = createWidgetPlugin('Button')
	.description('Button with translatable label, Lucide icon, optional trailing icon and shortcut hint, neutral-outline default, one solid primary per region, and 44px targets on touch tiers.')
	.interfaces<ButtonInterfaces>()
	.config({
		description: 'Button configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`). `icon` and `trailingIcon` take Lucide names.',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			variant: { enum: ['primary', 'secondary', 'ghost', 'outline', 'danger', 'annotation', 'link', 'brand', 'display'] },
			size: { enum: ['sm', 'md', 'lg'] },
			disabled: { type: 'boolean' },
			icon: { type: 'string' },
			trailingIcon: { type: 'string' },
			kbd: { type: 'string' },
			iconOnly: { type: 'boolean' },
			fullWidth: { type: 'boolean' },
			hidden: { type: 'boolean' },
			hideKbd: { type: 'boolean' },
		}),
		validate: (c): c is ButtonInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, variant, disabled, icon, trailingIcon, kbd, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : 'Button',
				labelKey: optionalString(labelKey),
				variant: variant ?? 'secondary',
				disabled: Boolean(disabled),
				icon: typeof icon === 'string' ? icon : '',
				trailingIcon: typeof trailingIcon === 'string' ? trailingIcon : '',
				kbd: typeof kbd === 'string' ? kbd : '',
				...splitResponsive<ButtonPresentation>(presentation),
			}
		},
	})
	.state(state => state
		.disabled({
			authorWritable: true,
			validate: isBoolean,
			default: ({ config }) => config.disabled,
		})
		.visible(visibleState))
	.properties(p => p
		.labelResult(translatedResult<ButtonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<ButtonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.variant({ compute: ({ config }) => config.variant })
		.icon({ compute: ({ config }) => config.icon })
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				const presentation = cascade(config.base, config.responsive, tier)
				return {
					size: presentation.size ?? 'md',
					iconOnly: Boolean(presentation.iconOnly && config.icon),
					fullWidth: Boolean(presentation.fullWidth),
					hidden: Boolean(presentation.hidden),
					touch: isTouchTier(tier),
					kbd: presentation.hideKbd || isTouchTier(tier) ? '' : config.kbd,
					trailingIcon: config.trailingIcon,
				}
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired on user button click' }))
	.done()

export const ButtonRenderer = defineComponent({
	name: 'ButtonRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(buttonPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			return h(KitButton, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				label: props.label.value ?? '',
				variant: props.variant.value as ButtonVariant,
				size: (presentation?.size ?? 'md') as 'sm' | 'md' | 'lg',
				icon: props.icon.value || undefined,
				trailingIcon: presentation?.trailingIcon || undefined,
				kbd: presentation?.kbd || undefined,
				iconOnly: Boolean(presentation?.iconOnly),
				fullWidth: Boolean(presentation?.fullWidth),
				touch: Boolean(presentation?.touch),
				disabled: Boolean(state.disabled.value),
				class: [
					'uiux-ref-scope',
					props.theme.value,
					presentation?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				onClick: () => {
					if (!state.disabled.value) emit.click()
				},
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 5. Badge Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface BadgePresentation {
	hidden?: boolean
}

type BadgeTone = 'neutral' | 'primary' | 'annotation' | 'success' | 'warning' | 'danger' | 'info'
type BadgeVariant = 'subtle' | 'soft' | 'solid' | 'outline' | 'mono' | 'count'

export interface BadgeInterfaces {
	config: {
		raw: (BadgePresentation & {
			label?: string
			labelKey?: string
			/** Interpolated into a translated template as `{value}`. */
			value?: string | number
			tone?: BadgeTone
			variant?: 'subtle' | 'soft' | 'solid' | 'outline' | 'mono' | 'count'
			icon?: string
			responsive?: Responsive<BadgePresentation>
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			value: string
			tone: string
			variant: string
			icon: string
			base: BadgePresentation
			responsive?: Responsive<BadgePresentation>
		}
	}
	properties: {
		valueText: string
		contextViewportId: string
		contextViewport: string
		contextLocale: string
		contextTheme: string
		labelResult: TranslationResult
		label: string
		tone: string
		variant: string
		icon: string
		hidden: boolean
		theme: string
	}
}

export const badgePlugin = createWidgetPlugin('Badge')
	.description('Status badge, mono identity chip, or count; carries a leading Lucide icon so color is never the only signal. Translated labels may interpolate {value} and the live render context ({viewportId}, {viewport}, {locale}, {theme}).')
	.interfaces<BadgeInterfaces>()
	.config({
		description: 'Badge configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`). `variant: "mono"` is the blueprint identity chip; `variant: "count"` is a count pill.',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			tone: { enum: ['neutral', 'primary', 'annotation', 'success', 'warning', 'danger', 'info'] },
			variant: { enum: ['subtle', 'soft', 'solid', 'outline', 'mono', 'count'] },
			icon: { type: 'string' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is BadgeInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, value, tone, variant, icon, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : '',
				labelKey: optionalString(labelKey),
				value: value === undefined ? '' : String(value),
				tone: tone ?? 'neutral',
				variant: variant ?? 'subtle',
				icon: typeof icon === 'string' ? icon : '',
				...splitResponsive<BadgePresentation>(presentation),
			}
		},
	})
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.contextViewportId({
			valueContract: STRING,
			registerDeps: viewportDeps,
			compute: ({ deps }) => readViewport(deps.viewport())?.id ?? '',
		})
		.contextViewport({
			valueContract: STRING,
			registerDeps: viewportDeps,
			compute: ({ deps }) => {
				const viewport = readViewport(deps.viewport())
				return viewport ? `${viewport.width} × ${viewport.height}` : ''
			},
		})
		.contextLocale({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ locale: dep.root.state.get('locale') }),
			compute: ({ deps }) => stringFromResult(deps.locale()),
		})
		.contextTheme({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ themeId: dep.root.state.get('themeId') }),
			compute: ({ deps }) => stringFromResult(deps.themeId()),
		})
		.labelResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({
				...translateDeps({ dep }),
				value: dep.self.properties.get('valueText'),
				viewportId: dep.self.properties.get('contextViewportId'),
				viewport: dep.self.properties.get('contextViewport'),
				locale: dep.self.properties.get('contextLocale'),
				theme: dep.self.properties.get('contextTheme'),
			}),
			compute: ({ config, deps }) => translateField(config.labelKey, config.label, (key, params) => deps.t(key, params), {
				value: stringFromResult(deps.value()),
				viewportId: stringFromResult(deps.viewportId()),
				viewport: stringFromResult(deps.viewport()),
				locale: stringFromResult(deps.locale()),
				theme: stringFromResult(deps.theme()),
			}),
		})
		.label({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('labelResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.tone({ compute: ({ config }) => config.tone })
		.variant({ compute: ({ config }) => config.variant })
		.icon({ compute: ({ config }) => config.icon })
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => Boolean(cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport()))).hidden),
		})
		.theme(themeProperty()),
	)
	.done()

export const BadgeRenderer = defineComponent({
	name: 'BadgeRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(badgePlugin)
		const props = useProperties()

		return (): VNode => h(KitBadge, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			label: props.label.value ?? '',
			tone: props.tone.value as BadgeTone,
			variant: props.variant.value as BadgeVariant,
			icon: props.icon.value || undefined,
			class: [
				'uiux-ref-scope',
				props.theme.value,
				props.hidden.value ? 'uiux-ref-hidden' : '',
			],
		})
	},
})

// ---------------------------------------------------------------------------
// 6. TextInput Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface TextInputPresentation {
	hidden?: boolean
	hideKbd?: boolean
}

export interface TextInputInterfaces {
	config: {
		raw: (TextInputPresentation & {
			value?: string
			placeholder?: string
			placeholderKey?: string
			readOnly?: boolean
			label?: string
			labelKey?: string
			help?: string
			helpKey?: string
			error?: string
			errorKey?: string
			invalid?: boolean
			icon?: string
			kbd?: string
			mono?: boolean
			/** Renders a textarea with this many rows. */
			rows?: number
			responsive?: Responsive<TextInputPresentation>
		}) | null
		resolved: {
			value: string
			placeholder: string
			placeholderKey: string | null
			readOnly: boolean
			label: string
			labelKey: string | null
			help: string
			helpKey: string | null
			error: string
			errorKey: string | null
			invalid: boolean
			icon: string
			kbd: string
			mono: boolean
			rows: number
			base: TextInputPresentation
			responsive?: Responsive<TextInputPresentation>
		}
	}
	state: {
		value: string
		invalid: boolean
	}
	properties: {
		placeholderResult: TranslationResult
		placeholder: string
		labelResult: TranslationResult
		label: string
		helpResult: TranslationResult
		help: string
		errorResult: TranslationResult
		error: string
		readOnly: boolean
		presentation: { hidden: boolean; touch: boolean; kbd: string; icon: string; mono: boolean; rows: number }
		theme: string
	}
}

export const textInputPlugin = createWidgetPlugin('TextInput')
	.description('Text field or textarea with translatable label, placeholder, help and error text, leading Lucide icon, shortcut hint, and an author-writable `invalid` state.')
	.interfaces<TextInputInterfaces>()
	.config({
		description: 'TextInput configuration. `placeholder`, `label`, `help` and `error` accept `$i18n` bindings (lowered to `placeholderKey`, `labelKey`, `helpKey`, `errorKey`). The error text shows only while `invalid` is true.',
		schema: configSchema({
			value: { type: 'string' },
			placeholder: { type: 'string' },
			placeholderKey: { type: 'string' },
			readOnly: { type: 'boolean' },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			help: { type: 'string' },
			helpKey: { type: 'string' },
			error: { type: 'string' },
			errorKey: { type: 'string' },
			invalid: { type: 'boolean' },
			icon: { type: 'string' },
			kbd: { type: 'string' },
			mono: { type: 'boolean' },
			rows: { type: 'number' },
			hidden: { type: 'boolean' },
			hideKbd: { type: 'boolean' },
		}),
		validate: (c): c is TextInputInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { value, placeholder, placeholderKey, readOnly, label, labelKey, help, helpKey, error, errorKey, invalid, icon, kbd, mono, rows, ...presentation } = raw ?? {}
			return {
				value: typeof value === 'string' ? value : '',
				placeholder: typeof placeholder === 'string' ? placeholder : '',
				placeholderKey: optionalString(placeholderKey),
				readOnly: Boolean(readOnly),
				label: typeof label === 'string' ? label : '',
				labelKey: optionalString(labelKey),
				help: typeof help === 'string' ? help : '',
				helpKey: optionalString(helpKey),
				error: typeof error === 'string' ? error : '',
				errorKey: optionalString(errorKey),
				invalid: Boolean(invalid),
				icon: typeof icon === 'string' ? icon : '',
				kbd: typeof kbd === 'string' ? kbd : '',
				mono: Boolean(mono),
				rows: typeof rows === 'number' ? rows : 0,
				...splitResponsive<TextInputPresentation>(presentation),
			}
		},
	})
	.state(state => state
		.value({
			authorWritable: true,
			validate: (v): v is string => typeof v === 'string',
			default: ({ config }) => config.value,
		})
		.invalid({
			authorWritable: true,
			validate: isBoolean,
			default: ({ config }) => config.invalid,
		}))
	.properties(p => p
		.placeholderResult(translatedResult<TextInputInterfaces['config']['resolved']>(c => ({ key: c.placeholderKey, literal: c.placeholder })))
		.placeholder(translatedText<TextInputInterfaces['config']['resolved']>(c => ({ key: c.placeholderKey, literal: c.placeholder })))
		.labelResult(translatedResult<TextInputInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<TextInputInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.helpResult(translatedResult<TextInputInterfaces['config']['resolved']>(c => ({ key: c.helpKey, literal: c.help })))
		.help(translatedText<TextInputInterfaces['config']['resolved']>(c => ({ key: c.helpKey, literal: c.help })))
		.errorResult(translatedResult<TextInputInterfaces['config']['resolved']>(c => ({ key: c.errorKey, literal: c.error })))
		.error(translatedText<TextInputInterfaces['config']['resolved']>(c => ({ key: c.errorKey, literal: c.error })))
		.readOnly({ compute: ({ config }) => config.readOnly })
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				const presentation = cascade(config.base, config.responsive, tier)
				return {
					hidden: Boolean(presentation.hidden),
					touch: isTouchTier(tier),
					kbd: presentation.hideKbd || isTouchTier(tier) ? '' : config.kbd,
					icon: config.icon,
					mono: config.mono,
					rows: config.rows,
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const TextInputRenderer = defineComponent({
	name: 'TextInputRenderer',
	setup() {
		const { widgetId, useState, useProperties } = useWidget(textInputPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			return h(KitField, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				id: `${widgetId}-field`,
				modelValue: state.value.value ?? '',
				label: props.label.value ?? '',
				placeholder: props.placeholder.value ?? '',
				help: props.help.value ?? '',
				error: props.error.value ?? '',
				invalid: Boolean(state.invalid.value),
				readonly: Boolean(props.readOnly.value),
				icon: presentation?.icon || undefined,
				kbd: presentation?.kbd || undefined,
				mono: Boolean(presentation?.mono),
				rows: presentation?.rows || undefined,
				touch: Boolean(presentation?.touch),
				'onUpdate:modelValue': (value: string) => {
					if (!props.readOnly.value) state.value.value = value
				},
				class: ['uiux-ref-scope', props.theme.value, presentation?.hidden ? 'uiux-ref-hidden' : ''],
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 7. NavItem Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface NavItemPresentation {
	/** Shows only the icon (and badge); the translated label stays available as the accessible name. */
	iconOnly?: boolean
	hideMeta?: boolean
	hidden?: boolean
}

export interface NavItemInterfaces {
	config: {
		raw: (NavItemPresentation & {
			label?: string
			labelKey?: string
			icon?: string
			meta?: string
			metaKey?: string
			badge?: string
			badgeKey?: string
			badgeTone?: 'neutral' | 'annotation'
			selected?: boolean
			responsive?: Responsive<NavItemPresentation>
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			icon: string
			meta: string
			metaKey: string | null
			badge: string
			badgeKey: string | null
			badgeTone: string
			selected: boolean
			base: NavItemPresentation
			responsive?: Responsive<NavItemPresentation>
		}
	}
	state: {
		selected: boolean
	}
	events: {
		click: readonly []
	}
	properties: {
		labelResult: TranslationResult
		label: string
		metaResult: TranslationResult
		meta: string
		badgeResult: TranslationResult
		badge: string
		icon: string
		badgeTone: string
		presentation: { iconOnly: boolean; hideMeta: boolean; hidden: boolean }
		theme: string
	}
}

export const navItemPlugin = createWidgetPlugin('NavItem')
	.description('Sidebar navigation row: Lucide icon, translatable label, count badge (annotation-colored for unresolved comments), selection with a 2px Iris inset bar, and an icon-only rail mode.')
	.interfaces<NavItemInterfaces>()
	.config({
		description: 'NavItem configuration. `label`, `meta`, and `badge` accept `$i18n` bindings (lowered to `labelKey`, `metaKey`, `badgeKey`).',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			icon: { type: 'string' },
			meta: { type: 'string' },
			metaKey: { type: 'string' },
			badge: { type: 'string' },
			badgeKey: { type: 'string' },
			badgeTone: { enum: ['neutral', 'annotation'] },
			selected: { type: 'boolean' },
			iconOnly: { type: 'boolean' },
			hideMeta: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is NavItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, icon, meta, metaKey, badge, badgeKey, badgeTone, selected, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : 'Item',
				labelKey: optionalString(labelKey),
				icon: typeof icon === 'string' ? icon : '',
				meta: typeof meta === 'string' ? meta : '',
				metaKey: optionalString(metaKey),
				badge: typeof badge === 'string' ? badge : '',
				badgeKey: optionalString(badgeKey),
				badgeTone: badgeTone ?? 'neutral',
				selected: Boolean(selected),
				...splitResponsive<NavItemPresentation>(presentation),
			}
		},
	})
	.state(state => state.selected({
		authorWritable: true,
		validate: isBoolean,
		default: ({ config }) => config.selected,
	}))
	.properties(p => p
		.labelResult(translatedResult<NavItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<NavItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.metaResult(translatedResult<NavItemInterfaces['config']['resolved']>(c => ({ key: c.metaKey, literal: c.meta })))
		.meta(translatedText<NavItemInterfaces['config']['resolved']>(c => ({ key: c.metaKey, literal: c.meta })))
		.badgeResult(translatedResult<NavItemInterfaces['config']['resolved']>(c => ({ key: c.badgeKey, literal: c.badge })))
		.badge(translatedText<NavItemInterfaces['config']['resolved']>(c => ({ key: c.badgeKey, literal: c.badge })))
		.icon({ compute: ({ config }) => config.icon })
		.badgeTone({ compute: ({ config }) => config.badgeTone })
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return {
					iconOnly: Boolean(presentation.iconOnly && config.icon),
					hideMeta: Boolean(presentation.hideMeta),
					hidden: Boolean(presentation.hidden),
				}
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when nav item is selected' }))
	.done()

export const NavItemRenderer = defineComponent({
	name: 'NavItemRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(navItemPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const label = props.label.value ?? ''
			const leftChildren: (VNode | null)[] = [iconNode(props.icon.value, 16)]
			if (!presentation?.iconOnly) leftChildren.push(h('span', { class: 'uiux-ref-nav-item-label' }, label))

			const rightChildren: VNode[] = []
			if (props.meta.value && !presentation?.hideMeta && !presentation?.iconOnly)
				rightChildren.push(h('span', { class: 'uiux-ref-nav-item-meta' }, props.meta.value))
			if (props.badge.value)
				rightChildren.push(h(KitBadge, { variant: 'count', tone: props.badgeTone.value === 'annotation' ? 'annotation' : 'neutral', label: props.badge.value }))

			const select = () => {
				state.selected.value = true
				emit.click()
			}

			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: 'link',
				tabindex: 0,
				'aria-current': state.selected.value ? 'page' : undefined,
				'aria-label': presentation?.iconOnly ? (props.badge.value ? `${label}, ${props.badge.value}` : label) : undefined,
				title: presentation?.iconOnly ? label : undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-nav-item',
					props.theme.value,
					state.selected.value ? 'is-selected' : '',
					presentation?.iconOnly ? 'is-icon-only' : '',
					presentation?.hidden ? 'uiux-ref-hidden' : '',
				],
				onClick: select,
				onKeydown: (event: KeyboardEvent) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault()
						select()
					}
				},
			}, [
				h('div', { class: 'uiux-ref-nav-item-content' }, leftChildren),
				...rightChildren,
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 8. Divider Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface DividerPresentation {
	orientation?: 'horizontal' | 'vertical'
	spacing?: number | string
	hidden?: boolean
}

export interface DividerInterfaces {
	config: {
		raw: (DividerPresentation & { responsive?: Responsive<DividerPresentation> }) | null
		resolved: { base: DividerPresentation; responsive?: Responsive<DividerPresentation> }
	}
	properties: {
		presentation: { orientation: 'horizontal' | 'vertical'; spacing: string; hidden: boolean }
		theme: string
	}
}

export const dividerPlugin = createWidgetPlugin('Divider')
	.description('Hairline separator for dividing layout sections, with viewport-tier overrides.')
	.interfaces<DividerInterfaces>()
	.config({
		description: 'Divider configuration',
		schema: configSchema({
			orientation: { enum: ['horizontal', 'vertical'] },
			spacing: { type: ['number', 'string'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is DividerInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => splitResponsive<DividerPresentation>(raw),
	})
	.properties(p => p
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return {
					orientation: presentation.orientation === 'vertical' ? 'vertical' as const : 'horizontal' as const,
					spacing: px(presentation.spacing, '8px'),
					hidden: Boolean(presentation.hidden),
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const DividerRenderer = defineComponent({
	name: 'DividerRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(dividerPlugin)
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const isHorizontal = presentation?.orientation !== 'vertical'
			const spacing = presentation?.spacing ?? '8px'
			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: 'separator',
				'aria-orientation': isHorizontal ? 'horizontal' : 'vertical',
				class: [
					'uiux-ref-scope',
					'uiux-ref-divider',
					props.theme.value,
					isHorizontal ? 'is-horizontal' : 'is-vertical',
					presentation?.hidden ? 'uiux-ref-hidden' : '',
				],
				style: isHorizontal ? { margin: `${spacing} 0` } : { margin: `0 ${spacing}` },
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 9. Avatar — initials for people, a bot glyph for agents, a cog for the system
// ---------------------------------------------------------------------------
type ActorKind = 'human' | 'agent' | 'system'
const ACTOR_KINDS: readonly ActorKind[] = ['human', 'agent', 'system']

function actorFace(kind: string, initials: string, size: number): VNode | string | null {
	if (kind === 'agent') return iconNode('bot', size)
	if (kind === 'system') return iconNode('cog', size)
	return initials
}

export interface AvatarPresentation {
	size?: number
	hidden?: boolean
}

export interface AvatarInterfaces {
	config: {
		raw: (AvatarPresentation & {
			initials?: string
			actor?: ActorKind
			tone?: 'neutral' | 'annotation' | 'primary'
			label?: string
			labelKey?: string
			responsive?: Responsive<AvatarPresentation>
		}) | null
		resolved: { initials: string; actor: ActorKind; tone: string; label: string; labelKey: string | null; base: AvatarPresentation; responsive?: Responsive<AvatarPresentation> }
	}
	properties: {
		labelResult: TranslationResult
		label: string
		face: { initials: string; actor: ActorKind; tone: string; size: number; hidden: boolean }
		theme: string
	}
}

export const avatarPlugin = createWidgetPlugin('Avatar')
	.description('Round author mark: initials for people, a bot glyph for agents, a cog for the system. Reviewers are never told apart by color alone.')
	.interfaces<AvatarInterfaces>()
	.config({
		description: 'Avatar configuration. `label` (accessible name) accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			initials: { type: 'string' },
			actor: { enum: ['human', 'agent', 'system'] },
			tone: { enum: ['neutral', 'annotation', 'primary'] },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			size: { type: 'number' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is AvatarInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { initials, actor, tone, label, labelKey, ...presentation } = raw ?? {}
			return {
				initials: stringOr(initials, ''),
				actor: oneOf(actor, ACTOR_KINDS, 'human'),
				tone: tone ?? 'neutral',
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				...splitResponsive<AvatarPresentation>(presentation),
			}
		},
	})
	.properties(p => p
		.labelResult(translatedResult<AvatarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<AvatarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.face({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return { initials: config.initials, actor: config.actor, tone: config.tone, size: presentation.size ?? 24, hidden: Boolean(presentation.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const AvatarRenderer = defineComponent({
	name: 'AvatarRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(avatarPlugin)
		const props = useProperties()
		return (): VNode => {
			const face = props.face.value
			const size = face?.size ?? 24
			const label = props.label.value
			return h('span', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: label ? 'img' : undefined,
				'aria-label': label || undefined,
				'aria-hidden': label ? undefined : 'true',
				class: ['uiux-ref-scope', 'uiux-ref-avatar', props.theme.value, `tone-${face?.tone ?? 'neutral'}`, face?.hidden ? 'uiux-ref-hidden' : ''],
				style: { width: `${size}px`, height: `${size}px`, fontSize: size >= 28 ? '12px' : '12px' },
			}, [actorFace(face?.actor ?? 'human', face?.initials ?? '', Math.round(size * 0.58))])
		}
	},
})

// ---------------------------------------------------------------------------
// 10. Kbd — a literal keyboard shortcut
// ---------------------------------------------------------------------------
export interface KbdInterfaces {
	config: {
		raw: ({ keys?: string; hidden?: boolean; responsive?: Responsive<{ hidden?: boolean }> }) | null
		resolved: { keys: string; base: { hidden?: boolean }; responsive?: Responsive<{ hidden?: boolean }> }
	}
	properties: { keys: string; hidden: boolean; theme: string }
}

export const kbdPlugin = createWidgetPlugin('Kbd')
	.description('Keyboard shortcut key cap in the mono blueprint register. Keys are literal and never translated; hidden on touch tiers by default.')
	.interfaces<KbdInterfaces>()
	.config({
		description: 'Kbd configuration. `keys` is a literal such as "⌘K", "C" or "Esc".',
		schema: configSchema({ keys: { type: 'string' }, hidden: { type: 'boolean' } }),
		validate: (c): c is KbdInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { keys, ...presentation } = raw ?? {}
			return { keys: stringOr(keys, ''), ...splitResponsive<{ hidden?: boolean }>(presentation) }
		},
	})
	.properties(p => p
		.keys({ compute: ({ config }) => config.keys })
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				return Boolean(cascade(config.base, config.responsive, tier).hidden) || isTouchTier(tier)
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const KbdRenderer = defineComponent({
	name: 'KbdRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(kbdPlugin)
		const props = useProperties()
		return (): VNode => h(KitKbd, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			keys: props.keys.value ?? '',
			class: ['uiux-ref-scope', props.theme.value, props.hidden.value ? 'uiux-ref-hidden' : ''],
		})
	},
})

// ---------------------------------------------------------------------------
// 11. Pin — Figma-like teardrop comment marker whose bottom-left tip marks the anchor point
// ---------------------------------------------------------------------------
type PinStatus = 'open' | 'ready' | 'resolved' | 'pending'
const PIN_STATUSES: readonly PinStatus[] = ['open', 'ready', 'resolved', 'pending']

export interface PinPlacement {
	/** Tip position inside the positioned parent, as a CSS length or percentage. */
	x?: string
	y?: string
	hidden?: boolean
}

export interface PinInterfaces {
	config: {
		raw: (PinPlacement & {
			initials?: string
			actor?: ActorKind
			status?: PinStatus
			selected?: boolean
			label?: string
			labelKey?: string
			responsive?: Responsive<PinPlacement>
		}) | null
		resolved: { initials: string; actor: ActorKind; status: PinStatus; selected: boolean; label: string; labelKey: string | null; base: PinPlacement; responsive?: Responsive<PinPlacement> }
	}
	state: { status: PinStatus; selected: boolean; visible: boolean }
	events: { click: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		mark: { initials: string; actor: ActorKind }
		placement: { style: CssStyle; hidden: boolean }
		theme: string
	}
}

export const pinPlugin = createWidgetPlugin('Pin')
	.description('Comment pin: a 28px Marker teardrop with the starter\'s initials (or a bot glyph for agents). States: open, ready (notice-blue eye badge), resolved (24px graphite check), pending (dashed). Selected pins get a 2px Iris ring.')
	.interfaces<PinInterfaces>()
	.config({
		description: 'Pin configuration. `label` is the accessible name and accepts an `$i18n` binding (lowered to `labelKey`). `x`/`y` place the tip inside the positioned parent.',
		schema: configSchema({
			initials: { type: 'string' },
			actor: { enum: ['human', 'agent', 'system'] },
			status: { enum: ['open', 'ready', 'resolved', 'pending'] },
			selected: { type: 'boolean' },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			x: { type: 'string' },
			y: { type: 'string' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is PinInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { initials, actor, status, selected, label, labelKey, ...placement } = raw ?? {}
			return {
				initials: stringOr(initials, ''),
				actor: oneOf(actor, ACTOR_KINDS, 'human'),
				status: oneOf(status, PIN_STATUSES, 'open'),
				selected: Boolean(selected),
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				...splitResponsive<PinPlacement>(placement),
			}
		},
	})
	.state(state => state
		.status({ authorWritable: true, validate: (v): v is PinStatus => typeof v === 'string' && (PIN_STATUSES as readonly string[]).includes(v), default: ({ config }) => config.status })
		.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected })
		.visible(visibleState))
	.properties(p => p
		.labelResult(translatedResult<PinInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<PinInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.mark({ compute: ({ config }) => ({ initials: config.initials, actor: config.actor }) })
		.placement({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const placement = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return { style: { left: placement.x ?? '0', top: placement.y ?? '0' }, hidden: Boolean(placement.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when the pin is clicked to open its thread bubble' }))
	.done()

export const PinRenderer = defineComponent({
	name: 'PinRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(pinPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const status = state.status.value
			const mark = props.mark.value
			const placement = props.placement.value
			return h(KitCommentPin, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				label: props.label.value ?? '',
				title: props.label.value || undefined,
				variant: status === 'resolved' || status === 'pending' ? status : 'default',
				badge: status === 'ready' ? 'ready' : undefined,
				initials: mark?.initials ?? '',
				actor: mark?.actor ?? 'human',
				open: Boolean(state.selected.value),
				class: [
					'uiux-ref-scope',
					'uiux-ref-pin',
					props.theme.value,
					placement?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				style: placement?.style,
				onActivate: () => emit.click(),
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 12. Bubble — thread or composer popover anchored at a pin; a bottom sheet on phones
// ---------------------------------------------------------------------------
type BubblePlacement = 'anchored' | 'sheet' | 'inline'
export interface BubbleLayout {
	x?: string
	y?: string
	width?: string
	placement?: BubblePlacement
	hidden?: boolean
}

export interface BubbleInterfaces {
	config: {
		raw: (BubbleLayout & {
			title?: string
			titleKey?: string
			statusLabel?: string
			statusLabelKey?: string
			status?: 'open' | 'ready' | 'resolved'
			target?: string
			context?: string
			contextKey?: string
			open?: boolean
			closeLabel?: string
			closeLabelKey?: string
			responsive?: Responsive<BubbleLayout>
		}) | null
		resolved: {
			title: string
			titleKey: string | null
			statusLabel: string
			statusLabelKey: string | null
			status: 'open' | 'ready' | 'resolved'
			target: string
			context: string
			contextKey: string | null
			open: boolean
			closeLabel: string
			closeLabelKey: string | null
			base: BubbleLayout
			responsive?: Responsive<BubbleLayout>
		}
	}
	slots: 'content' | 'footer'
	state: { open: boolean; status: 'open' | 'ready' | 'resolved' }
	events: { close: readonly [] }
	properties: {
		titleResult: TranslationResult
		title: string
		statusLabelResult: TranslationResult
		statusLabel: string
		contextResult: TranslationResult
		context: string
		closeLabelResult: TranslationResult
		closeLabel: string
		target: string
		layout: { style: CssStyle; placement: BubblePlacement; hidden: boolean }
		theme: string
	}
}

const BUBBLE_STATUS_ICON: Record<string, string> = { open: 'circle-dot', ready: 'eye', resolved: 'circle-check' }
const BUBBLE_STATUS_TONE: Record<string, string> = { open: 'annotation', ready: 'info', resolved: 'success' }

export const bubblePlugin = createWidgetPlugin('Bubble')
	.description('Thread bubble: a 320px, 12px-radius overlay card with title, status badge, target chip, timeline body and reply footer. `placement` is anchored (absolute at x/y), sheet (bottom sheet with grip), or inline (detail pane). Author-writable `open` and `status` states drive Variants.')
	.interfaces<BubbleInterfaces>()
	.config({
		description: 'Bubble configuration. `title`, `statusLabel`, `context` and `closeLabel` accept `$i18n` bindings. `target` is a literal blueprint chip such as "Button · #checkout-submit".',
		schema: configSchema({
			title: { type: 'string' },
			titleKey: { type: 'string' },
			statusLabel: { type: 'string' },
			statusLabelKey: { type: 'string' },
			status: { enum: ['open', 'ready', 'resolved'] },
			target: { type: 'string' },
			context: { type: 'string' },
			contextKey: { type: 'string' },
			open: { type: 'boolean' },
			closeLabel: { type: 'string' },
			closeLabelKey: { type: 'string' },
			x: { type: 'string' },
			y: { type: 'string' },
			width: { type: 'string' },
			placement: { enum: ['anchored', 'sheet', 'inline'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is BubbleInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { title, titleKey, statusLabel, statusLabelKey, status, target, context, contextKey, open, closeLabel, closeLabelKey, ...layout } = raw ?? {}
			return {
				title: stringOr(title, ''),
				titleKey: optionalString(titleKey),
				statusLabel: stringOr(statusLabel, ''),
				statusLabelKey: optionalString(statusLabelKey),
				status: oneOf(status, ['open', 'ready', 'resolved'] as const, 'open'),
				target: stringOr(target, ''),
				context: stringOr(context, ''),
				contextKey: optionalString(contextKey),
				open: open === undefined ? true : Boolean(open),
				closeLabel: stringOr(closeLabel, 'Close'),
				closeLabelKey: optionalString(closeLabelKey),
				...splitResponsive<BubbleLayout>(layout),
			}
		},
	})
	.slots({
		content: { description: 'Timeline items and inline notices' },
		footer: { description: 'Reply field and lifecycle actions' },
	})
	.state(state => state
		.open({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.open })
		.status({ authorWritable: true, validate: (v): v is 'open' | 'ready' | 'resolved' => v === 'open' || v === 'ready' || v === 'resolved', default: ({ config }) => config.status }))
	.properties(p => p
		.titleResult(translatedResult<BubbleInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedText<BubbleInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.statusLabelResult(translatedResult<BubbleInterfaces['config']['resolved']>(c => ({ key: c.statusLabelKey, literal: c.statusLabel })))
		.statusLabel(translatedText<BubbleInterfaces['config']['resolved']>(c => ({ key: c.statusLabelKey, literal: c.statusLabel })))
		.contextResult(translatedResult<BubbleInterfaces['config']['resolved']>(c => ({ key: c.contextKey, literal: c.context })))
		.context(translatedText<BubbleInterfaces['config']['resolved']>(c => ({ key: c.contextKey, literal: c.context })))
		.closeLabelResult(translatedResult<BubbleInterfaces['config']['resolved']>(c => ({ key: c.closeLabelKey, literal: c.closeLabel })))
		.closeLabel(translatedText<BubbleInterfaces['config']['resolved']>(c => ({ key: c.closeLabelKey, literal: c.closeLabel })))
		.target({ compute: ({ config }) => config.target })
		.layout({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const layout = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				const placement = layout.placement ?? 'anchored'
				const style: CssStyle = placement === 'anchored'
					? { left: layout.x ?? '0', top: layout.y ?? '0', ...(layout.width ? { width: layout.width } : {}) }
					: {}
				return { style, placement, hidden: Boolean(layout.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.close({ description: 'Fired when the close control is pressed' }))
	.done()

export const BubbleRenderer = defineComponent({
	name: 'BubbleRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties, emit } = useWidget(bubblePlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const layout = props.layout.value
			const placement = layout?.placement ?? 'anchored'
			const status = state.status.value ?? 'open'
			const meta: (VNode | null)[] = []
			if (props.statusLabel.value)
				meta.push(h(KitBadge, { variant: 'subtle', tone: (BUBBLE_STATUS_TONE[status] ?? 'neutral') as BadgeTone, icon: BUBBLE_STATUS_ICON[status], label: props.statusLabel.value }))
			if (props.context.value) meta.push(h('span', { class: 'uiux-ref-thread-meta' }, props.context.value))
			if (props.target.value) meta.push(h(KitBadge, { variant: 'mono', label: props.target.value }))
			return h('section', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: placement === 'inline' ? 'region' : 'dialog',
				'aria-label': props.title.value || undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-bubble',
					props.theme.value,
					placement === 'sheet' ? 'is-sheet' : '',
					placement === 'inline' ? 'is-inline' : '',
					layout?.hidden || !state.open.value ? 'uiux-ref-hidden' : '',
				],
				style: layout?.style,
			}, [
				placement === 'sheet' ? h('span', { class: 'uiux-ref-bubble-grip', 'aria-hidden': 'true' }) : null,
				h('header', { class: 'uiux-ref-bubble-header' }, [
					h('div', { class: 'uiux-ref-bubble-head-row' }, [
						h('h2', { class: 'uiux-ref-bubble-title' }, props.title.value ?? ''),
						placement === 'inline'
							? null
							: h(KitButton, {
									variant: 'ghost',
									size: 'sm',
									iconOnly: true,
									icon: 'x',
									label: props.closeLabel.value ?? '',
									onClick: () => emit.close(),
								}),
					]),
					meta.length ? h('div', { class: 'uiux-ref-bubble-meta' }, meta) : null,
				]),
				h('div', { class: 'uiux-ref-bubble-body' }, [h(WidgetSlot, { name: 'content' })]),
				h('footer', { class: 'uiux-ref-bubble-footer' }, [h(WidgetSlot, { name: 'footer' })]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 13. CanvasStage — recessed dotted canvas, a lifted View frame, and the annotation overlay
// ---------------------------------------------------------------------------
type CanvasMode = 'select' | 'comment' | 'interact'
export interface CanvasLayout {
	frameWidth?: string
	frameMinHeight?: string
	padding?: number | string
	dots?: boolean
	flex?: string
	hidden?: boolean
	/** The frame paints with the render-context theme instead of the View's own white ground. */
	frameFollowsTheme?: boolean
}

export interface CanvasStageInterfaces {
	config: {
		raw: (CanvasLayout & { mode?: CanvasMode; label?: string; labelKey?: string; responsive?: Responsive<CanvasLayout> }) | null
		resolved: { mode: CanvasMode; label: string; labelKey: string | null; base: CanvasLayout; responsive?: Responsive<CanvasLayout> }
	}
	slots: 'frame' | 'overlay' | 'hint' | 'palette' | 'tray'
	state: { mode: CanvasMode }
	properties: {
		labelResult: TranslationResult
		label: string
		layout: { style: CssStyle; frameStyle: CssStyle; dots: boolean; hidden: boolean; compact: boolean; followsTheme: boolean }
		theme: string
	}
}

export const canvasStagePlugin = createWidgetPlugin('CanvasStage')
	.description('The Workbench canvas: a recessed graphite ground with a 16px dot grid, the previewed View in a 2px-radius lifted frame, an overlay layer for pins and bubbles, a centered floating tool palette, and a bottom-left tray. `mode: "comment"` draws the 2px Marker inset line and shows the hint slot.')
	.interfaces<CanvasStageInterfaces>()
	.config({
		description: 'CanvasStage configuration. `label` names the canvas region and accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			mode: { enum: ['select', 'comment', 'interact'] },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			frameWidth: { type: 'string' },
			frameMinHeight: { type: 'string' },
			padding: { type: ['number', 'string'] },
			dots: { type: 'boolean' },
			flex: { type: 'string' },
			hidden: { type: 'boolean' },
			frameFollowsTheme: { type: 'boolean' },
		}),
		validate: (c): c is CanvasStageInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { mode, label, labelKey, ...layout } = raw ?? {}
			return {
				mode: oneOf(mode, ['select', 'comment', 'interact'] as const, 'select'),
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				...splitResponsive<CanvasLayout>(layout),
			}
		},
	})
	.slots({
		frame: { description: 'The previewed View content inside the lifted frame' },
		overlay: { description: 'Pins and bubbles positioned over the frame' },
		hint: { description: 'Mode hint shown above the frame while commenting' },
		palette: { description: 'Floating canvas tool palette' },
		tray: { description: 'Bottom-left tray for comments that cannot be placed' },
	})
	.state(state => state.mode({
		authorWritable: true,
		validate: (v): v is CanvasMode => v === 'select' || v === 'comment' || v === 'interact',
		default: ({ config }) => config.mode,
	}))
	.properties(p => p
		.labelResult(translatedResult<CanvasStageInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<CanvasStageInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.layout({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				const layout = cascade(config.base, config.responsive, tier)
				return {
					style: { padding: px(layout.padding, tier === 'wide' ? '24px 24px 88px' : '12px 12px 80px'), ...(layout.flex ? { flex: layout.flex } : { flex: '1 1 auto' }) },
					frameStyle: { maxWidth: layout.frameWidth ?? '880px', ...(layout.frameMinHeight ? { minHeight: layout.frameMinHeight } : {}) },
					dots: layout.dots ?? true,
					hidden: Boolean(layout.hidden),
					compact: tier === 'compact',
					followsTheme: Boolean(layout.frameFollowsTheme),
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const CanvasStageRenderer = defineComponent({
	name: 'CanvasStageRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties } = useWidget(canvasStagePlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const layout = props.layout.value
			const mode = state.mode.value
			return h('section', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				'aria-label': props.label.value || undefined,
				'data-canvas-mode': mode,
				class: [
					'uiux-ref-scope',
					'uiux-ref-stage',
					props.theme.value,
					`mode-${mode}`,
					layout?.dots ? 'has-dots' : '',
					layout?.compact ? 'is-compact' : '',
					layout?.hidden ? 'uiux-ref-hidden' : '',
				],
				style: layout?.style,
			}, [
				mode === 'comment' ? h('div', { class: 'uiux-ref-stage-hint' }, [h(WidgetSlot, { name: 'hint' })]) : null,
				h('div', { class: 'uiux-ref-stage-frame-wrap', style: layout?.frameStyle }, [
					h('div', { class: ['uiux-ref-stage-frame', layout?.followsTheme ? 'follows-theme' : ''] }, [h(WidgetSlot, { name: 'frame' })]),
					h(WidgetSlot, { name: 'overlay' }),
				]),
				h('div', { class: 'uiux-ref-stage-palette' }, [h(WidgetSlot, { name: 'palette' })]),
				h('div', { class: 'uiux-ref-stage-tray' }, [h(WidgetSlot, { name: 'tray' })]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 14. SegmentedControl & Segment — segmented toggles, underline tabs, and the floating tool palette
// ---------------------------------------------------------------------------
type SegmentAppearance = 'segment' | 'tabs' | 'palette'
const SEGMENT_APPEARANCES: readonly SegmentAppearance[] = ['segment', 'tabs', 'palette']

export interface SegmentedLayout { fullWidth?: boolean; hidden?: boolean }

export interface SegmentedControlInterfaces {
	config: {
		raw: (SegmentedLayout & { appearance?: SegmentAppearance; label?: string; labelKey?: string; responsive?: Responsive<SegmentedLayout> }) | null
		resolved: { appearance: SegmentAppearance; label: string; labelKey: string | null; base: SegmentedLayout; responsive?: Responsive<SegmentedLayout> }
	}
	slots: 'content'
	properties: {
		labelResult: TranslationResult
		label: string
		layout: { appearance: SegmentAppearance; fullWidth: boolean; hidden: boolean }
		theme: string
	}
}

export const segmentedControlPlugin = createWidgetPlugin('SegmentedControl')
	.description('Group of Segments rendered as a segmented control, an underline tab strip, or the floating canvas tool palette (pill with overlay shadow).')
	.interfaces<SegmentedControlInterfaces>()
	.config({
		description: 'SegmentedControl configuration. `label` (group accessible name) accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			appearance: { enum: ['segment', 'tabs', 'palette'] },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			fullWidth: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is SegmentedControlInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { appearance, label, labelKey, ...layout } = raw ?? {}
			return { appearance: oneOf(appearance, SEGMENT_APPEARANCES, 'segment'), label: stringOr(label, ''), labelKey: optionalString(labelKey), ...splitResponsive<SegmentedLayout>(layout) }
		},
	})
	.slots({ content: { description: 'Segment widgets' } })
	.properties(p => p
		.labelResult(translatedResult<SegmentedControlInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SegmentedControlInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.layout({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const layout = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return { appearance: config.appearance, fullWidth: Boolean(layout.fullWidth), hidden: Boolean(layout.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const SegmentedControlRenderer = defineComponent({
	name: 'SegmentedControlRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(segmentedControlPlugin)
		const props = useProperties()
		return (): VNode => {
			const layout = props.layout.value
			const appearance = layout?.appearance ?? 'segment'
			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: appearance === 'tabs' ? 'tablist' : appearance === 'palette' ? 'toolbar' : 'group',
				'aria-label': props.label.value || undefined,
				class: ['uiux-ref-scope', 'uiux-ref-segmented', props.theme.value, `appearance-${appearance}`, layout?.fullWidth ? 'is-full-width' : '', layout?.hidden ? 'uiux-ref-hidden' : ''],
			}, [h(WidgetSlot, { name: 'content' })])
		}
	},
})

export interface SegmentPresentation { iconOnly?: boolean; hidden?: boolean }

export interface SegmentInterfaces {
	config: {
		raw: (SegmentPresentation & {
			label?: string
			labelKey?: string
			icon?: string
			kbd?: string
			count?: string | number
			countTone?: 'neutral' | 'annotation' | 'info'
			appearance?: SegmentAppearance
			activeTone?: 'primary' | 'annotation'
			selected?: boolean
			responsive?: Responsive<SegmentPresentation>
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			icon: string
			kbd: string
			count: string
			countTone: string
			appearance: SegmentAppearance
			activeTone: string
			selected: boolean
			base: SegmentPresentation
			responsive?: Responsive<SegmentPresentation>
		}
	}
	state: { selected: boolean }
	events: { click: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		look: { icon: string; kbd: string; count: string; countTone: string; appearance: SegmentAppearance; activeTone: string; iconOnly: boolean; hidden: boolean; touch: boolean }
		theme: string
	}
}

export const segmentPlugin = createWidgetPlugin('Segment')
	.description('One option inside a SegmentedControl: Lucide icon, translatable label, count, and shortcut hint. The palette appearance fills Iris when selected, or tints Marker for the Comment tool (`activeTone: "annotation"`).')
	.interfaces<SegmentInterfaces>()
	.config({
		description: 'Segment configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`); `appearance` must match the parent SegmentedControl.',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			icon: { type: 'string' },
			kbd: { type: 'string' },
			count: { type: ['string', 'number'] },
			countTone: { enum: ['neutral', 'annotation', 'info'] },
			appearance: { enum: ['segment', 'tabs', 'palette'] },
			activeTone: { enum: ['primary', 'annotation'] },
			selected: { type: 'boolean' },
			iconOnly: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is SegmentInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, icon, kbd, count, countTone, appearance, activeTone, selected, ...presentation } = raw ?? {}
			return {
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				icon: stringOr(icon, ''),
				kbd: stringOr(kbd, ''),
				count: count === undefined ? '' : String(count),
				countTone: countTone ?? 'neutral',
				appearance: oneOf(appearance, SEGMENT_APPEARANCES, 'segment'),
				activeTone: activeTone ?? 'primary',
				selected: Boolean(selected),
				...splitResponsive<SegmentPresentation>(presentation),
			}
		},
	})
	.state(state => state.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected }))
	.properties(p => p
		.labelResult(translatedResult<SegmentInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SegmentInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.look({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				const presentation = cascade(config.base, config.responsive, tier)
				return {
					icon: config.icon,
					kbd: isTouchTier(tier) ? '' : config.kbd,
					count: config.count,
					countTone: config.countTone,
					appearance: config.appearance,
					activeTone: config.activeTone,
					iconOnly: Boolean(presentation.iconOnly && config.icon),
					hidden: Boolean(presentation.hidden),
					touch: isTouchTier(tier) && config.appearance !== 'tabs',
				}
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when the segment, tab or tool is chosen' }))
	.done()

export const SegmentRenderer = defineComponent({
	name: 'SegmentRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(segmentPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			const label = props.label.value ?? ''
			const selected = state.selected.value
			const appearance = look?.appearance ?? 'segment'
			const children: (VNode | null)[] = [iconNode(look?.icon, 16)]
			if (!look?.iconOnly) children.push(h('span', label))
			if (look?.count) children.push(h(KitBadge, { variant: 'count', tone: look.countTone as BadgeTone, label: look.count }))
			if (look?.kbd && !look.iconOnly) children.push(kbdNode(look.kbd))
			return h('button', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				type: 'button',
				role: appearance === 'tabs' ? 'tab' : undefined,
				'aria-selected': appearance === 'tabs' ? String(selected) : undefined,
				'aria-pressed': appearance === 'tabs' ? undefined : String(selected),
				'aria-label': look?.iconOnly ? label : undefined,
				title: look?.iconOnly ? label : undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-segment',
					props.theme.value,
					`appearance-${appearance}`,
					`tone-${look?.activeTone ?? 'primary'}`,
					selected ? 'is-selected' : '',
					look?.iconOnly ? 'is-icon-only' : '',
					look?.touch ? 'is-touch' : '',
					look?.hidden ? 'uiux-ref-hidden' : '',
				],
				onClick: () => emit.click(),
			}, children)
		}
	},
})

// ---------------------------------------------------------------------------
// 15. TabBar & TabBarItem — 56px bottom navigation for phones
// ---------------------------------------------------------------------------
export interface TabBarInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string; showOn?: 'compact' | 'always' }) | null
		resolved: { label: string; labelKey: string | null; showOn: 'compact' | 'always' }
	}
	slots: 'content'
	properties: { labelResult: TranslationResult; label: string; hidden: boolean; theme: string }
}

export const tabBarPlugin = createWidgetPlugin('TabBar')
	.description('Phone bottom navigation: a 56px sticky bar of TabBarItems (Overview, Views, UX Flows, Reviews). Shown only on the compact tier unless `showOn: "always"`.')
	.interfaces<TabBarInterfaces>()
	.config({
		description: 'TabBar configuration. `label` (navigation landmark name) accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({ label: { type: 'string' }, labelKey: { type: 'string' }, showOn: { enum: ['compact', 'always'] } }),
		validate: (c): c is TabBarInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({ label: stringOr(raw?.label, ''), labelKey: optionalString(raw?.labelKey), showOn: raw?.showOn === 'always' ? 'always' : 'compact' }),
	})
	.slots({ content: { description: 'TabBarItem widgets' } })
	.properties(p => p
		.labelResult(translatedResult<TabBarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<TabBarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => config.showOn === 'compact' && tierOf(readViewport(deps.viewport())) !== 'compact',
		})
		.theme(themeProperty()),
	)
	.done()

export const TabBarRenderer = defineComponent({
	name: 'TabBarRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(tabBarPlugin)
		const props = useProperties()
		return (): VNode => h('nav', {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			'aria-label': props.label.value || undefined,
			class: ['uiux-ref-scope', 'uiux-ref-tabbar', props.theme.value, props.hidden.value ? 'uiux-ref-hidden' : ''],
		}, [h(WidgetSlot, { name: 'content' })])
	},
})

export interface TabBarItemInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string; icon?: string; badge?: string | number; badgeTone?: 'neutral' | 'annotation'; selected?: boolean }) | null
		resolved: { label: string; labelKey: string | null; icon: string; badge: string; badgeTone: string; selected: boolean }
	}
	state: { selected: boolean }
	events: { click: readonly [] }
	properties: { labelResult: TranslationResult; label: string; look: { icon: string; badge: string; badgeTone: string }; theme: string }
}

export const tabBarItemPlugin = createWidgetPlugin('TabBarItem')
	.description('One bottom-navigation destination: a 20px Lucide icon over a 12px label, an optional count badge, and a 2px Iris top bar when selected.')
	.interfaces<TabBarItemInterfaces>()
	.config({
		description: 'TabBarItem configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' }, icon: { type: 'string' },
			badge: { type: ['string', 'number'] }, badgeTone: { enum: ['neutral', 'annotation'] }, selected: { type: 'boolean' },
		}),
		validate: (c): c is TabBarItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			icon: stringOr(raw?.icon, ''),
			badge: raw?.badge === undefined ? '' : String(raw.badge),
			badgeTone: raw?.badgeTone ?? 'neutral',
			selected: Boolean(raw?.selected),
		}),
	})
	.state(state => state.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected }))
	.properties(p => p
		.labelResult(translatedResult<TabBarItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<TabBarItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.look({ compute: ({ config }) => ({ icon: config.icon, badge: config.badge, badgeTone: config.badgeTone }) })
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when the destination is chosen' }))
	.done()

export const TabBarItemRenderer = defineComponent({
	name: 'TabBarItemRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(tabBarItemPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h('button', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				type: 'button',
				'aria-current': state.selected.value ? 'page' : undefined,
				class: ['uiux-ref-scope', 'uiux-ref-tabbar-item', props.theme.value, state.selected.value ? 'is-selected' : ''],
				onClick: () => {
					state.selected.value = true
					emit.click()
				},
			}, [
				h('span', { class: 'uiux-ref-tabbar-icon' }, [
					iconNode(look?.icon, 20),
					look?.badge ? h(KitBadge, { variant: 'count', tone: look.badgeTone as BadgeTone, label: look.badge }) : null,
				]),
				h('span', props.label.value ?? ''),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 16. Rail — the primary sidebar: 264px wide, a 56px icon rail on tablets, hidden on phones
// ---------------------------------------------------------------------------
export interface RailLayout { width?: string; collapsed?: boolean; hidden?: boolean }

export interface RailInterfaces {
	config: {
		raw: (RailLayout & { label?: string; labelKey?: string; responsive?: Responsive<RailLayout> }) | null
		resolved: { label: string; labelKey: string | null; base: RailLayout; responsive?: Responsive<RailLayout> }
	}
	slots: 'header' | 'content' | 'footer'
	properties: { labelResult: TranslationResult; label: string; layout: { width: string; collapsed: boolean; hidden: boolean }; theme: string }
}

export const railPlugin = createWidgetPlugin('Rail')
	.description('Primary navigation sidebar with header, scrolling content and a Workspace footer group, separated by hairlines. Defaults: 264px on desktop, a 56px icon rail on tablets, hidden on phones (the TabBar takes over).')
	.interfaces<RailInterfaces>()
	.config({
		description: 'Rail configuration. `label` (navigation landmark name) accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({ label: { type: 'string' }, labelKey: { type: 'string' }, width: { type: 'string' }, collapsed: { type: 'boolean' }, hidden: { type: 'boolean' } }),
		validate: (c): c is RailInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, ...layout } = raw ?? {}
			const split = splitResponsive<RailLayout>(layout)
			return {
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				...split,
				responsive: split.responsive ?? { medium: { collapsed: true }, compact: { hidden: true } },
			}
		},
	})
	.slots({
		header: { description: 'Primary destinations' },
		content: { description: 'Context for the current page (for example the Widget tree)' },
		footer: { description: 'Workspace group' },
	})
	.properties(p => p
		.labelResult(translatedResult<RailInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<RailInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.layout({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const layout = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return { width: layout.collapsed ? '56px' : (layout.width ?? '264px'), collapsed: Boolean(layout.collapsed), hidden: Boolean(layout.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const RailRenderer = defineComponent({
	name: 'RailRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(railPlugin)
		const props = useProperties()
		return (): VNode => {
			const layout = props.layout.value
			return h('nav', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				'aria-label': props.label.value || undefined,
				class: ['uiux-ref-scope', 'uiux-ref-rail', props.theme.value, layout?.collapsed ? 'is-collapsed' : '', layout?.hidden ? 'uiux-ref-hidden' : ''],
				style: { width: layout?.width ?? '264px' },
			}, [
				h('div', { class: 'uiux-ref-rail-section is-header' }, [h(WidgetSlot, { name: 'header' })]),
				h('div', { class: 'uiux-ref-rail-section is-content' }, [h(WidgetSlot, { name: 'content' })]),
				h('div', { class: 'uiux-ref-rail-section is-footer' }, [h(WidgetSlot, { name: 'footer' })]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 17. ContextBar & ContextChip — the canvas render-context toolbar (Variant, Locale, Viewport, Theme)
// ---------------------------------------------------------------------------
export interface ContextBarInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string; hidden?: boolean; responsive?: Responsive<{ hidden?: boolean }> }) | null
		resolved: { label: string; labelKey: string | null; base: { hidden?: boolean }; responsive?: Responsive<{ hidden?: boolean }> }
	}
	slots: 'start' | 'end'
	properties: { labelResult: TranslationResult; label: string; hidden: boolean; theme: string }
}

export const contextBarPlugin = createWidgetPlugin('ContextBar')
	.description('44px canvas toolbar with a start group (render-context chips) and an end group (session status, zoom, fit). Scrolls horizontally rather than wrapping on narrow tiers.')
	.interfaces<ContextBarInterfaces>()
	.config({
		description: 'ContextBar configuration. `label` (toolbar accessible name) accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({ label: { type: 'string' }, labelKey: { type: 'string' }, hidden: { type: 'boolean' } }),
		validate: (c): c is ContextBarInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, ...presentation } = raw ?? {}
			return { label: stringOr(label, ''), labelKey: optionalString(labelKey), ...splitResponsive<{ hidden?: boolean }>(presentation) }
		},
	})
	.slots({ start: { description: 'Render-context chips' }, end: { description: 'Status, zoom and panel controls' } })
	.properties(p => p
		.labelResult(translatedResult<ContextBarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<ContextBarInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => Boolean(cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport()))).hidden),
		})
		.theme(themeProperty()),
	)
	.done()

export const ContextBarRenderer = defineComponent({
	name: 'ContextBarRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(contextBarPlugin)
		const props = useProperties()
		return (): VNode => h('div', {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			role: 'toolbar',
			'aria-label': props.label.value || undefined,
			class: ['uiux-ref-scope', 'uiux-ref-contextbar', props.theme.value, props.hidden.value ? 'uiux-ref-hidden' : ''],
		}, [
			h('div', { class: 'uiux-ref-contextbar-start' }, [h(WidgetSlot, { name: 'start' })]),
			h('div', { class: 'uiux-ref-contextbar-end' }, [h(WidgetSlot, { name: 'end' })]),
		])
	},
})

export interface ContextChipPresentation { hideLabel?: boolean; hidden?: boolean }

export interface ContextChipInterfaces {
	config: {
		raw: (ContextChipPresentation & {
			icon?: string
			label?: string
			labelKey?: string
			value?: string
			valueKey?: string
			mono?: boolean
			chevron?: boolean
			responsive?: Responsive<ContextChipPresentation>
		}) | null
		resolved: { icon: string; label: string; labelKey: string | null; value: string; valueKey: string | null; mono: boolean; chevron: boolean; base: ContextChipPresentation; responsive?: Responsive<ContextChipPresentation> }
	}
	events: { click: readonly [] }
	properties: {
		contextViewportId: string
		contextViewport: string
		contextLocale: string
		contextTheme: string
		labelResult: TranslationResult
		label: string
		valueResult: TranslationResult
		value: string
		look: { icon: string; mono: boolean; chevron: boolean; hideLabel: boolean; hidden: boolean; touch: boolean }
		theme: string
	}
}

export const contextChipPlugin = createWidgetPlugin('ContextChip')
	.description('Render-context chip: icon, muted label and a highlighted value with a select chevron. Translated values may interpolate the live render context ({viewportId}, {viewport}, {locale}, {theme}).')
	.interfaces<ContextChipInterfaces>()
	.config({
		description: 'ContextChip configuration. `label` and `value` accept `$i18n` bindings (lowered to `labelKey`, `valueKey`).',
		schema: configSchema({
			icon: { type: 'string' }, label: { type: 'string' }, labelKey: { type: 'string' },
			value: { type: 'string' }, valueKey: { type: 'string' }, mono: { type: 'boolean' }, chevron: { type: 'boolean' },
			hideLabel: { type: 'boolean' }, hidden: { type: 'boolean' },
		}),
		validate: (c): c is ContextChipInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { icon, label, labelKey, value, valueKey, mono, chevron, ...presentation } = raw ?? {}
			return {
				icon: stringOr(icon, ''),
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				value: stringOr(value, ''),
				valueKey: optionalString(valueKey),
				mono: Boolean(mono),
				chevron: chevron === undefined ? true : Boolean(chevron),
				...splitResponsive<ContextChipPresentation>(presentation),
			}
		},
	})
	.properties(p => p
		.contextViewportId({ valueContract: STRING, registerDeps: viewportDeps, compute: ({ deps }) => readViewport(deps.viewport())?.id ?? '' })
		.contextViewport({
			valueContract: STRING,
			registerDeps: viewportDeps,
			compute: ({ deps }) => {
				const viewport = readViewport(deps.viewport())
				return viewport ? `${viewport.width} × ${viewport.height}` : ''
			},
		})
		.contextLocale({ valueContract: STRING, registerDeps: ({ dep }) => ({ locale: dep.root.state.get('locale') }), compute: ({ deps }) => stringFromResult(deps.locale()) })
		.contextTheme({ valueContract: STRING, registerDeps: ({ dep }) => ({ themeId: dep.root.state.get('themeId') }), compute: ({ deps }) => stringFromResult(deps.themeId()) })
		.labelResult(translatedResult<ContextChipInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<ContextChipInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.valueResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({
				...translateDeps({ dep }),
				viewportId: dep.self.properties.get('contextViewportId'),
				viewport: dep.self.properties.get('contextViewport'),
				locale: dep.self.properties.get('contextLocale'),
				theme: dep.self.properties.get('contextTheme'),
			}),
			compute: ({ config, deps }) => translateField(config.valueKey, config.value, (key, params) => deps.t(key, params), {
				viewportId: stringFromResult(deps.viewportId()),
				viewport: stringFromResult(deps.viewport()),
				locale: stringFromResult(deps.locale()),
				theme: stringFromResult(deps.theme()),
			}),
		})
		.value({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('valueResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.look({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				const presentation = cascade(config.base, config.responsive, tier)
				return { icon: config.icon, mono: config.mono, chevron: config.chevron, hideLabel: Boolean(presentation.hideLabel), hidden: Boolean(presentation.hidden), touch: isTouchTier(tier) }
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when the chip menu is opened' }))
	.done()

export const ContextChipRenderer = defineComponent({
	name: 'ContextChipRenderer',
	setup() {
		const { widgetId, useProperties, emit } = useWidget(contextChipPlugin)
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			const label = props.label.value ?? ''
			return h('button', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				type: 'button',
				'aria-haspopup': 'listbox',
				'aria-label': look?.hideLabel ? `${label}: ${props.value.value ?? ''}` : undefined,
				class: ['uiux-ref-scope', 'uiux-ref-chip', props.theme.value, look?.touch ? 'is-touch' : '', look?.hidden ? 'uiux-ref-hidden' : ''],
				onClick: () => emit.click(),
			}, [
				iconNode(look?.icon, 16),
				look?.hideLabel ? null : h('span', label),
				h('span', { class: ['uiux-ref-chip-value', look?.mono ? 'is-mono' : ''] }, props.value.value ?? ''),
				look?.chevron ? iconNode('chevron-down', 14) : null,
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 18. TimelineItem — one message or lifecycle event in a Review thread
// ---------------------------------------------------------------------------
export interface TimelineItemInterfaces {
	config: {
		raw: ({
			kind?: 'message' | 'event'
			actor?: ActorKind
			initials?: string
			name?: string
			role?: string
			roleKey?: string
			time?: string
			timeKey?: string
			body?: string
			bodyKey?: string
			icon?: string
			tone?: 'neutral' | 'success' | 'info' | 'annotation'
		}) | null
		resolved: {
			kind: 'message' | 'event'
			actor: ActorKind
			initials: string
			name: string
			role: string
			roleKey: string | null
			time: string
			timeKey: string | null
			body: string
			bodyKey: string | null
			icon: string
			tone: string
		}
	}
	properties: {
		roleResult: TranslationResult
		role: string
		timeResult: TranslationResult
		time: string
		bodyResult: TranslationResult
		body: string
		look: { kind: 'message' | 'event'; actor: ActorKind; initials: string; name: string; icon: string; tone: string }
		theme: string
	}
}

export const timelineItemPlugin = createWidgetPlugin('TimelineItem')
	.description('Review thread timeline entry: a message (avatar, author, role badge, relative time, 14px body) or a compact lifecycle event (icon plus one muted line, toned success/info/annotation).')
	.interfaces<TimelineItemInterfaces>()
	.config({
		description: 'TimelineItem configuration. `role`, `time` and `body` accept `$i18n` bindings (lowered to `roleKey`, `timeKey`, `bodyKey`). `name` and `initials` are member data and stay literal.',
		schema: configSchema({
			kind: { enum: ['message', 'event'] },
			actor: { enum: ['human', 'agent', 'system'] },
			initials: { type: 'string' }, name: { type: 'string' },
			role: { type: 'string' }, roleKey: { type: 'string' },
			time: { type: 'string' }, timeKey: { type: 'string' },
			body: { type: 'string' }, bodyKey: { type: 'string' },
			icon: { type: 'string' },
			tone: { enum: ['neutral', 'success', 'info', 'annotation'] },
		}),
		validate: (c): c is TimelineItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			kind: raw?.kind === 'event' ? 'event' : 'message',
			actor: oneOf(raw?.actor, ACTOR_KINDS, 'human'),
			initials: stringOr(raw?.initials, ''),
			name: stringOr(raw?.name, ''),
			role: stringOr(raw?.role, ''),
			roleKey: optionalString(raw?.roleKey),
			time: stringOr(raw?.time, ''),
			timeKey: optionalString(raw?.timeKey),
			body: stringOr(raw?.body, ''),
			bodyKey: optionalString(raw?.bodyKey),
			icon: stringOr(raw?.icon, ''),
			tone: raw?.tone ?? 'neutral',
		}),
	})
	.properties(p => p
		.roleResult(translatedResult<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.roleKey, literal: c.role })))
		.role(translatedText<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.roleKey, literal: c.role })))
		.timeResult(translatedResult<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.timeKey, literal: c.time })))
		.time(translatedText<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.timeKey, literal: c.time })))
		.bodyResult(translatedResult<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.bodyKey, literal: c.body })))
		.body(translatedText<TimelineItemInterfaces['config']['resolved']>(c => ({ key: c.bodyKey, literal: c.body })))
		.look({ compute: ({ config }) => ({ kind: config.kind, actor: config.actor, initials: config.initials, name: config.name, icon: config.icon, tone: config.tone }) })
		.theme(themeProperty()),
	)
	.done()

export const TimelineItemRenderer = defineComponent({
	name: 'TimelineItemRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(timelineItemPlugin)
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			if (look?.kind === 'event') {
				return h('div', {
					[WIDGET_ID_ATTRIBUTE]: widgetId,
					class: ['uiux-ref-scope', 'uiux-ref-timeline', 'kind-event', `tone-${look.tone}`, props.theme.value],
				}, [
					h('span', { class: 'uiux-ref-timeline-marker' }, [iconNode(look.icon || 'circle-dot', 14)]),
					h('span', [props.body.value ?? '', props.time.value ? ` · ${props.time.value}` : '']),
				])
			}
			return h('article', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: ['uiux-ref-scope', 'uiux-ref-timeline', 'kind-message', props.theme.value],
			}, [
				h('span', { class: ['uiux-ref-avatar'], style: { width: '24px', height: '24px' }, 'aria-hidden': 'true' }, [actorFace(look?.actor ?? 'human', look?.initials ?? '', 14)]),
				h('div', { class: 'uiux-ref-timeline-main' }, [
					h('div', { class: 'uiux-ref-timeline-head' }, [
						h('span', { class: 'uiux-ref-timeline-name' }, look?.name ?? ''),
						props.role.value ? h(KitBadge, { variant: 'soft', tone: 'neutral', label: props.role.value }) : null,
						h('span', { class: 'uiux-ref-timeline-time' }, props.time.value ?? ''),
					]),
					h('p', { class: 'uiux-ref-timeline-body' }, props.body.value ?? ''),
				]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 19. ThreadRow — one Review thread in a queue or comment list
// ---------------------------------------------------------------------------
type ThreadStatus = 'open' | 'ready' | 'resolved'
const THREAD_STATUSES: readonly ThreadStatus[] = ['open', 'ready', 'resolved']
const THREAD_STATUS_ICON: Record<ThreadStatus, string> = { open: 'circle-dot', ready: 'eye', resolved: 'circle-check' }

export interface ThreadRowInterfaces {
	config: {
		raw: ({
			title?: string
			titleKey?: string
			meta?: string
			metaKey?: string
			time?: string
			timeKey?: string
			anchor?: string
			chips?: readonly string[]
			count?: number
			initials?: string
			actor?: ActorKind
			status?: ThreadStatus
			selected?: boolean
			unread?: boolean
			hidden?: boolean
			responsive?: Responsive<{ hidden?: boolean }>
		}) | null
		resolved: {
			title: string
			titleKey: string | null
			meta: string
			metaKey: string | null
			time: string
			timeKey: string | null
			anchor: string
			chips: readonly string[]
			count: number
			initials: string
			actor: ActorKind
			status: ThreadStatus
			selected: boolean
			unread: boolean
			base: { hidden?: boolean }
			responsive?: Responsive<{ hidden?: boolean }>
		}
	}
	state: { selected: boolean; status: ThreadStatus }
	events: { click: readonly [] }
	properties: {
		titleResult: TranslationResult
		title: string
		metaResult: TranslationResult
		meta: string
		timeResult: TranslationResult
		time: string
		look: { anchor: string; chips: readonly string[]; count: number; initials: string; actor: ActorKind; unread: boolean; hidden: boolean; touch: boolean }
		theme: string
	}
}

export const threadRowPlugin = createWidgetPlugin('ThreadRow')
	.description('Review thread row: status icon (open/ready/resolved, never color alone), author avatar, one-line title, relative time, annotation-colored message count, meta line, mono anchor and change-domain chips. Selected rows get an Iris tint and inset bar.')
	.interfaces<ThreadRowInterfaces>()
	.config({
		description: 'ThreadRow configuration. `title`, `meta` and `time` accept `$i18n` bindings (lowered to `titleKey`, `metaKey`, `timeKey`). `anchor` and `chips` are literal identities.',
		schema: configSchema({
			title: { type: 'string' }, titleKey: { type: 'string' },
			meta: { type: 'string' }, metaKey: { type: 'string' },
			time: { type: 'string' }, timeKey: { type: 'string' },
			anchor: { type: 'string' },
			chips: { type: 'array', items: { type: 'string' } },
			count: { type: 'number' },
			initials: { type: 'string' },
			actor: { enum: ['human', 'agent', 'system'] },
			status: { enum: ['open', 'ready', 'resolved'] },
			selected: { type: 'boolean' },
			unread: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is ThreadRowInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { title, titleKey, meta, metaKey, time, timeKey, anchor, chips, count, initials, actor, status, selected, unread, ...presentation } = raw ?? {}
			return {
				title: stringOr(title, ''),
				titleKey: optionalString(titleKey),
				meta: stringOr(meta, ''),
				metaKey: optionalString(metaKey),
				time: stringOr(time, ''),
				timeKey: optionalString(timeKey),
				anchor: stringOr(anchor, ''),
				chips: Array.isArray(chips) ? chips.filter((chip): chip is string => typeof chip === 'string') : [],
				count: typeof count === 'number' ? count : 0,
				initials: stringOr(initials, ''),
				actor: oneOf(actor, ACTOR_KINDS, 'human'),
				status: oneOf(status, THREAD_STATUSES, 'open'),
				selected: Boolean(selected),
				unread: Boolean(unread),
				...splitResponsive<{ hidden?: boolean }>(presentation),
			}
		},
	})
	.state(state => state
		.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected })
		.status({ authorWritable: true, validate: (v): v is ThreadStatus => typeof v === 'string' && (THREAD_STATUSES as readonly string[]).includes(v), default: ({ config }) => config.status }))
	.properties(p => p
		.titleResult(translatedResult<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedText<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.metaResult(translatedResult<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.metaKey, literal: c.meta })))
		.meta(translatedText<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.metaKey, literal: c.meta })))
		.timeResult(translatedResult<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.timeKey, literal: c.time })))
		.time(translatedText<ThreadRowInterfaces['config']['resolved']>(c => ({ key: c.timeKey, literal: c.time })))
		.look({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				return {
					anchor: config.anchor,
					chips: config.chips,
					count: config.count,
					initials: config.initials,
					actor: config.actor,
					unread: config.unread,
					hidden: Boolean(cascade(config.base, config.responsive, tier).hidden),
					touch: isTouchTier(tier),
				}
			},
		})
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when the thread is opened' }))
	.done()

export const ThreadRowRenderer = defineComponent({
	name: 'ThreadRowRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(threadRowPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			const status = state.status.value ?? 'open'
			const chips: VNode[] = []
			if (look?.anchor) chips.push(h(KitBadge, { variant: 'mono', label: look.anchor }))
			for (const chip of look?.chips ?? []) chips.push(h(KitBadge, { variant: 'mono', label: chip }))
			return h('button', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				type: 'button',
				'aria-current': state.selected.value ? 'true' : undefined,
				class: ['uiux-ref-scope', 'uiux-ref-thread', props.theme.value, state.selected.value ? 'is-selected' : '', look?.touch ? 'is-touch' : '', look?.hidden ? 'uiux-ref-hidden' : ''],
				onClick: () => {
					state.selected.value = true
					emit.click()
				},
			}, [
				h('span', { class: ['uiux-ref-thread-status', `status-${status}`] }, [iconNode(THREAD_STATUS_ICON[status], 16)]),
				h('span', { class: 'uiux-ref-avatar', style: { width: '24px', height: '24px' }, 'aria-hidden': 'true' }, [actorFace(look?.actor ?? 'human', look?.initials ?? '', 14)]),
				h('span', { class: 'uiux-ref-thread-main' }, [
					h('span', { class: 'uiux-ref-thread-top' }, [
						h('span', { class: 'uiux-ref-thread-title', style: look?.unread ? { fontWeight: '600' } : undefined }, props.title.value ?? ''),
						h('span', { class: 'uiux-ref-thread-time' }, props.time.value ?? ''),
						look?.count ? h('span', { class: 'uiux-ref-thread-count' }, [iconNode('message-circle', 12), String(look.count)]) : null,
					]),
					h('span', { class: 'uiux-ref-thread-meta' }, props.meta.value ?? ''),
					chips.length ? h('span', { class: 'uiux-ref-thread-chips' }, chips) : null,
				]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 20. Alert — persistent inline state (adapter failure, revision conflict, invalid token, toast)
// ---------------------------------------------------------------------------
type AlertTone = 'info' | 'success' | 'warning' | 'danger' | 'annotation'
const ALERT_ICON: Record<AlertTone, string> = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert', annotation: 'message-circle' }

export interface AlertInterfaces {
	config: {
		raw: ({ tone?: AlertTone; icon?: string; title?: string; titleKey?: string; description?: string; descriptionKey?: string; toast?: boolean; visible?: boolean }) | null
		resolved: { tone: AlertTone; icon: string; title: string; titleKey: string | null; description: string; descriptionKey: string | null; toast: boolean; visible: boolean }
	}
	slots: 'actions'
	state: { visible: boolean }
	properties: {
		titleResult: TranslationResult
		title: string
		descriptionResult: TranslationResult
		description: string
		look: { tone: AlertTone; icon: string; toast: boolean }
		theme: string
	}
}

export const alertPlugin = createWidgetPlugin('Alert')
	.description('Subtle inline alert with a status icon, title, description and an actions slot; `toast: true` renders the floating toast surface. Author-writable `visible` state drives Variants.')
	.interfaces<AlertInterfaces>()
	.config({
		description: 'Alert configuration. `title` and `description` accept `$i18n` bindings (lowered to `titleKey`, `descriptionKey`).',
		schema: configSchema({
			tone: { enum: ['info', 'success', 'warning', 'danger', 'annotation'] },
			icon: { type: 'string' },
			title: { type: 'string' }, titleKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			toast: { type: 'boolean' },
			visible: { type: 'boolean' },
		}),
		validate: (c): c is AlertInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			tone: oneOf(raw?.tone, ['info', 'success', 'warning', 'danger', 'annotation'] as const, 'info'),
			icon: stringOr(raw?.icon, ''),
			title: stringOr(raw?.title, ''),
			titleKey: optionalString(raw?.titleKey),
			description: stringOr(raw?.description, ''),
			descriptionKey: optionalString(raw?.descriptionKey),
			toast: Boolean(raw?.toast),
			visible: raw?.visible === undefined ? true : Boolean(raw.visible),
		}),
	})
	.slots({ actions: { description: 'Recovery actions and identity chips' } })
	.state(state => state.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.titleResult(translatedResult<AlertInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedText<AlertInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.descriptionResult(translatedResult<AlertInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedText<AlertInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.look({ compute: ({ config }) => ({ tone: config.tone, icon: config.icon || ALERT_ICON[config.tone], toast: config.toast }) })
		.theme(themeProperty()),
	)
	.done()

export const AlertRenderer = defineComponent({
	name: 'AlertRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties } = useWidget(alertPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: look?.tone === 'danger' ? 'alert' : 'status',
				class: ['uiux-ref-scope', 'uiux-ref-alert', props.theme.value, `tone-${look?.tone ?? 'info'}`, look?.toast ? 'is-toast' : '', state.visible.value ? '' : 'uiux-ref-hidden'],
			}, [
				h('span', { class: 'uiux-ref-alert-icon' }, [iconNode(look?.icon, 16)]),
				h('div', { class: 'uiux-ref-alert-main' }, [
					props.title.value ? h('p', { class: 'uiux-ref-alert-title' }, props.title.value) : null,
					props.description.value ? h('p', { class: 'uiux-ref-alert-desc' }, props.description.value) : null,
					h('div', { class: 'uiux-ref-alert-actions' }, [h(WidgetSlot, { name: 'actions' })]),
				]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 21. EmptyState — always one next action
// ---------------------------------------------------------------------------
export interface EmptyStateInterfaces {
	config: {
		raw: ({ icon?: string; title?: string; titleKey?: string; description?: string; descriptionKey?: string; dashed?: boolean; visible?: boolean }) | null
		resolved: { icon: string; title: string; titleKey: string | null; description: string; descriptionKey: string | null; dashed: boolean; visible: boolean }
	}
	slots: 'actions'
	state: { visible: boolean }
	properties: {
		titleResult: TranslationResult
		title: string
		descriptionResult: TranslationResult
		description: string
		look: { icon: string; dashed: boolean }
		theme: string
	}
}

export const emptyStatePlugin = createWidgetPlugin('EmptyState')
	.description('Empty state with a muted icon disc, title, description and one next action. `dashed: true` draws the 1px dashed "nothing authored yet" boundary. Author-writable `visible` state drives Variants.')
	.interfaces<EmptyStateInterfaces>()
	.config({
		description: 'EmptyState configuration. `title` and `description` accept `$i18n` bindings (lowered to `titleKey`, `descriptionKey`).',
		schema: configSchema({
			icon: { type: 'string' },
			title: { type: 'string' }, titleKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			dashed: { type: 'boolean' },
			visible: { type: 'boolean' },
		}),
		validate: (c): c is EmptyStateInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			icon: stringOr(raw?.icon, ''),
			title: stringOr(raw?.title, ''),
			titleKey: optionalString(raw?.titleKey),
			description: stringOr(raw?.description, ''),
			descriptionKey: optionalString(raw?.descriptionKey),
			dashed: Boolean(raw?.dashed),
			visible: raw?.visible === undefined ? true : Boolean(raw.visible),
		}),
	})
	.slots({ actions: { description: 'The one next action' } })
	.state(state => state.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.titleResult(translatedResult<EmptyStateInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedText<EmptyStateInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.descriptionResult(translatedResult<EmptyStateInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedText<EmptyStateInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.look({ compute: ({ config }) => ({ icon: config.icon, dashed: config.dashed }) })
		.theme(themeProperty()),
	)
	.done()

export const EmptyStateRenderer = defineComponent({
	name: 'EmptyStateRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties } = useWidget(emptyStatePlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: ['uiux-ref-scope', 'uiux-ref-empty', props.theme.value, look?.dashed ? 'is-dashed' : '', state.visible.value ? '' : 'uiux-ref-hidden'],
			}, [
				look?.icon ? h('span', { class: 'uiux-ref-empty-icon' }, [iconNode(look.icon, 20)]) : null,
				h('p', { class: 'uiux-ref-empty-title' }, props.title.value ?? ''),
				props.description.value ? h('p', { class: 'uiux-ref-empty-desc' }, props.description.value) : null,
				h('div', { class: 'uiux-ref-empty-actions' }, [h(WidgetSlot, { name: 'actions' })]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// Canonical Adapter Manifest
// ---------------------------------------------------------------------------
// Each translatable field `<field>` keeps its literal key in the Config member `<field>Key`. Its Properties
// follow UIUX's derivation convention, `<field>Result` (the TranslationResult) and `<field>` (the text), so the
// mapping omits `resultProperty` and `textProperty`.
function i18nField(field: string, params?: Readonly<Record<string, string>>): I18nFieldMapping {
	return {
		configField: `${field}Key`,
		...(params ? { params } : {}),
	}
}

function i18nFields(...fields: readonly string[]): AdapterWidgetCatalogEntry {
	return { i18n: { fields: Object.fromEntries(fields.map(field => [field, i18nField(field)])) } }
}

const RENDER_CONTEXT_PARAMS = {
	viewportId: 'contextViewportId',
	viewport: 'contextViewport',
	locale: 'contextLocale',
	theme: 'contextTheme',
} as const

const catalogWidgets: Readonly<Record<string, AdapterWidgetCatalogEntry>> = {
	Stack: {},
	Panel: i18nFields('title'),
	Text: { i18n: { fields: { text: i18nField('text', { value: 'valueText' }) } } },
	Button: i18nFields('label'),
	Badge: { i18n: { fields: { label: i18nField('label', { value: 'valueText', ...RENDER_CONTEXT_PARAMS }) } } },
	TextInput: i18nFields('placeholder', 'label', 'help', 'error'),
	NavItem: i18nFields('label', 'meta', 'badge'),
	Divider: {},
	Avatar: i18nFields('label'),
	Kbd: {},
	Pin: i18nFields('label'),
	Bubble: i18nFields('title', 'statusLabel', 'context', 'closeLabel'),
	CanvasStage: i18nFields('label'),
	SegmentedControl: i18nFields('label'),
	Segment: i18nFields('label'),
	TabBar: i18nFields('label'),
	TabBarItem: i18nFields('label'),
	Rail: i18nFields('label'),
	ContextBar: i18nFields('label'),
	ContextChip: { i18n: { fields: { label: i18nField('label'), value: i18nField('value', RENDER_CONTEXT_PARAMS) } } },
	TimelineItem: i18nFields('role', 'time', 'body'),
	ThreadRow: i18nFields('title', 'meta', 'time'),
	Alert: i18nFields('title', 'description'),
	EmptyState: i18nFields('title', 'description'),
}

export const manifest: AdapterManifest = {
	id: 'uiux-reference-adapter',
	apiVersion: '1',
	widgetPlugins: [
		stackPlugin,
		panelPlugin,
		textPlugin,
		buttonPlugin,
		badgePlugin,
		textInputPlugin,
		navItemPlugin,
		dividerPlugin,
		avatarPlugin,
		kbdPlugin,
		pinPlugin,
		bubblePlugin,
		canvasStagePlugin,
		segmentedControlPlugin,
		segmentPlugin,
		tabBarPlugin,
		tabBarItemPlugin,
		railPlugin,
		contextBarPlugin,
		contextChipPlugin,
		timelineItemPlugin,
		threadRowPlugin,
		alertPlugin,
		emptyStatePlugin,
	],
	catalog: {
		widgets: catalogWidgets,
	},
	renderers: [
		{ type: 'Stack', component: StackRenderer },
		{ type: 'Panel', component: PanelRenderer },
		{ type: 'Text', component: TextRenderer },
		{ type: 'Button', component: ButtonRenderer },
		{ type: 'Badge', component: BadgeRenderer },
		{ type: 'TextInput', component: TextInputRenderer },
		{ type: 'NavItem', component: NavItemRenderer },
		{ type: 'Divider', component: DividerRenderer },
		{ type: 'Avatar', component: AvatarRenderer },
		{ type: 'Kbd', component: KbdRenderer },
		{ type: 'Pin', component: PinRenderer },
		{ type: 'Bubble', component: BubbleRenderer },
		{ type: 'CanvasStage', component: CanvasStageRenderer },
		{ type: 'SegmentedControl', component: SegmentedControlRenderer },
		{ type: 'Segment', component: SegmentRenderer },
		{ type: 'TabBar', component: TabBarRenderer },
		{ type: 'TabBarItem', component: TabBarItemRenderer },
		{ type: 'Rail', component: RailRenderer },
		{ type: 'ContextBar', component: ContextBarRenderer },
		{ type: 'ContextChip', component: ContextChipRenderer },
		{ type: 'TimelineItem', component: TimelineItemRenderer },
		{ type: 'ThreadRow', component: ThreadRowRenderer },
		{ type: 'Alert', component: AlertRenderer },
		{ type: 'EmptyState', component: EmptyStateRenderer },
	],
	providers: [],
	// The reference CSS styles exactly the Workspace themes `light` and `dark`; UIUX diagnoses any other
	// theme instead of rendering it (Clause 01a11a5a-448c-76ba-94d4-6766435b9e2b, Rule 01a115cd-c27d-78ba-b95d-bf1aa50adec7).
	themeSupport: {
		supports: themeId => REFERENCE_THEME_IDS.has(themeId),
	},
}

export default manifest
