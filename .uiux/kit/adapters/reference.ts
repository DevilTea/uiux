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
	type AdapterAssetValue,
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
import KitBreadcrumb from '../src/ui/Breadcrumb.vue'
import KitBreadcrumbItem from '../src/ui/BreadcrumbItem.vue'
import KitButton from '../src/ui/Button.vue'
import KitCheckbox from '../src/ui/Checkbox.vue'
import KitCodeBlock from '../src/ui/CodeBlock.vue'
import KitCommentPin from '../src/ui/CommentPin.vue'
import KitDiffItem from '../src/ui/DiffItem.vue'
import KitDisclosure from '../src/ui/Disclosure.vue'
import KitField from '../src/ui/Field.vue'
import KitIcon from '../src/ui/Icon.vue'
import KitKbd from '../src/ui/Kbd.vue'
import KitListItem from '../src/ui/ListItem.vue'
import KitSelect from '../src/ui/Select.vue'
import KitSelectOption from '../src/ui/SelectOption.vue'
import KitSkeleton from '../src/ui/Skeleton.vue'
import KitTable from '../src/ui/Table.vue'
import KitTableRow from '../src/ui/TableRow.vue'

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

/** A length as authored: a positive number (px) or a non-empty string (any CSS length); anything else is unset. */
function lengthOr(value: unknown): number | string | undefined {
	if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
	return typeof value === 'string' && value.trim() !== '' ? value : undefined
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

/**
 * The interpolation arguments of a Widget's translated text: the literal Config values `value`, `value2` and
 * `value3`, which the Catalog maps to the parameters `{value}`, `{value2}` and `{value3}` (through the Properties
 * `valueText`, `value2Text` and `value3Text`). A Locale message names the argument it wants.
 */
type InterpolationArgs = Readonly<{ value: string; value2: string; value3: string }>

function interpolationArgs(raw: Readonly<{ value?: unknown; value2?: unknown; value3?: unknown }> | null | undefined): InterpolationArgs {
	return { value: valueTextOf(raw?.value), value2: valueTextOf(raw?.value2), value3: valueTextOf(raw?.value3) }
}

function interpolationParams(args: InterpolationArgs): Record<string, string> {
	return { value: args.value, value2: args.value2, value3: args.value3 }
}

/** One run of a sentence that shows its `{value}` as inline code: plain text, or the code run. */
type TextRun = Readonly<{ text: string; code: boolean }>

/** Private-use markers around the `{value}` argument while a sentence is split into runs (never part of any Locale message). */
const CODE_OPEN = ''
const CODE_CLOSE = ''

/**
 * The runs of one translated field: a single plain run, or, with `valueCode`, the sentence split around its
 * `{value}`, which is the code run. The Evidence text of the field (its `<field>Result`) stays plain.
 */
function textRunsOf<C extends InterpolationArgs & { valueCode: boolean }>(pick: (config: C) => FieldSource) {
	return {
		registerDeps: translateDeps,
		compute: ({ config, deps }: { config: C; deps: TranslateOnlyDeps }): readonly TextRun[] => {
			const source = pick(config)
			const translate = (key: string, params: Readonly<Record<string, string>>) => deps.t(key, params)
			if (!config.valueCode || config.value === '') return [{ text: translateField(source.key, source.literal, translate, interpolationParams(config)).text, code: false }]
			const marked = translateField(source.key, source.literal, translate, { ...interpolationParams(config), value: `${CODE_OPEN}${config.value}${CODE_CLOSE}` }).text
			return marked.split(CODE_OPEN).flatMap<TextRun>((part, index) => {
				if (index === 0) return part ? [{ text: part, code: false }] : []
				const [code = '', rest = ''] = part.split(CODE_CLOSE)
				return [{ text: code, code: true }, ...(rest ? [{ text: rest, code: false }] : [])]
			})
		},
	}
}

/** The nodes of a field's runs: text, and `<code>` for the code run. */
function runNodes(runs: readonly TextRun[] | null | undefined, fallback: string): (VNode | string)[] {
	if (!runs || runs.length === 0) return [fallback]
	return runs.map(run => run.code ? h('code', { class: 'uiux-ref-code' }, run.text) : run.text)
}

/**
 * `<field>Result` for a field whose translated text may interpolate `{value}`, `{value2}` and `{value3}`, the
 * config's literal values (the Catalog maps each parameter to the Widget's `valueText`, `value2Text` and
 * `value3Text` Property).
 */
function translatedResultWithValue<C extends InterpolationArgs>(pick: (config: C) => FieldSource) {
	return {
		valueContract: TRANSLATION_RESULT,
		registerDeps: translateDeps,
		compute: ({ config, deps }: { config: C; deps: TranslateOnlyDeps }): TranslationResult => {
			const source = pick(config)
			return translateField(source.key, source.literal, (key, params) => deps.t(key, params), interpolationParams(config))
		},
	}
}

/** `<field>` text paired with {@link translatedResultWithValue}. */
function translatedTextWithValue<C extends InterpolationArgs>(pick: (config: C) => FieldSource) {
	return {
		valueContract: STRING,
		registerDeps: translateDeps,
		compute: ({ config, deps }: { config: C; deps: TranslateOnlyDeps }): string => {
			const source = pick(config)
			return translateField(source.key, source.literal, (key, params) => deps.t(key, params), interpolationParams(config)).text
		},
	}
}

/** The translation of a Locale key a State holds (`valueKey`); an empty key has no text. */
function translateStateKey(key: string, translate: Translate): TranslationResult {
	return key === '' ? { text: '', warnings: [] } : translateField(key, '', translate)
}

/** The `value` an interpolating Widget takes: a literal string or number, kept as text. */
function valueTextOf(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
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
	/** With `scrollY`, a list that stops growing at this height and scrolls inside (any CSS length). */
	maxHeight?: string
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
	/** A dashed 8px boundary ("nothing here yet"), alone or on a `card`. */
	dashed?: boolean
	/** Absolutely positioned layer covering its positioned parent (pin layers). Children stay clickable. */
	overlay?: boolean
	/** Center this region horizontally inside its parent. */
	centered?: boolean
	/** Initial value of the author-writable `visible` state (Variants flip it). */
	visible?: boolean
	/** Literal fill for content inside a previewed View (product swatches, brand marks); chrome uses `surface`. */
	background?: string
	radius?: number | string
	/** Initial value of the author-writable `outline` state: outlines the region as a changed region of a diff (chrome, not content). */
	outline?: StackOutline
}

/** `none`, or the kind of change the outline marks: added, removed, modified or moved. */
type StackOutline = 'none' | 'added' | 'removed' | 'modified' | 'moved'
const STACK_OUTLINES: readonly StackOutline[] = ['none', 'added', 'removed', 'modified', 'moved']

export interface StackInterfaces {
	config: {
		raw: (StackLayout & { responsive?: Responsive<StackLayout> }) | null
		resolved: { base: StackLayout; responsive?: Responsive<StackLayout> }
	}
	slots: 'content'
	state: { visible: boolean; outline: StackOutline }
	properties: {
		layout: { style: CssStyle; surface: string; hidden: boolean; overlay: boolean; card: boolean; dashed: boolean; outline: string }
		theme: string
	}
}

const ALIGN: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', baseline: 'baseline', stretch: 'stretch' }
const JUSTIFY: Record<string, string> = { center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', start: 'flex-start' }
const HAIRLINE = '1px solid var(--kit-border)'

export const stackPlugin = createWidgetPlugin('Stack')
	.description('Responsive layout container for horizontal and vertical stacking with gap, alignment, hairline edges, scroll regions (`scrollY` with `maxHeight` is a capped list), cards (`dashed` for an empty one), viewport-tier overrides, and author-writable `visible` and `outline` states for Variants.')
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
			maxHeight: { type: 'string' },
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
			dashed: { type: 'boolean' },
			overlay: { type: 'boolean' },
			centered: { type: 'boolean' },
			visible: { type: 'boolean' },
			background: { type: 'string' },
			radius: { type: ['number', 'string'] },
			outline: { enum: [...STACK_OUTLINES] },
		}),
		validate: (c): c is StackInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => splitResponsive<StackLayout>(raw),
	})
	.slots({ content: { description: 'Nested child widgets' } })
	.state(state => state
		.visible({ ...visibleState, default: ({ config }) => config.base.visible !== false })
		.outline({ authorWritable: true, validate: (v): v is StackOutline => (STACK_OUTLINES as readonly unknown[]).includes(v), default: ({ config }) => config.base.outline ?? 'none' }))
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
				if (layout.maxHeight) style.maxHeight = layout.maxHeight
				return {
					style,
					surface: layout.surface ?? 'none',
					hidden: Boolean(layout.hidden),
					overlay: Boolean(layout.overlay),
					card: Boolean(layout.card),
					dashed: Boolean(layout.dashed),
					outline: layout.outline ?? '',
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
					layout?.dashed ? 'is-dashed' : '',
					state.outline.value && state.outline.value !== 'none' ? `is-outline-${state.outline.value}` : '',
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
			/** A muted line under the title (the dialog's description). */
			description?: string
			descriptionKey?: string
			/** Interpolated into a translated title or description as `{value}`, `{value2}` and `{value3}`. */
			value?: string | number
			value2?: string | number
			value3?: string | number
			variant?: PanelVariant
			/** Adds a close (X) button at the end of the header; it fires `close`. */
			closable?: boolean
			closeLabel?: string
			closeLabelKey?: string
			/** A dialog dims everything around it, as the real modal's overlay does. */
			backdrop?: boolean
			responsive?: Responsive<PanelLayout>
		}) | null
		resolved: InterpolationArgs & {
			title: string
			titleKey: string | null
			description: string
			descriptionKey: string | null
			variant: PanelVariant
			closable: boolean
			closeLabel: string
			closeLabelKey: string | null
			backdrop: boolean
			base: PanelLayout
			responsive?: Responsive<PanelLayout>
		}
	}
	slots: 'header' | 'content' | 'footer'
	state: { visible: boolean }
	events: { close: readonly [] }
	properties: {
		valueText: string
		value2Text: string
		value3Text: string
		titleResult: TranslationResult
		title: string
		descriptionResult: TranslationResult
		description: string
		closeLabelResult: TranslationResult
		closeLabel: string
		variant: string
		look: { closable: boolean; backdrop: boolean }
		frame: { style: CssStyle; bodyStyle: CssStyle; bordered: boolean; hidden: boolean }
		theme: string
	}
}

export const panelPlugin = createWidgetPlugin('Panel')
	.description('Surface container with optional translatable title and description (which may interpolate {value}, {value2} and {value3}), header, footer, styling variants (`dialog` adds a header description, a close button, header and footer separators and a dimmed backdrop), viewport-tier overrides, and an author-writable `visible` state.')
	.interfaces<PanelInterfaces>()
	.config({
		description: 'Panel configuration. `title`, `description` and `closeLabel` accept `$i18n` bindings (lowered to `titleKey`, `descriptionKey`, `closeLabelKey`); `{value}`, `{value2}` and `{value3}` in the title or description interpolate `value`, `value2` and `value3` (literal).',
		schema: configSchema({
			title: { type: 'string' },
			titleKey: { type: 'string' },
			description: { type: 'string' },
			descriptionKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			value2: { type: ['string', 'number'] },
			value3: { type: ['string', 'number'] },
			closable: { type: 'boolean' },
			closeLabel: { type: 'string' },
			closeLabelKey: { type: 'string' },
			backdrop: { type: 'boolean' },
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
			const { title, titleKey, description, descriptionKey, value, value2, value3, variant, closable, closeLabel, closeLabelKey, backdrop, ...layout } = raw ?? {}
			const split = splitResponsive<PanelLayout>(layout)
			return {
				...interpolationArgs({ value, value2, value3 }),
				title: typeof title === 'string' ? title : '',
				titleKey: optionalString(titleKey),
				description: typeof description === 'string' ? description : '',
				descriptionKey: optionalString(descriptionKey),
				variant: variant ?? 'default',
				closable: Boolean(closable),
				closeLabel: typeof closeLabel === 'string' ? closeLabel : 'Close',
				closeLabelKey: optionalString(closeLabelKey),
				backdrop: Boolean(backdrop),
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
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.value2Text({ valueContract: STRING, compute: ({ config }) => config.value2 })
		.value3Text({ valueContract: STRING, compute: ({ config }) => config.value3 })
		.titleResult(translatedResultWithValue<PanelInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedTextWithValue<PanelInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.descriptionResult(translatedResultWithValue<PanelInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedTextWithValue<PanelInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.closeLabelResult(translatedResult<PanelInterfaces['config']['resolved']>(c => ({ key: c.closeLabelKey, literal: c.closeLabel })))
		.closeLabel(translatedText<PanelInterfaces['config']['resolved']>(c => ({ key: c.closeLabelKey, literal: c.closeLabel })))
		.variant({ compute: ({ config }) => config.variant })
		.look({ compute: ({ config }) => ({ closable: config.closable, backdrop: config.backdrop }) })
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
	.events(events => events.close({ description: 'Fired when the close button of a closable panel is pressed' }))
	.done()

export const PanelRenderer = defineComponent({
	name: 'PanelRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties, useState, emit } = useWidget(panelPlugin)
		const props = useProperties()
		const state = useState()

		return (): VNode => {
			const title = props.title.value ?? ''
			const description = props.description.value ?? ''
			const look = props.look.value
			const frame = props.frame.value
			const closeButton = look?.closable
				? h(KitButton, {
						class: 'uiux-ref-panel-close',
						variant: 'ghost',
						size: 'sm',
						iconOnly: true,
						icon: 'x',
						label: props.closeLabel.value ?? '',
						onClick: () => emit.close(),
					})
				: null
			return h('section', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				'aria-label': title || undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-panel',
					props.theme.value,
					`variant-${props.variant.value}`,
					frame?.bordered ? 'is-bordered' : '',
					look?.backdrop ? 'has-backdrop' : '',
					frame?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				style: frame?.style,
			}, [
				title || description || closeButton
					? h('div', { class: 'uiux-ref-panel-header' }, [
							description
								? h('div', { class: 'uiux-ref-panel-heading' }, [
										title ? h('h2', { class: 'uiux-ref-panel-title' }, title) : null,
										h('p', { class: 'uiux-ref-panel-description' }, description),
									])
								: (title ? h('h2', { class: 'uiux-ref-panel-title' }, title) : null),
							h(WidgetSlot, { name: 'header' }),
							closeButton,
						])
					: h(WidgetSlot, { name: 'header' }),
				h('div', { class: 'uiux-ref-panel-body', style: frame?.bodyStyle }, [
					h(WidgetSlot, { name: 'content' }),
				]),
				h('div', { class: 'uiux-ref-panel-footer' }, [h(WidgetSlot, { name: 'footer' })]),
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
			/** Interpolated into a translated template as `{value}`, `{value2}` and `{value3}`. */
			value?: string | number
			value2?: string | number
			value3?: string | number
			weight?: 'normal' | 'medium' | 'semibold' | 'bold'
			tone?: TextTone
			mono?: boolean
			/** Semantic heading level for the rendered element, independent of the visual variant. */
			level?: 1 | 2 | 3 | 4
			/** Renders the interpolated `{value}` as inline code. */
			valueCode?: boolean
			/** Initial value of the author-writable `visible` state (Variants flip it). */
			visible?: boolean
			responsive?: Responsive<TextPresentation>
		}) | null
		resolved: InterpolationArgs & {
			text: string
			textKey: string | null
			weight: string
			tone: string
			mono: boolean
			level: number
			valueCode: boolean
			visible: boolean
			base: TextPresentation
			responsive?: Responsive<TextPresentation>
		}
	}
	state: { visible: boolean }
	properties: {
		valueText: string
		value2Text: string
		value3Text: string
		textResult: TranslationResult
		text: string
		textRuns: readonly TextRun[]
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
		description: 'Text configuration. `text` accepts an `$i18n` binding (lowered to `textKey`); `{value}`, `{value2}` and `{value3}` interpolate `value`, `value2` and `value3` (literal), and with `valueCode` `{value}` shows as inline code (a file name, an Event). `visible` is the initial value of the `visible` state. Legacy variants h1–h4, caption and code map onto the same scale; nothing renders below 12px.',
		schema: configSchema({
			text: { type: 'string' },
			textKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			value2: { type: ['string', 'number'] },
			value3: { type: ['string', 'number'] },
			variant: { enum: ['display', 'headline', 'title', 'body', 'ui', 'label', 'mono', 'h1', 'h2', 'h3', 'h4', 'caption', 'code'] },
			weight: { enum: ['normal', 'medium', 'semibold', 'bold'] },
			tone: { enum: ['default', 'highlighted', 'muted', 'subtle', 'primary', 'annotation', 'success', 'warning', 'danger', 'info'] },
			mono: { type: 'boolean' },
			level: { enum: [1, 2, 3, 4] },
			valueCode: { type: 'boolean' },
			visible: { type: 'boolean' },
			truncate: { type: 'boolean' },
			lines: { type: 'number' },
			align: { enum: ['start', 'center', 'end'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is TextInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { text, textKey, value, value2, value3, weight, tone, mono, level, valueCode, visible, ...presentation } = raw ?? {}
			return {
				text: typeof text === 'string' ? text : '',
				textKey: optionalString(textKey),
				...interpolationArgs({ value, value2, value3 }),
				weight: weight ?? '',
				tone: tone ?? 'default',
				mono: Boolean(mono),
				level: typeof level === 'number' ? level : 0,
				valueCode: Boolean(valueCode),
				visible: visible === undefined ? true : Boolean(visible),
				...splitResponsive<TextPresentation>(presentation),
			}
		},
	})
	.state(state => state.visible({ ...visibleState, default: ({ config }) => config.visible }))
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.value2Text({ valueContract: STRING, compute: ({ config }) => config.value2 })
		.value3Text({ valueContract: STRING, compute: ({ config }) => config.value3 })
		.textResult(translatedResultWithValue<TextInterfaces['config']['resolved']>(c => ({ key: c.textKey, literal: c.text })))
		.text({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('textResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.textRuns(textRunsOf<TextInterfaces['config']['resolved']>(c => ({ key: c.textKey, literal: c.text })))
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
		const { widgetId, useProperties, useState } = useWidget(textPlugin)
		const props = useProperties()
		const state = useState()

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
					presentation?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				style,
			}, runNodes(props.textRuns.value, props.text.value ?? ''))
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

/** `neutral` is the solid neutral button (the current choice of a group); `link` is a primary link, `link-muted` a quiet one. */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'annotation' | 'link' | 'link-muted' | 'brand' | 'display' | 'neutral'
const BUTTON_VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'outline', 'danger', 'annotation', 'link', 'link-muted', 'brand', 'display', 'neutral']

export interface ButtonInterfaces {
	config: {
		raw: (ButtonPresentation & {
			label?: string
			labelKey?: string
			/** Interpolated into a translated label as `{value}`, `{value2}` and `{value3}`. */
			value?: string | number
			value2?: string | number
			value3?: string | number
			variant?: ButtonVariant
			disabled?: boolean
			/** Work is in progress: a spinning icon replaces the icon, and the button does not press. */
			loading?: boolean
			/** Initial value of the author-writable `visible` state (Variants flip it). */
			visible?: boolean
			/** Renders the interpolated `{value}` as inline code. */
			valueCode?: boolean
			icon?: string
			trailingIcon?: string
			kbd?: string
			responsive?: Responsive<ButtonPresentation>
		}) | null
		resolved: InterpolationArgs & {
			label: string
			labelKey: string | null
			variant: ButtonVariant
			disabled: boolean
			loading: boolean
			visible: boolean
			valueCode: boolean
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
		loading: boolean
		variant: ButtonVariant
	}
	events: {
		click: readonly []
	}
	properties: {
		valueText: string
		value2Text: string
		value3Text: string
		labelResult: TranslationResult
		label: string
		labelRuns: readonly TextRun[]
		variant: string
		icon: string
		presentation: { size: string; iconOnly: boolean; fullWidth: boolean; hidden: boolean; touch: boolean; kbd: string; trailingIcon: string }
		theme: string
	}
}

export const buttonPlugin = createWidgetPlugin('Button')
	.description('Button with translatable label, Lucide icon, optional trailing icon and shortcut hint, neutral-outline default, one solid primary per region (or the solid neutral for a group\'s current choice), muted or primary link looks, a loading spinner, and 44px targets on touch tiers. Author-writable `disabled`, `visible`, `loading` and `variant` states drive Variants.')
	.interfaces<ButtonInterfaces>()
	.config({
		description: 'Button configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`); `{value}`, `{value2}` and `{value3}` interpolate `value`, `value2` and `value3`, and with `valueCode` `{value}` shows as inline code. `icon` and `trailingIcon` take Lucide names. `variant`, `disabled` and `loading` are the initial values of the states of the same name.',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			value2: { type: ['string', 'number'] },
			value3: { type: ['string', 'number'] },
			variant: { enum: [...BUTTON_VARIANTS] },
			size: { enum: ['sm', 'md', 'lg'] },
			disabled: { type: 'boolean' },
			loading: { type: 'boolean' },
			visible: { type: 'boolean' },
			valueCode: { type: 'boolean' },
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
			const { label, labelKey, value, value2, value3, variant, disabled, loading, visible, valueCode, icon, trailingIcon, kbd, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : 'Button',
				labelKey: optionalString(labelKey),
				...interpolationArgs({ value, value2, value3 }),
				variant: oneOf(variant, BUTTON_VARIANTS, 'secondary'),
				disabled: Boolean(disabled),
				loading: Boolean(loading),
				visible: visible === undefined ? true : Boolean(visible),
				valueCode: Boolean(valueCode),
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
		.visible({ ...visibleState, default: ({ config }) => config.visible })
		.loading({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.loading })
		.variant({ authorWritable: true, validate: (v): v is ButtonVariant => (BUTTON_VARIANTS as readonly unknown[]).includes(v), default: ({ config }) => config.variant }))
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.value2Text({ valueContract: STRING, compute: ({ config }) => config.value2 })
		.value3Text({ valueContract: STRING, compute: ({ config }) => config.value3 })
		.labelResult(translatedResultWithValue<ButtonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedTextWithValue<ButtonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.labelRuns(textRunsOf<ButtonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
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
			const label = props.label.value ?? ''
			const runs = props.labelRuns.value
			const hasCode = Boolean(runs?.some(run => run.code)) && !presentation?.iconOnly
			return h(KitButton, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				label,
				variant: (state.variant.value ?? 'secondary') as ButtonVariant,
				size: (presentation?.size ?? 'md') as 'sm' | 'md' | 'lg',
				icon: props.icon.value || undefined,
				trailingIcon: presentation?.trailingIcon || undefined,
				kbd: presentation?.kbd || undefined,
				iconOnly: Boolean(presentation?.iconOnly),
				fullWidth: Boolean(presentation?.fullWidth),
				touch: Boolean(presentation?.touch),
				disabled: Boolean(state.disabled.value),
				loading: Boolean(state.loading.value),
				class: [
					'uiux-ref-scope',
					props.theme.value,
					presentation?.hidden || !state.visible.value ? 'uiux-ref-hidden' : '',
				],
				onClick: () => {
					if (!state.disabled.value && !state.loading.value) emit.click()
				},
			}, hasCode ? { default: () => runNodes(runs, label) } : undefined)
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
			/** Spins the icon, for work in progress. */
			spin?: boolean
			/** Initial value of the author-writable `visible` state (Variants flip it). */
			visible?: boolean
			responsive?: Responsive<BadgePresentation>
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			value: string
			tone: string
			variant: string
			icon: string
			spin: boolean
			visible: boolean
			base: BadgePresentation
			responsive?: Responsive<BadgePresentation>
		}
	}
	state: { visible: boolean }
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
		spin: boolean
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
			spin: { type: 'boolean' },
			visible: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is BadgeInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, value, tone, variant, icon, spin, visible, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : '',
				labelKey: optionalString(labelKey),
				value: value === undefined ? '' : String(value),
				tone: tone ?? 'neutral',
				variant: variant ?? 'subtle',
				icon: typeof icon === 'string' ? icon : '',
				spin: Boolean(spin),
				visible: visible === undefined ? true : Boolean(visible),
				...splitResponsive<BadgePresentation>(presentation),
			}
		},
	})
	.state(state => state.visible({ ...visibleState, default: ({ config }) => config.visible }))
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
		.spin({ compute: ({ config }) => config.spin })
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
		const { widgetId, useProperties, useState } = useWidget(badgePlugin)
		const props = useProperties()
		const state = useState()

		return (): VNode => h(KitBadge, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			label: props.label.value ?? '',
			tone: props.tone.value as BadgeTone,
			variant: props.variant.value as BadgeVariant,
			icon: props.icon.value || undefined,
			spin: Boolean(props.spin.value),
			class: [
				'uiux-ref-scope',
				props.theme.value,
				props.hidden.value || !state.visible.value ? 'uiux-ref-hidden' : '',
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
			/** Locale key of the text the field shows (the lowered `$i18n` binding of `value`). */
			valueKey?: string
			/** The label names the control for assistive technology only and takes no room. */
			hideLabel?: boolean
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
			/** Marks the label with `*` and the control as required. */
			required?: boolean
			icon?: string
			kbd?: string
			mono?: boolean
			/** Renders a textarea with this many rows. */
			rows?: number
			responsive?: Responsive<TextInputPresentation>
		}) | null
		resolved: {
			value: string
			valueKey: string
			hideLabel: boolean
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
			required: boolean
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
		/** A Locale key: while set, the field shows its translation instead of `value` (typing clears it). */
		valueKey: string
		invalid: boolean
	}
	properties: {
		valueResult: TranslationResult
		value: string
		placeholderResult: TranslationResult
		placeholder: string
		labelResult: TranslationResult
		label: string
		helpResult: TranslationResult
		help: string
		errorResult: TranslationResult
		error: string
		readOnly: boolean
		presentation: { hidden: boolean; touch: boolean; kbd: string; icon: string; mono: boolean; rows: number; required: boolean; hideLabel: boolean }
		theme: string
	}
}

export const textInputPlugin = createWidgetPlugin('TextInput')
	.description('Text field or textarea with translatable label, placeholder, help and error text, leading Lucide icon, shortcut hint, and an author-writable `invalid` state.')
	.interfaces<TextInputInterfaces>()
	.config({
		description: 'TextInput configuration. `value`, `placeholder`, `label`, `help` and `error` accept `$i18n` bindings (lowered to `valueKey`, `placeholderKey`, `labelKey`, `helpKey`, `errorKey`). The error text shows only while `invalid` is true. `hideLabel` keeps the label for assistive technology only.',
		schema: configSchema({
			value: { type: 'string' },
			valueKey: { type: 'string' },
			hideLabel: { type: 'boolean' },
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
			required: { type: 'boolean' },
			icon: { type: 'string' },
			kbd: { type: 'string' },
			mono: { type: 'boolean' },
			rows: { type: 'number' },
			hidden: { type: 'boolean' },
			hideKbd: { type: 'boolean' },
		}),
		validate: (c): c is TextInputInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { value, valueKey, hideLabel, placeholder, placeholderKey, readOnly, label, labelKey, help, helpKey, error, errorKey, invalid, required, icon, kbd, mono, rows, ...presentation } = raw ?? {}
			return {
				value: typeof value === 'string' ? value : '',
				valueKey: typeof valueKey === 'string' ? valueKey : '',
				hideLabel: Boolean(hideLabel),
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
				required: Boolean(required),
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
		.valueKey({
			authorWritable: true,
			validate: (v): v is string => typeof v === 'string',
			default: ({ config }) => config.valueKey,
		})
		.invalid({
			authorWritable: true,
			validate: isBoolean,
			default: ({ config }) => config.invalid,
		}))
	.properties(p => p
		.valueResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({ ...translateDeps({ dep }), key: dep.self.state.get('valueKey') }),
			compute: ({ deps }) => translateStateKey(stringFromResult(deps.key()), (key, params) => deps.t(key, params)),
		})
		.value({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('valueResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
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
					required: config.required,
					hideLabel: config.hideLabel,
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
				modelValue: state.valueKey.value ? (props.value.value ?? '') : (state.value.value ?? ''),
				label: props.label.value ?? '',
				hideLabel: Boolean(presentation?.hideLabel),
				placeholder: props.placeholder.value ?? '',
				help: props.help.value ?? '',
				error: props.error.value ?? '',
				invalid: Boolean(state.invalid.value),
				required: Boolean(presentation?.required),
				readonly: Boolean(props.readOnly.value),
				icon: presentation?.icon || undefined,
				kbd: presentation?.kbd || undefined,
				mono: Boolean(presentation?.mono),
				rows: presentation?.rows || undefined,
				touch: Boolean(presentation?.touch),
				'onUpdate:modelValue': (value: string) => {
					if (props.readOnly.value) return
					state.valueKey.value = ''
					state.value.value = value
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
		raw: ({ keys?: string; hidden?: boolean; showOnTouch?: boolean; responsive?: Responsive<{ hidden?: boolean }> }) | null
		resolved: { keys: string; showOnTouch: boolean; base: { hidden?: boolean }; responsive?: Responsive<{ hidden?: boolean }> }
	}
	properties: { keys: string; hidden: boolean; theme: string }
}

export const kbdPlugin = createWidgetPlugin('Kbd')
	.description('Keyboard shortcut key cap in the mono blueprint register. Keys are literal and never translated; hidden on touch tiers by default, except with `showOnTouch` (a shortcut list shows the keys as its content, not as a hint).')
	.interfaces<KbdInterfaces>()
	.config({
		description: 'Kbd configuration. `keys` is a literal such as "⌘K", "C" or "Esc". `showOnTouch` keeps the key cap on the tablet and phone tiers, where a hint is hidden by default.',
		schema: configSchema({ keys: { type: 'string' }, hidden: { type: 'boolean' }, showOnTouch: { type: 'boolean' } }),
		validate: (c): c is KbdInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { keys, showOnTouch, ...presentation } = raw ?? {}
			return { keys: stringOr(keys, ''), showOnTouch: Boolean(showOnTouch), ...splitResponsive<{ hidden?: boolean }>(presentation) }
		},
	})
	.properties(p => p
		.keys({ compute: ({ config }) => config.keys })
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const tier = tierOf(readViewport(deps.viewport()))
				return Boolean(cascade(config.base, config.responsive, tier).hidden) || (isTouchTier(tier) && !config.showOnTouch)
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
/** `tabs` is an underline strip, `pills` rounded pills (the current one on an elevated fill), `segment` a segmented toggle. */
type SegmentAppearance = 'segment' | 'tabs' | 'pills' | 'palette'
const SEGMENT_APPEARANCES: readonly SegmentAppearance[] = ['segment', 'tabs', 'pills', 'palette']

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
			appearance: { enum: [...SEGMENT_APPEARANCES] },
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
				role: appearance === 'tabs' || appearance === 'pills' ? 'tablist' : appearance === 'palette' ? 'toolbar' : 'group',
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
			/** A translatable soft badge after the label, such as "Unsaved". It takes the `countTone` tone. */
			badge?: string
			badgeKey?: string
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
			badge: string
			badgeKey: string | null
			appearance: SegmentAppearance
			activeTone: string
			selected: boolean
			base: SegmentPresentation
			responsive?: Responsive<SegmentPresentation>
		}
	}
	state: {
		selected: boolean
		/** A Locale key: while set, the badge shows its translation instead of `badge` (a Variant shows a badge on a tab). */
		badgeKey: string
	}
	events: { click: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		badgeResult: TranslationResult
		badge: string
		look: { icon: string; kbd: string; count: string; countTone: string; appearance: SegmentAppearance; activeTone: string; iconOnly: boolean; hidden: boolean; touch: boolean }
		theme: string
	}
}

export const segmentPlugin = createWidgetPlugin('Segment')
	.description('One option inside a SegmentedControl: Lucide icon, translatable label, count, and shortcut hint. The palette appearance fills Iris when selected, or tints Marker for the Comment tool (`activeTone: "annotation"`).')
	.interfaces<SegmentInterfaces>()
	.config({
		description: 'Segment configuration. `label` and `badge` accept `$i18n` bindings (lowered to `labelKey`, `badgeKey`); `appearance` must match the parent SegmentedControl.',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			icon: { type: 'string' },
			kbd: { type: 'string' },
			count: { type: ['string', 'number'] },
			countTone: { enum: ['neutral', 'annotation', 'info'] },
			badge: { type: 'string' },
			badgeKey: { type: 'string' },
			appearance: { enum: [...SEGMENT_APPEARANCES] },
			activeTone: { enum: ['primary', 'annotation'] },
			selected: { type: 'boolean' },
			iconOnly: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is SegmentInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: (raw) => {
			const { label, labelKey, icon, kbd, count, countTone, badge, badgeKey, appearance, activeTone, selected, ...presentation } = raw ?? {}
			return {
				label: stringOr(label, ''),
				labelKey: optionalString(labelKey),
				icon: stringOr(icon, ''),
				kbd: stringOr(kbd, ''),
				count: count === undefined ? '' : String(count),
				countTone: countTone ?? 'neutral',
				badge: stringOr(badge, ''),
				badgeKey: optionalString(badgeKey),
				appearance: oneOf(appearance, SEGMENT_APPEARANCES, 'segment'),
				activeTone: activeTone ?? 'primary',
				selected: Boolean(selected),
				...splitResponsive<SegmentPresentation>(presentation),
			}
		},
	})
	.state(state => state
		.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected })
		.badgeKey({ authorWritable: true, validate: (v): v is string => typeof v === 'string', default: ({ config }) => config.badgeKey ?? '' }))
	.properties(p => p
		.labelResult(translatedResult<SegmentInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SegmentInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.badgeResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({ ...translateDeps({ dep }), key: dep.self.state.get('badgeKey') }),
			compute: ({ config, deps }) => translateField(optionalString(stringFromResult(deps.key())), config.badge, (key, params) => deps.t(key, params)),
		})
		.badge({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('badgeResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
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
			const badge = props.badge.value ?? ''
			if (badge && !look?.iconOnly) children.push(h(KitBadge, { variant: 'soft', tone: (look?.countTone ?? 'neutral') as BadgeTone, label: badge }))
			if (look?.kbd && !look.iconOnly) children.push(kbdNode(look.kbd))
			const tabLike = appearance === 'tabs' || appearance === 'pills'
			return h('button', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				type: 'button',
				role: tabLike ? 'tab' : undefined,
				'aria-selected': tabLike ? String(selected) : undefined,
				'aria-pressed': tabLike ? undefined : String(selected),
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
		raw: ({ tone?: AlertTone; icon?: string; title?: string; titleKey?: string; description?: string; descriptionKey?: string; value?: string | number; value2?: string | number; value3?: string | number; valueCode?: boolean; toast?: boolean; visible?: boolean; dismissible?: boolean; dismissLabel?: string; dismissLabelKey?: string }) | null
		resolved: InterpolationArgs & { tone: AlertTone; icon: string; title: string; titleKey: string | null; description: string; descriptionKey: string | null; valueCode: boolean; toast: boolean; visible: boolean; dismissible: boolean; dismissLabel: string; dismissLabelKey: string | null }
	}
	slots: 'actions'
	state: { visible: boolean }
	events: { dismiss: readonly [] }
	properties: {
		valueText: string
		value2Text: string
		value3Text: string
		titleResult: TranslationResult
		title: string
		titleRuns: readonly TextRun[]
		descriptionResult: TranslationResult
		description: string
		descriptionRuns: readonly TextRun[]
		dismissLabelResult: TranslationResult
		dismissLabel: string
		look: { tone: AlertTone; icon: string; toast: boolean; dismissible: boolean }
		theme: string
	}
}

export const alertPlugin = createWidgetPlugin('Alert')
	.description('Subtle inline alert with a status icon, title, description and an actions slot; `toast: true` renders the floating toast surface, and `dismissible: true` adds a close button that hides the alert and fires `dismiss`. Author-writable `visible` state drives Variants.')
	.interfaces<AlertInterfaces>()
	.config({
		description: 'Alert configuration. `title`, `description` and `dismissLabel` accept `$i18n` bindings (lowered to `titleKey`, `descriptionKey`, `dismissLabelKey`); `{value}` in the title or description interpolates `value`, and with `valueCode` it shows as inline code.',
		schema: configSchema({
			tone: { enum: ['info', 'success', 'warning', 'danger', 'annotation'] },
			icon: { type: 'string' },
			title: { type: 'string' }, titleKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			value2: { type: ['string', 'number'] },
			value3: { type: ['string', 'number'] },
			valueCode: { type: 'boolean' },
			toast: { type: 'boolean' },
			visible: { type: 'boolean' },
			dismissible: { type: 'boolean' },
			dismissLabel: { type: 'string' }, dismissLabelKey: { type: 'string' },
		}),
		validate: (c): c is AlertInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			tone: oneOf(raw?.tone, ['info', 'success', 'warning', 'danger', 'annotation'] as const, 'info'),
			icon: stringOr(raw?.icon, ''),
			title: stringOr(raw?.title, ''),
			titleKey: optionalString(raw?.titleKey),
			description: stringOr(raw?.description, ''),
			descriptionKey: optionalString(raw?.descriptionKey),
			...interpolationArgs(raw),
			valueCode: Boolean(raw?.valueCode),
			toast: Boolean(raw?.toast),
			visible: raw?.visible === undefined ? true : Boolean(raw.visible),
			dismissible: Boolean(raw?.dismissible),
			dismissLabel: stringOr(raw?.dismissLabel, 'Dismiss'),
			dismissLabelKey: optionalString(raw?.dismissLabelKey),
		}),
	})
	.slots({ actions: { description: 'Recovery actions and identity chips' } })
	.state(state => state.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.value2Text({ valueContract: STRING, compute: ({ config }) => config.value2 })
		.value3Text({ valueContract: STRING, compute: ({ config }) => config.value3 })
		.titleResult(translatedResultWithValue<AlertInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.title(translatedTextWithValue<AlertInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.titleRuns(textRunsOf<AlertInterfaces['config']['resolved']>(c => ({ key: c.titleKey, literal: c.title })))
		.descriptionResult(translatedResultWithValue<AlertInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedTextWithValue<AlertInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.descriptionRuns(textRunsOf<AlertInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.dismissLabelResult(translatedResult<AlertInterfaces['config']['resolved']>(c => ({ key: c.dismissLabelKey, literal: c.dismissLabel })))
		.dismissLabel(translatedText<AlertInterfaces['config']['resolved']>(c => ({ key: c.dismissLabelKey, literal: c.dismissLabel })))
		.look({ compute: ({ config }) => ({ tone: config.tone, icon: config.icon || ALERT_ICON[config.tone], toast: config.toast, dismissible: config.dismissible }) })
		.theme(themeProperty()),
	)
	.events(events => events.dismiss({ description: 'Fired when the dismiss button is pressed; the alert hides itself' }))
	.done()

export const AlertRenderer = defineComponent({
	name: 'AlertRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties, emit } = useWidget(alertPlugin)
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
					props.title.value ? h('p', { class: 'uiux-ref-alert-title' }, runNodes(props.titleRuns.value, props.title.value)) : null,
					props.description.value ? h('p', { class: 'uiux-ref-alert-desc' }, runNodes(props.descriptionRuns.value, props.description.value)) : null,
					h('div', { class: 'uiux-ref-alert-actions' }, [h(WidgetSlot, { name: 'actions' })]),
				]),
				look?.dismissible
					? h(KitButton, {
							class: 'uiux-ref-alert-dismiss',
							variant: 'ghost',
							size: 'sm',
							iconOnly: true,
							icon: 'x',
							label: props.dismissLabel.value ?? '',
							onClick: () => {
								state.visible.value = false
								emit.dismiss()
							},
						})
					: null,
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 21. EmptyState — always one next action
// ---------------------------------------------------------------------------
export interface EmptyStateInterfaces {
	config: {
		raw: ({ icon?: string; title?: string; titleKey?: string; description?: string; descriptionKey?: string; dashed?: boolean; compact?: boolean; visible?: boolean }) | null
		resolved: { icon: string; title: string; titleKey: string | null; description: string; descriptionKey: string | null; dashed: boolean; compact: boolean; visible: boolean }
	}
	slots: 'actions'
	state: { visible: boolean }
	properties: {
		titleResult: TranslationResult
		title: string
		descriptionResult: TranslationResult
		description: string
		look: { icon: string; dashed: boolean; compact: boolean }
		theme: string
	}
}

export const emptyStatePlugin = createWidgetPlugin('EmptyState')
	.description('Empty state with a muted icon disc, title, description and one next action. `dashed: true` draws the 1px dashed "nothing authored yet" boundary; `compact: true` is the one-line dashed block for an empty list inside a page (no icon disc, a quiet title). Author-writable `visible` state drives Variants.')
	.interfaces<EmptyStateInterfaces>()
	.config({
		description: 'EmptyState configuration. `title` and `description` accept `$i18n` bindings (lowered to `titleKey`, `descriptionKey`).',
		schema: configSchema({
			icon: { type: 'string' },
			title: { type: 'string' }, titleKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			dashed: { type: 'boolean' },
			compact: { type: 'boolean' },
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
			compact: Boolean(raw?.compact),
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
		.look({ compute: ({ config }) => ({ icon: config.icon, dashed: config.dashed, compact: config.compact }) })
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
				class: ['uiux-ref-scope', 'uiux-ref-empty', props.theme.value, look?.dashed ? 'is-dashed' : '', look?.compact ? 'is-compact' : '', state.visible.value ? '' : 'uiux-ref-hidden'],
			}, [
				look?.icon ? h('span', { class: 'uiux-ref-empty-icon' }, [iconNode(look.icon, look.compact ? 16 : 20)]) : null,
				h('p', { class: 'uiux-ref-empty-title' }, props.title.value ?? ''),
				props.description.value ? h('p', { class: 'uiux-ref-empty-desc' }, props.description.value) : null,
				h('div', { class: 'uiux-ref-empty-actions' }, [h(WidgetSlot, { name: 'actions' })]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 22. Icon — a Lucide icon from the Kit's curated set (kit/src/ui/Icon.vue)
// ---------------------------------------------------------------------------
type IconTone = 'default' | 'muted' | 'subtle' | 'primary' | 'annotation' | 'success' | 'warning' | 'danger' | 'info'
const ICON_TONES: readonly IconTone[] = ['default', 'muted', 'subtle', 'primary', 'annotation', 'success', 'warning', 'danger', 'info']

export interface IconInterfaces {
	config: {
		raw: ({ name?: string; size?: number; tone?: IconTone; label?: string; labelKey?: string; visible?: boolean }) | null
		resolved: { name: string; size: number; tone: IconTone; label: string; labelKey: string | null; visible: boolean }
	}
	state: { visible: boolean }
	properties: {
		labelResult: TranslationResult
		label: string
		look: { name: string; size: number; tone: IconTone }
		theme: string
	}
}

export const iconPlugin = createWidgetPlugin('Icon')
	.description('A Lucide icon by name from the Kit icon set, with a size and a tone. It is decorative unless it has a `label`, which becomes its accessible name (`role="img"`).')
	.interfaces<IconInterfaces>()
	.config({
		description: 'Icon configuration. `name` is a Lucide icon name without a prefix; an unknown name renders as literal text. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			name: { type: 'string' },
			size: { type: 'number' },
			tone: { enum: [...ICON_TONES] },
			label: { type: 'string' }, labelKey: { type: 'string' },
			visible: { type: 'boolean' },
		}),
		validate: (c): c is IconInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			name: stringOr(raw?.name, ''),
			size: typeof raw?.size === 'number' && raw.size > 0 ? raw.size : 16,
			tone: oneOf(raw?.tone, ICON_TONES, 'default'),
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			visible: raw?.visible === undefined ? true : Boolean(raw.visible),
		}),
	})
	.state(state => state.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.labelResult(translatedResult<IconInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<IconInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.look({ compute: ({ config }) => ({ name: config.name, size: config.size, tone: config.tone }) })
		.theme(themeProperty()),
	)
	.done()

export const IconRenderer = defineComponent({
	name: 'IconRenderer',
	setup() {
		const { widgetId, useProperties, useState } = useWidget(iconPlugin)
		const props = useProperties()
		const state = useState()
		return (): VNode => {
			const look = props.look.value
			const label = props.label.value ?? ''
			return h('span', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				role: label ? 'img' : undefined,
				'aria-label': label || undefined,
				'aria-hidden': label ? undefined : 'true',
				class: ['uiux-ref-scope', 'uiux-ref-icon', props.theme.value, `tone-${look?.tone ?? 'default'}`, state.visible.value ? '' : 'uiux-ref-hidden'],
			}, [h(KitIcon, { name: look?.name ?? '', size: look?.size ?? 16 })])
		}
	},
})

// ---------------------------------------------------------------------------
// 23. Skeleton — loading placeholder (kit/src/ui/Skeleton.vue)
// ---------------------------------------------------------------------------
export interface SkeletonInterfaces {
	config: {
		raw: ({ width?: number | string; height?: number | string; radius?: number | string; label?: string; labelKey?: string }) | null
		resolved: { width: number | string | undefined; height: number | string | undefined; radius: number | string | undefined; label: string; labelKey: string | null }
	}
	properties: {
		labelResult: TranslationResult
		label: string
		size: { width: number | string | undefined; height: number | string | undefined; radius: number | string | undefined }
		theme: string
	}
}

export const skeletonPlugin = createWidgetPlugin('Skeleton')
	.description('Loading placeholder block with a width, a height and a corner radius. With a `label` it is a named `status` region (`aria-busy`); without one it is hidden from assistive technology. The pulse stops under reduced motion.')
	.interfaces<SkeletonInterfaces>()
	.config({
		description: 'Skeleton configuration. A number is px and a string any CSS length. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			width: { type: ['number', 'string'] },
			height: { type: ['number', 'string'] },
			radius: { type: ['number', 'string'] },
			label: { type: 'string' }, labelKey: { type: 'string' },
		}),
		validate: (c): c is SkeletonInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			width: lengthOr(raw?.width),
			height: lengthOr(raw?.height),
			radius: lengthOr(raw?.radius),
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
		}),
	})
	.properties(p => p
		.labelResult(translatedResult<SkeletonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SkeletonInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.size({ compute: ({ config }) => ({ width: config.width, height: config.height, radius: config.radius }) })
		.theme(themeProperty()),
	)
	.done()

export const SkeletonRenderer = defineComponent({
	name: 'SkeletonRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(skeletonPlugin)
		const props = useProperties()
		return (): VNode => h(KitSkeleton, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			width: props.size.value?.width,
			height: props.size.value?.height,
			radius: props.size.value?.radius,
			label: props.label.value || undefined,
			class: ['uiux-ref-scope', props.theme.value],
		})
	},
})

// ---------------------------------------------------------------------------
// 24. ListItem — one generic row: leading, content, trailing (kit/src/ui/ListItem.vue)
// ---------------------------------------------------------------------------
export interface ListItemInterfaces {
	config: {
		raw: ({ selected?: boolean; dimmed?: boolean; visible?: boolean; level?: number; divided?: boolean; interactive?: boolean; size?: ListItemSize; align?: 'center' | 'start'; selectedLook?: 'accent' | 'neutral' }) | null
		resolved: { selected: boolean; dimmed: boolean; visible: boolean; level: number; divided: boolean; interactive: boolean; size: ListItemSize; align: 'center' | 'start'; selectedLook: 'accent' | 'neutral' }
	}
	slots: 'leading' | 'content' | 'trailing'
	state: { selected: boolean; dimmed: boolean; visible: boolean }
	events: { click: readonly [] }
	properties: {
		look: { level: number; divided: boolean; interactive: boolean; size: ListItemSize; align: 'center' | 'start'; selectedLook: 'accent' | 'neutral' }
		theme: string
	}
}

/** The row's minimum height: `sm` 28px, `md` 36px, `lg` 48px. */
type ListItemSize = 'sm' | 'md' | 'lg'
const LIST_ITEM_SIZES: readonly ListItemSize[] = ['sm', 'md', 'lg']

export const listItemPlugin = createWidgetPlugin('ListItem')
	.description('One generic row for lists, timelines, step lists and trees: `leading`, `content` and `trailing` slots, an indent `level`, a `divided` hairline, a row height (`size`), top alignment of the end slots (`align`), a neutral current-row look (`selectedLook`), and author-writable `selected`, `dimmed` and `visible` states. `interactive` makes the row one focusable, pressable target that fires `click`.')
	.interfaces<ListItemInterfaces>()
	.config({
		description: 'ListItem configuration. `level` is the indent depth (16px per level). `size` is the minimum height (`sm` 28px, `md` 36px, `lg` 48px). `align: "start"` pins `leading` and `trailing` to the top of a tall row. `selectedLook: "neutral"` marks the current row with an elevated neutral fill instead of the primary tint and bar.',
		schema: configSchema({
			selected: { type: 'boolean' },
			dimmed: { type: 'boolean' },
			visible: { type: 'boolean' },
			level: { type: 'number' },
			divided: { type: 'boolean' },
			interactive: { type: 'boolean' },
			size: { enum: [...LIST_ITEM_SIZES] },
			align: { enum: ['center', 'start'] },
			selectedLook: { enum: ['accent', 'neutral'] },
		}),
		validate: (c): c is ListItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			selected: Boolean(raw?.selected),
			dimmed: Boolean(raw?.dimmed),
			visible: raw?.visible === undefined ? true : Boolean(raw.visible),
			level: typeof raw?.level === 'number' && raw.level > 0 ? Math.floor(raw.level) : 0,
			divided: Boolean(raw?.divided),
			interactive: Boolean(raw?.interactive),
			size: oneOf(raw?.size, LIST_ITEM_SIZES, 'sm'),
			align: oneOf(raw?.align, ['center', 'start'] as const, 'center'),
			selectedLook: oneOf(raw?.selectedLook, ['accent', 'neutral'] as const, 'accent'),
		}),
	})
	.slots({
		leading: { description: 'An icon, marker or number before the content' },
		content: { description: 'The row text and any secondary lines' },
		trailing: { description: 'A badge, time or note after the content' },
	})
	.state(state => state
		.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected })
		.dimmed({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.dimmed })
		.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.look({ compute: ({ config }) => ({ level: config.level, divided: config.divided, interactive: config.interactive, size: config.size, align: config.align, selectedLook: config.selectedLook }) })
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when an interactive row is pressed' }))
	.done()

export const ListItemRenderer = defineComponent({
	name: 'ListItemRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties, emit } = useWidget(listItemPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h(KitListItem, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				selected: Boolean(state.selected.value),
				dimmed: Boolean(state.dimmed.value),
				level: look?.level || undefined,
				divided: Boolean(look?.divided),
				interactive: Boolean(look?.interactive),
				size: look?.size,
				align: look?.align,
				selectedLook: look?.selectedLook,
				class: ['uiux-ref-scope', props.theme.value, state.visible.value ? '' : 'uiux-ref-hidden'],
				onClick: () => {
					if (look?.interactive) emit.click()
				},
			}, {
				leading: () => h(WidgetSlot, { name: 'leading' }),
				content: () => h(WidgetSlot, { name: 'content' }),
				trailing: () => h(WidgetSlot, { name: 'trailing' }),
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 25. Checkbox — native checkbox with a label, a description and a mono meta (kit/src/ui/Checkbox.vue)
// ---------------------------------------------------------------------------
export interface CheckboxInterfaces {
	config: {
		raw: ({
			label?: string
			labelKey?: string
			description?: string
			descriptionKey?: string
			descriptionTone?: 'muted' | 'warning'
			checked?: boolean
			indeterminate?: boolean
			disabled?: boolean
			meta?: string
			/** The label is mono 12px text, for ids and file names. */
			mono?: boolean
			/** The whole row is a 44px target. */
			touch?: boolean
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			description: string
			descriptionKey: string | null
			descriptionTone: 'muted' | 'warning'
			checked: boolean
			indeterminate: boolean
			disabled: boolean
			meta: string
			mono: boolean
			touch: boolean
		}
	}
	state: { checked: boolean; indeterminate: boolean; disabled: boolean }
	events: { toggle: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		descriptionResult: TranslationResult
		description: string
		look: { descriptionTone: 'muted' | 'warning'; meta: string; mono: boolean; touch: boolean }
		theme: string
	}
}

export const checkboxPlugin = createWidgetPlugin('Checkbox')
	.description('Native checkbox with a translatable label and description, a literal mono `meta` at the end, a `warning` description tone, a mono label (`mono`), a 44px row target (`touch`), and author-writable `checked`, `indeterminate` and `disabled` states. A press writes `checked` and fires `toggle`.')
	.interfaces<CheckboxInterfaces>()
	.config({
		description: 'Checkbox configuration. `label` and `description` accept `$i18n` bindings (lowered to `labelKey`, `descriptionKey`). `meta` is literal mono text such as an id or a count. `mono` sets the label in mono 12px; `touch` makes the whole row a 44px target.',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			descriptionTone: { enum: ['muted', 'warning'] },
			checked: { type: 'boolean' },
			indeterminate: { type: 'boolean' },
			disabled: { type: 'boolean' },
			meta: { type: 'string' },
			mono: { type: 'boolean' },
			touch: { type: 'boolean' },
		}),
		validate: (c): c is CheckboxInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			description: stringOr(raw?.description, ''),
			descriptionKey: optionalString(raw?.descriptionKey),
			descriptionTone: oneOf(raw?.descriptionTone, ['muted', 'warning'] as const, 'muted'),
			checked: Boolean(raw?.checked),
			indeterminate: Boolean(raw?.indeterminate),
			disabled: Boolean(raw?.disabled),
			meta: stringOr(raw?.meta, ''),
			mono: Boolean(raw?.mono),
			touch: Boolean(raw?.touch),
		}),
	})
	.state(state => state
		.checked({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.checked })
		.indeterminate({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.indeterminate })
		.disabled({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.disabled }))
	.properties(p => p
		.labelResult(translatedResult<CheckboxInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<CheckboxInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.descriptionResult(translatedResult<CheckboxInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedText<CheckboxInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.look({ compute: ({ config }) => ({ descriptionTone: config.descriptionTone, meta: config.meta, mono: config.mono, touch: config.touch }) })
		.theme(themeProperty()),
	)
	.events(events => events.toggle({ description: 'Fired when the user toggles the checkbox' }))
	.done()

export const CheckboxRenderer = defineComponent({
	name: 'CheckboxRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(checkboxPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h(KitCheckbox, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				id: `${widgetId}-checkbox`,
				label: props.label.value || undefined,
				description: props.description.value || undefined,
				descriptionTone: look?.descriptionTone,
				checked: Boolean(state.checked.value),
				indeterminate: Boolean(state.indeterminate.value),
				disabled: Boolean(state.disabled.value),
				meta: look?.meta || undefined,
				mono: Boolean(look?.mono),
				touch: Boolean(look?.touch),
				class: ['uiux-ref-scope', props.theme.value],
				onToggle: (checked: boolean) => {
					if (state.disabled.value) return
					state.checked.value = checked
					state.indeterminate.value = false
					emit.toggle()
				},
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 26. Select & SelectOption — select trigger and its open listbox (kit/src/ui/Select.vue, SelectOption.vue)
// ---------------------------------------------------------------------------
/** What a `multiple` select shows for its chosen values: the Workbench's own select joins them with a comma and a space. */
function selectedText(value: unknown): string {
	if (Array.isArray(value)) return value.filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number').map(String).join(', ')
	return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

export interface SelectInterfaces {
	config: {
		raw: ({
			label?: string
			labelKey?: string
			hideLabel?: boolean
			help?: string
			helpKey?: string
			placeholder?: string
			placeholderKey?: string
			required?: boolean
			multiple?: boolean
			value?: string | number | ReadonlyArray<string | number>
			/** Locale key of the text the trigger shows (the lowered `$i18n` binding of `value`). */
			valueKey?: string
			invalid?: boolean
			disabled?: boolean
			open?: boolean
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			hideLabel: boolean
			help: string
			helpKey: string | null
			placeholder: string
			placeholderKey: string | null
			required: boolean
			multiple: boolean
			value: string
			valueKey: string
			invalid: boolean
			disabled: boolean
			open: boolean
		}
	}
	slots: 'options'
	state: {
		open: boolean
		value: string
		/** A Locale key: while set, the trigger shows its translation instead of `value`. */
		valueKey: string
		invalid: boolean
	}
	events: { toggle: readonly [] }
	properties: {
		valueResult: TranslationResult
		value: string
		labelResult: TranslationResult
		label: string
		helpResult: TranslationResult
		help: string
		placeholderResult: TranslationResult
		placeholder: string
		look: { required: boolean; multiple: boolean; disabled: boolean; hideLabel: boolean }
		theme: string
	}
}

export const selectPlugin = createWidgetPlugin('Select')
	.description('Select trigger with a translatable label, help and placeholder, the chosen value as literal text (a multiple select joins its values with a comma and a space), required, invalid and disabled flags, and an author-writable `open` state that shows its SelectOption children as a listbox panel. The trigger fires `toggle`.')
	.interfaces<SelectInterfaces>()
	.config({
		description: 'Select configuration. `label`, `help` and `placeholder` accept `$i18n` bindings (lowered to `labelKey`, `helpKey`, `placeholderKey`). `hideLabel` keeps the label for assistive technology only. `value` is the chosen value as shown: a literal string (or a list of strings for `multiple`), or an `$i18n` binding (lowered to `valueKey`) so the chosen label is translated. A Variant that sets the `valueKey` state to a Locale key localizes the chosen label too.',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' },
			hideLabel: { type: 'boolean' },
			help: { type: 'string' }, helpKey: { type: 'string' },
			placeholder: { type: 'string' }, placeholderKey: { type: 'string' },
			required: { type: 'boolean' },
			multiple: { type: 'boolean' },
			value: { type: ['string', 'number', 'array'], items: { type: ['string', 'number'] } },
			valueKey: { type: 'string' },
			invalid: { type: 'boolean' },
			disabled: { type: 'boolean' },
			open: { type: 'boolean' },
		}),
		validate: (c): c is SelectInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			hideLabel: Boolean(raw?.hideLabel),
			help: stringOr(raw?.help, ''),
			helpKey: optionalString(raw?.helpKey),
			placeholder: stringOr(raw?.placeholder, ''),
			placeholderKey: optionalString(raw?.placeholderKey),
			required: Boolean(raw?.required),
			multiple: Boolean(raw?.multiple),
			value: selectedText(raw?.value),
			valueKey: stringOr(raw?.valueKey, ''),
			invalid: Boolean(raw?.invalid),
			disabled: Boolean(raw?.disabled),
			open: Boolean(raw?.open),
		}),
	})
	.slots({ options: { description: 'SelectOption widgets, shown as the listbox panel while `open`' } })
	.state(state => state
		.open({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.open })
		.value({ authorWritable: true, validate: (v): v is string => typeof v === 'string', default: ({ config }) => config.value })
		.valueKey({ authorWritable: true, validate: (v): v is string => typeof v === 'string', default: ({ config }) => config.valueKey })
		.invalid({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.invalid }))
	.properties(p => p
		.valueResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: ({ dep }) => ({ ...translateDeps({ dep }), key: dep.self.state.get('valueKey') }),
			compute: ({ deps }) => translateStateKey(stringFromResult(deps.key()), (key, params) => deps.t(key, params)),
		})
		.value({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('valueResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.labelResult(translatedResult<SelectInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SelectInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.helpResult(translatedResult<SelectInterfaces['config']['resolved']>(c => ({ key: c.helpKey, literal: c.help })))
		.help(translatedText<SelectInterfaces['config']['resolved']>(c => ({ key: c.helpKey, literal: c.help })))
		.placeholderResult(translatedResult<SelectInterfaces['config']['resolved']>(c => ({ key: c.placeholderKey, literal: c.placeholder })))
		.placeholder(translatedText<SelectInterfaces['config']['resolved']>(c => ({ key: c.placeholderKey, literal: c.placeholder })))
		.look({ compute: ({ config }) => ({ required: config.required, multiple: config.multiple, disabled: config.disabled, hideLabel: config.hideLabel }) })
		.theme(themeProperty()),
	)
	.events(events => events.toggle({ description: 'Fired when the user presses the trigger to open or close the panel' }))
	.done()

export const SelectRenderer = defineComponent({
	name: 'SelectRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties, emit } = useWidget(selectPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h(KitSelect, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				id: `${widgetId}-select`,
				label: props.label.value || undefined,
				hideLabel: Boolean(look?.hideLabel),
				help: props.help.value || undefined,
				placeholder: props.placeholder.value || undefined,
				value: (state.valueKey.value ? props.value.value : state.value.value) || undefined,
				required: Boolean(look?.required),
				multiple: Boolean(look?.multiple),
				invalid: Boolean(state.invalid.value),
				disabled: Boolean(look?.disabled),
				open: Boolean(state.open.value),
				class: ['uiux-ref-scope', props.theme.value],
				onToggle: () => {
					if (look?.disabled) return
					state.open.value = !state.open.value
					emit.toggle()
				},
			}, { default: () => h(WidgetSlot, { name: 'options' }) })
		}
	},
})

export interface SelectOptionInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string; description?: string; descriptionKey?: string; mono?: boolean; selected?: boolean; disabled?: boolean }) | null
		resolved: { label: string; labelKey: string | null; description: string; descriptionKey: string | null; mono: boolean; selected: boolean; disabled: boolean }
	}
	state: { selected: boolean }
	events: { click: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		descriptionResult: TranslationResult
		description: string
		mono: boolean
		disabled: boolean
		theme: string
	}
}

export const selectOptionPlugin = createWidgetPlugin('SelectOption')
	.description('One option of a Select listbox: a translatable label (optionally mono, as an Event name is) with a translatable description line under it, a check while `selected`, and a `disabled` flag. A press fires `click`; the author-writable `selected` state drives Variants.')
	.interfaces<SelectOptionInterfaces>()
	.config({
		description: 'SelectOption configuration. `label` and `description` accept `$i18n` bindings (lowered to `labelKey`, `descriptionKey`). `mono` sets the label in mono text.',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' },
			description: { type: 'string' }, descriptionKey: { type: 'string' },
			mono: { type: 'boolean' },
			selected: { type: 'boolean' },
			disabled: { type: 'boolean' },
		}),
		validate: (c): c is SelectOptionInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			description: stringOr(raw?.description, ''),
			descriptionKey: optionalString(raw?.descriptionKey),
			mono: Boolean(raw?.mono),
			selected: Boolean(raw?.selected),
			disabled: Boolean(raw?.disabled),
		}),
	})
	.state(state => state.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected }))
	.properties(p => p
		.labelResult(translatedResult<SelectOptionInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<SelectOptionInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.descriptionResult(translatedResult<SelectOptionInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.description(translatedText<SelectOptionInterfaces['config']['resolved']>(c => ({ key: c.descriptionKey, literal: c.description })))
		.mono({ compute: ({ config }) => config.mono })
		.disabled({ compute: ({ config }) => config.disabled })
		.theme(themeProperty()),
	)
	.events(events => events.click({ description: 'Fired when an enabled option is pressed' }))
	.done()

export const SelectOptionRenderer = defineComponent({
	name: 'SelectOptionRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(selectOptionPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => h(KitSelectOption, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			label: props.label.value ?? '',
			description: props.description.value || undefined,
			mono: Boolean(props.mono.value),
			selected: Boolean(state.selected.value),
			disabled: Boolean(props.disabled.value),
			class: ['uiux-ref-scope', props.theme.value],
			onClick: () => {
				if (!props.disabled.value) emit.click()
			},
		})
	},
})

// ---------------------------------------------------------------------------
// 27. Disclosure — header button that shows or hides its content (kit/src/ui/Disclosure.vue)
// ---------------------------------------------------------------------------
export interface DisclosureInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string; value?: string | number; value2?: string | number; value3?: string | number; valueCode?: boolean; meta?: string | number; open?: boolean; icon?: string; chevron?: 'start' | 'end'; appearance?: 'row' | 'link' }) | null
		resolved: InterpolationArgs & { label: string; labelKey: string | null; valueCode: boolean; meta: string; open: boolean; icon: string; chevron: 'start' | 'end'; appearance: 'row' | 'link' }
	}
	slots: 'content'
	state: { open: boolean }
	events: { toggle: readonly [] }
	properties: {
		valueText: string
		value2Text: string
		value3Text: string
		labelResult: TranslationResult
		label: string
		meta: string
		labelRuns: readonly TextRun[]
		look: { icon: string; chevron: 'start' | 'end'; appearance: 'row' | 'link' }
		theme: string
	}
}

export const disclosurePlugin = createWidgetPlugin('Disclosure')
	.description('Disclosure: a header button with a chevron (before the label, or after it with `chevron: "end"`), an optional leading icon, a translatable label that may interpolate `{value}`, and a literal trailing `meta` (a count or a status), above a `content` slot. `appearance: "link"` is the link-style toggle. The author-writable `open` state shows the content; the header press writes it and fires `toggle`.')
	.interfaces<DisclosureInterfaces>()
	.config({
		description: 'Disclosure configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`); `{value}`, `{value2}` and `{value3}` interpolate `value`, `value2` and `value3` (`{value}` as inline code with `valueCode`). `meta` is literal text such as a count. `icon` takes a Lucide name. `chevron` is `start` (default) or `end`; `appearance` is `row` (full width, default) or `link`.',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			value2: { type: ['string', 'number'] },
			value3: { type: ['string', 'number'] },
			valueCode: { type: 'boolean' },
			meta: { type: ['string', 'number'] },
			open: { type: 'boolean' },
			icon: { type: 'string' },
			chevron: { enum: ['start', 'end'] },
			appearance: { enum: ['row', 'link'] },
		}),
		validate: (c): c is DisclosureInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			...interpolationArgs(raw),
			valueCode: Boolean(raw?.valueCode),
			meta: raw?.meta === undefined ? '' : String(raw.meta),
			open: Boolean(raw?.open),
			icon: stringOr(raw?.icon, ''),
			chevron: oneOf(raw?.chevron, ['start', 'end'] as const, 'start'),
			appearance: oneOf(raw?.appearance, ['row', 'link'] as const, 'row'),
		}),
	})
	.slots({ content: { description: 'The content the header shows or hides' } })
	.state(state => state.open({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.open }))
	.properties(p => p
		.valueText({ valueContract: STRING, compute: ({ config }) => config.value })
		.value2Text({ valueContract: STRING, compute: ({ config }) => config.value2 })
		.value3Text({ valueContract: STRING, compute: ({ config }) => config.value3 })
		.labelResult(translatedResultWithValue<DisclosureInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedTextWithValue<DisclosureInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.meta({ compute: ({ config }) => config.meta })
		.labelRuns(textRunsOf<DisclosureInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.look({ compute: ({ config }) => ({ icon: config.icon, chevron: config.chevron, appearance: config.appearance }) })
		.theme(themeProperty()),
	)
	.events(events => events.toggle({ description: 'Fired when the header is pressed to open or close the content' }))
	.done()

export const DisclosureRenderer = defineComponent({
	name: 'DisclosureRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties, emit } = useWidget(disclosurePlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => h(KitDisclosure, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			label: props.label.value ?? '',
			meta: props.meta.value || undefined,
			open: Boolean(state.open.value),
			icon: props.look.value?.icon || undefined,
			chevron: props.look.value?.chevron,
			appearance: props.look.value?.appearance,
			class: ['uiux-ref-scope', props.theme.value],
			onToggle: () => {
				state.open.value = !state.open.value
				emit.toggle()
			},
		}, {
			default: () => h(WidgetSlot, { name: 'content' }),
			...(props.labelRuns.value?.some(run => run.code) ? { label: () => runNodes(props.labelRuns.value, props.label.value ?? '') } : {}),
		})
	},
})

// ---------------------------------------------------------------------------
// 28. CodeBlock — literal mono text (kit/src/ui/CodeBlock.vue)
// ---------------------------------------------------------------------------
export interface CodeBlockInterfaces {
	config: {
		raw: ({ code?: string; maxHeight?: number | string; wrap?: boolean; label?: string; labelKey?: string }) | null
		resolved: { code: string; maxHeight: number | string | undefined; wrap: boolean; label: string; labelKey: string | null }
	}
	properties: {
		labelResult: TranslationResult
		label: string
		look: { code: string; maxHeight: number | string | undefined; wrap: boolean }
		theme: string
	}
}

export const codeBlockPlugin = createWidgetPlugin('CodeBlock')
	.description('Literal text in the mono face (JSON, a diff, a log), shown exactly as authored and never translated. A long line scrolls sideways or wraps; `maxHeight` bounds the block, which then scrolls and is focusable. With a `label` it is a named region.')
	.interfaces<CodeBlockInterfaces>()
	.config({
		description: 'CodeBlock configuration. `code` is literal. `maxHeight` is px as a number or any CSS length. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			code: { type: 'string' },
			maxHeight: { type: ['number', 'string'] },
			wrap: { type: 'boolean' },
			label: { type: 'string' }, labelKey: { type: 'string' },
		}),
		validate: (c): c is CodeBlockInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			code: stringOr(raw?.code, ''),
			maxHeight: lengthOr(raw?.maxHeight),
			wrap: Boolean(raw?.wrap),
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
		}),
	})
	.properties(p => p
		.labelResult(translatedResult<CodeBlockInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<CodeBlockInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.look({ compute: ({ config }) => ({ code: config.code, maxHeight: config.maxHeight, wrap: config.wrap }) })
		.theme(themeProperty()),
	)
	.done()

export const CodeBlockRenderer = defineComponent({
	name: 'CodeBlockRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(codeBlockPlugin)
		const props = useProperties()
		return (): VNode => h(KitCodeBlock, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			code: props.look.value?.code ?? '',
			maxHeight: props.look.value?.maxHeight,
			wrap: Boolean(props.look.value?.wrap),
			label: props.label.value || undefined,
			class: ['uiux-ref-scope', props.theme.value],
		})
	},
})

// ---------------------------------------------------------------------------
// 29. Table & TableRow — a column grid of rows whose cells are other Widgets (kit/src/ui/Table.vue, TableRow.vue)
// ---------------------------------------------------------------------------
export interface TableInterfaces {
	config: {
		raw: ({ columns?: string; minWidth?: string; label?: string; labelKey?: string }) | null
		resolved: { columns: string; minWidth: string; label: string; labelKey: string | null }
	}
	slots: 'rows'
	properties: {
		labelResult: TranslationResult
		label: string
		columns: string
		minWidth: string
		theme: string
	}
}

export const tablePlugin = createWidgetPlugin('Table')
	.description('Column grid for TableRow widgets: `columns` is the CSS grid template every row follows, so cells line up, and `minWidth` is the width below which the table scrolls sideways. Cells are other Widgets, so it is exposed as a named list of rows.')
	.interfaces<TableInterfaces>()
	.config({
		description: 'Table configuration. `columns` is a CSS `grid-template-columns` value such as `2fr 1fr 80px`. `minWidth` is a CSS length (such as `640px`) every row keeps at least, so a narrower container scrolls the table sideways. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			columns: { type: 'string' },
			minWidth: { type: 'string' },
			label: { type: 'string' }, labelKey: { type: 'string' },
		}),
		validate: (c): c is TableInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({ columns: stringOr(raw?.columns, ''), minWidth: stringOr(raw?.minWidth, ''), label: stringOr(raw?.label, ''), labelKey: optionalString(raw?.labelKey) }),
	})
	.slots({ rows: { description: 'TableRow widgets' } })
	.properties(p => p
		.labelResult(translatedResult<TableInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<TableInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.columns({ compute: ({ config }) => config.columns })
		.minWidth({ compute: ({ config }) => config.minWidth })
		.theme(themeProperty()),
	)
	.done()

export const TableRenderer = defineComponent({
	name: 'TableRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(tablePlugin)
		const props = useProperties()
		return (): VNode => h(KitTable, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			columns: props.columns.value || undefined,
			minWidth: props.minWidth.value || undefined,
			label: props.label.value || undefined,
			class: ['uiux-ref-scope', props.theme.value],
		}, { default: () => h(WidgetSlot, { name: 'rows' }) })
	},
})

export interface TableRowInterfaces {
	config: {
		raw: ({ header?: boolean; selected?: boolean; visible?: boolean; align?: 'center' | 'start' }) | null
		resolved: { header: boolean; selected: boolean; visible: boolean; align: 'center' | 'start' }
	}
	slots: 'cells'
	state: { selected: boolean; visible: boolean }
	properties: {
		header: boolean
		align: 'center' | 'start'
		theme: string
	}
}

export const tableRowPlugin = createWidgetPlugin('TableRow')
	.description('One row of a Table: its `cells` slot holds the cell Widgets, laid out on the table\'s column grid. `header` styles it as the column headings; `align: "start"` top-aligns the cells of a tall row; the author-writable `selected` and `visible` states mark the current row and show or hide it.')
	.interfaces<TableRowInterfaces>()
	.config({
		description: 'TableRow configuration. `align` is `center` (default) or `start`.',
		schema: configSchema({ header: { type: 'boolean' }, selected: { type: 'boolean' }, visible: { type: 'boolean' }, align: { enum: ['center', 'start'] } }),
		validate: (c): c is TableRowInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({ header: Boolean(raw?.header), selected: Boolean(raw?.selected), visible: raw?.visible === undefined ? true : Boolean(raw.visible), align: oneOf(raw?.align, ['center', 'start'] as const, 'center') }),
	})
	.slots({ cells: { description: 'The cell widgets, one per column' } })
	.state(state => state
		.selected({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.selected })
		.visible({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.visible }))
	.properties(p => p
		.header({ compute: ({ config }) => config.header })
		.align({ compute: ({ config }) => config.align })
		.theme(themeProperty()),
	)
	.done()

export const TableRowRenderer = defineComponent({
	name: 'TableRowRenderer',
	setup() {
		const { widgetId, WidgetSlot, useState, useProperties } = useWidget(tableRowPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => h(KitTableRow, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			header: Boolean(props.header.value),
			selected: Boolean(state.selected.value),
			align: props.align.value ?? undefined,
			class: ['uiux-ref-scope', props.theme.value, state.visible.value ? '' : 'uiux-ref-hidden'],
		}, { default: () => h(WidgetSlot, { name: 'cells' }) })
	},
})

// ---------------------------------------------------------------------------
// 30. DiffItem — one change of a semantic diff (kit/src/ui/DiffItem.vue)
// ---------------------------------------------------------------------------
type DiffOp = 'added' | 'removed' | 'changed' | 'moved'
const DIFF_OPS: readonly DiffOp[] = ['added', 'removed', 'changed', 'moved']
type DiffChange = { label?: string; before?: string; after?: string; opLabel?: string }

function diffChanges(value: unknown): DiffChange[] {
	if (!Array.isArray(value)) return []
	return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)).map((entry) => {
		const change: DiffChange = {}
		for (const key of ['label', 'before', 'after', 'opLabel'] as const) {
			if (typeof entry[key] === 'string') change[key] = entry[key]
		}
		return change
	})
}

export interface DiffItemInterfaces {
	config: {
		raw: ({
			op?: DiffOp
			opLabel?: string
			opLabelKey?: string
			field?: string
			fieldKey?: string
			label?: string
			before?: string
			after?: string
			changes?: DiffChange[]
		}) | null
		resolved: {
			op: DiffOp
			opLabel: string
			opLabelKey: string | null
			field: string
			fieldKey: string | null
			label: string
			before: string | undefined
			after: string | undefined
			changes: DiffChange[]
		}
	}
	properties: {
		opLabelResult: TranslationResult
		opLabel: string
		fieldResult: TranslationResult
		field: string
		look: { op: DiffOp; label: string; before: string | undefined; after: string | undefined; changes: DiffChange[] }
		theme: string
	}
}

export const diffItemPlugin = createWidgetPlugin('DiffItem')
	.description('One change of a semantic diff: an operation (added, removed, changed or moved) with its icon, tone and translated words, the translated field name, the changed thing as literal mono text, a struck `before` and inserted `after` value, and a list of finer `changes`. Values are content and are never translated.')
	.interfaces<DiffItemInterfaces>()
	.config({
		description: 'DiffItem configuration. `opLabel` and `field` accept `$i18n` bindings (lowered to `opLabelKey`, `fieldKey`). `label`, `before`, `after` and `changes[]` are literal.',
		schema: configSchema({
			op: { enum: [...DIFF_OPS] },
			opLabel: { type: 'string' }, opLabelKey: { type: 'string' },
			field: { type: 'string' }, fieldKey: { type: 'string' },
			label: { type: 'string' },
			before: { type: 'string' },
			after: { type: 'string' },
			changes: {
				type: 'array',
				items: {
					type: 'object',
					properties: { label: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, opLabel: { type: 'string' } },
				},
			},
		}),
		validate: (c): c is DiffItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			op: oneOf(raw?.op, DIFF_OPS, 'changed'),
			opLabel: stringOr(raw?.opLabel, ''),
			opLabelKey: optionalString(raw?.opLabelKey),
			field: stringOr(raw?.field, ''),
			fieldKey: optionalString(raw?.fieldKey),
			label: stringOr(raw?.label, ''),
			before: typeof raw?.before === 'string' ? raw.before : undefined,
			after: typeof raw?.after === 'string' ? raw.after : undefined,
			changes: diffChanges(raw?.changes),
		}),
	})
	.properties(p => p
		.opLabelResult(translatedResult<DiffItemInterfaces['config']['resolved']>(c => ({ key: c.opLabelKey, literal: c.opLabel })))
		.opLabel(translatedText<DiffItemInterfaces['config']['resolved']>(c => ({ key: c.opLabelKey, literal: c.opLabel })))
		.fieldResult(translatedResult<DiffItemInterfaces['config']['resolved']>(c => ({ key: c.fieldKey, literal: c.field })))
		.field(translatedText<DiffItemInterfaces['config']['resolved']>(c => ({ key: c.fieldKey, literal: c.field })))
		.look({ compute: ({ config }) => ({ op: config.op, label: config.label, before: config.before, after: config.after, changes: config.changes }) })
		.theme(themeProperty()),
	)
	.done()

export const DiffItemRenderer = defineComponent({
	name: 'DiffItemRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(diffItemPlugin)
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			return h(KitDiffItem, {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				op: look?.op ?? 'changed',
				opLabel: props.opLabel.value || undefined,
				field: props.field.value || undefined,
				label: look?.label || undefined,
				before: look?.before,
				after: look?.after,
				changes: look?.changes?.length ? look.changes : undefined,
				class: ['uiux-ref-scope', props.theme.value],
			})
		}
	},
})

// ---------------------------------------------------------------------------
// 31. Breadcrumb & BreadcrumbItem — a path of steps (kit/src/ui/Breadcrumb.vue, BreadcrumbItem.vue)
// ---------------------------------------------------------------------------
export interface BreadcrumbInterfaces {
	config: {
		raw: ({ label?: string; labelKey?: string }) | null
		resolved: { label: string; labelKey: string | null }
	}
	slots: 'items'
	properties: {
		labelResult: TranslationResult
		label: string
		theme: string
	}
}

export const breadcrumbPlugin = createWidgetPlugin('Breadcrumb')
	.description('A path of steps in a named navigation landmark, one BreadcrumbItem per step. A long path scrolls sideways, so the landmark itself is the focusable scroller.')
	.interfaces<BreadcrumbInterfaces>()
	.config({
		description: 'Breadcrumb configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`) and names the landmark.',
		schema: configSchema({ label: { type: 'string' }, labelKey: { type: 'string' } }),
		validate: (c): c is BreadcrumbInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({ label: stringOr(raw?.label, ''), labelKey: optionalString(raw?.labelKey) }),
	})
	.slots({ items: { description: 'BreadcrumbItem widgets' } })
	.properties(p => p
		.labelResult(translatedResult<BreadcrumbInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<BreadcrumbInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.theme(themeProperty()),
	)
	.done()

export const BreadcrumbRenderer = defineComponent({
	name: 'BreadcrumbRenderer',
	setup() {
		const { widgetId, WidgetSlot, useProperties } = useWidget(breadcrumbPlugin)
		const props = useProperties()
		return (): VNode => h(KitBreadcrumb, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			label: props.label.value || undefined,
			class: ['uiux-ref-scope', props.theme.value],
		}, { default: () => h(WidgetSlot, { name: 'items' }) })
	},
})

export interface BreadcrumbItemInterfaces {
	config: {
		raw: ({
			index?: number | string
			label?: string
			labelKey?: string
			variant?: string
			variantKey?: string
			trailing?: string
			trailingKey?: string
			icon?: string
			current?: boolean
		}) | null
		resolved: {
			index: string
			label: string
			labelKey: string | null
			variant: string
			variantKey: string | null
			trailing: string
			trailingKey: string | null
			icon: string
			current: boolean
		}
	}
	state: { current: boolean }
	properties: {
		labelResult: TranslationResult
		label: string
		variantResult: TranslationResult
		variant: string
		trailingResult: TranslationResult
		trailing: string
		look: { index: string; icon: string }
		theme: string
	}
}

export const breadcrumbItemPlugin = createWidgetPlugin('BreadcrumbItem')
	.description('One step of a Breadcrumb: its number, a variant (the state the step shows), a label (what it belongs to), a trailing note and an optional Lucide icon. The author-writable `current` state marks the step the path ends on (`aria-current="step"`).')
	.interfaces<BreadcrumbItemInterfaces>()
	.config({
		description: 'BreadcrumbItem configuration. `label`, `variant` and `trailing` accept `$i18n` bindings (lowered to `labelKey`, `variantKey`, `trailingKey`) and otherwise show as written.',
		schema: configSchema({
			index: { type: ['number', 'string'] },
			label: { type: 'string' }, labelKey: { type: 'string' },
			variant: { type: 'string' }, variantKey: { type: 'string' },
			trailing: { type: 'string' }, trailingKey: { type: 'string' },
			icon: { type: 'string' },
			current: { type: 'boolean' },
		}),
		validate: (c): c is BreadcrumbItemInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			index: raw?.index === undefined ? '' : String(raw.index),
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			variant: stringOr(raw?.variant, ''),
			variantKey: optionalString(raw?.variantKey),
			trailing: stringOr(raw?.trailing, ''),
			trailingKey: optionalString(raw?.trailingKey),
			icon: stringOr(raw?.icon, ''),
			current: Boolean(raw?.current),
		}),
	})
	.state(state => state.current({ authorWritable: true, validate: isBoolean, default: ({ config }) => config.current }))
	.properties(p => p
		.labelResult(translatedResult<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.labelKey, literal: c.label })))
		.variantResult(translatedResult<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.variantKey, literal: c.variant })))
		.variant(translatedText<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.variantKey, literal: c.variant })))
		.trailingResult(translatedResult<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.trailingKey, literal: c.trailing })))
		.trailing(translatedText<BreadcrumbItemInterfaces['config']['resolved']>(c => ({ key: c.trailingKey, literal: c.trailing })))
		.look({ compute: ({ config }) => ({ index: config.index, icon: config.icon }) })
		.theme(themeProperty()),
	)
	.done()

export const BreadcrumbItemRenderer = defineComponent({
	name: 'BreadcrumbItemRenderer',
	setup() {
		const { widgetId, useState, useProperties } = useWidget(breadcrumbItemPlugin)
		const state = useState()
		const props = useProperties()
		return (): VNode => h(KitBreadcrumbItem, {
			[WIDGET_ID_ATTRIBUTE]: widgetId,
			index: props.look.value?.index || undefined,
			label: props.label.value || undefined,
			variant: props.variant.value || undefined,
			trailing: props.trailing.value || undefined,
			icon: props.look.value?.icon || undefined,
			current: Boolean(state.current.value),
			class: ['uiux-ref-scope', props.theme.value],
		})
	},
})

// ---------------------------------------------------------------------------
// 32. GraphCanvas — a static projection of a node-and-edge graph, drawn like the Workbench's Flow graph
// ---------------------------------------------------------------------------
// Adapter only: no Kit component. Nodes sit on an explicit column and row grid, edges are routed the way
// the Workbench's UX Flow graph routes them (forward edges leave a node's right side, back edges arc
// below, a self-loop arcs above), and the nodes and edge labels are buttons. A node or an edge label
// writes the `selection` state and fires `select`.
const GRAPH_NODE_WIDTH = 216
const GRAPH_NODE_HEIGHT = 76
const GRAPH_COLUMN_GAP = 192
const GRAPH_ROW_GAP = 48
const GRAPH_PADDING = 48
/** Room above the first row for self-loops and their labels. */
const GRAPH_PADDING_TOP = 88

type GraphNodeRaw = { key?: string; label?: string; variantName?: string; entry?: boolean; terminal?: boolean; unreachable?: boolean; problems?: number; col?: number; row?: number }
type GraphEdgeRaw = { from?: string; to?: string; trigger?: string; tone?: 'default' | 'problem' }
type GraphNodeConfig = {
	key: string
	label: string
	variantName: string
	entry: boolean
	terminal: boolean
	unreachable: boolean
	problems: number
	col: number
	row: number
}
type GraphEdgeConfig = { from: string; to: string; trigger: string; tone: 'default' | 'problem' }
type GraphPlacedNode = GraphNodeConfig & { x: number; y: number }
type GraphRoutedEdge = GraphEdgeConfig & { index: number; path: string; labelX: number; labelY: number; dangling: boolean }
type GraphLayout = { width: number; height: number; nodes: GraphPlacedNode[]; edges: GraphRoutedEdge[] }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegative(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function graphNodes(value: unknown): GraphNodeConfig[] {
	if (!Array.isArray(value)) return []
	const seen = new Set<string>()
	const nodes: GraphNodeConfig[] = []
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key === '' || seen.has(entry.key)) continue
		seen.add(entry.key)
		nodes.push({
			key: entry.key,
			label: typeof entry.label === 'string' ? entry.label : entry.key,
			variantName: stringOr(entry.variantName, ''),
			entry: Boolean(entry.entry),
			terminal: Boolean(entry.terminal),
			unreachable: Boolean(entry.unreachable),
			problems: Math.floor(nonNegative(entry.problems)),
			col: Math.floor(nonNegative(entry.col)),
			row: nonNegative(entry.row),
		})
	}
	return nodes
}

function graphEdges(value: unknown): GraphEdgeConfig[] {
	if (!Array.isArray(value)) return []
	const edges: GraphEdgeConfig[] = []
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') continue
		edges.push({ from: entry.from, to: entry.to, trigger: stringOr(entry.trigger, ''), tone: entry.tone === 'problem' ? 'problem' : 'default' })
	}
	return edges
}

type GraphPoint = { x: number; y: number }
function cubicMidpoint(p0: GraphPoint, p1: GraphPoint, p2: GraphPoint, p3: GraphPoint): GraphPoint {
	return { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 }
}

/** The route of one edge, as the Workbench's Flow graph draws it. `lane` spreads parallel edges between one pair of nodes. */
function routeGraphEdge(source: GraphPlacedNode, target: GraphPlacedNode | undefined, lane: number): { path: string; label: GraphPoint; dangling: boolean } {
	const spread = lane * 22
	if (!target) {
		const start = { x: source.x + GRAPH_NODE_WIDTH, y: source.y + GRAPH_NODE_HEIGHT / 2 + spread }
		const end = { x: start.x + 72, y: start.y }
		return { path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, label: { x: start.x + 36, y: start.y - 14 }, dangling: true }
	}
	if (source.key === target.key) {
		const left = source.x + GRAPH_NODE_WIDTH * 0.62 - spread
		const right = source.x + GRAPH_NODE_WIDTH * 0.86
		const top = source.y
		const lift = 44 + spread
		return { path: `M ${left} ${top} C ${left} ${top - lift}, ${right} ${top - lift}, ${right} ${top}`, label: { x: (left + right) / 2, y: top - lift * 0.75 - 10 }, dangling: false }
	}
	if (target.col > source.col) {
		const start = { x: source.x + GRAPH_NODE_WIDTH, y: source.y + GRAPH_NODE_HEIGHT / 2 }
		const end = { x: target.x, y: target.y + GRAPH_NODE_HEIGHT / 2 }
		const bend = Math.max(48, (end.x - start.x) / 2)
		const c1 = { x: start.x + bend, y: start.y + spread }
		const c2 = { x: end.x - bend, y: end.y + spread }
		return { path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, label: cubicMidpoint(start, c1, c2, end), dangling: false }
	}
	const start = { x: source.x + GRAPH_NODE_WIDTH / 2 - 16, y: source.y + GRAPH_NODE_HEIGHT }
	const end = { x: target.x + GRAPH_NODE_WIDTH / 2 + 16, y: target.y + GRAPH_NODE_HEIGHT }
	const drop = 52 + spread + Math.abs(source.row - target.row) * 8
	const bottom = Math.max(start.y, end.y) + drop
	const c1 = { x: start.x, y: bottom }
	const c2 = { x: end.x, y: bottom }
	return { path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, label: cubicMidpoint(start, c1, c2, end), dangling: false }
}

function layoutGraph(nodes: readonly GraphNodeConfig[], edges: readonly GraphEdgeConfig[]): GraphLayout {
	const placed: GraphPlacedNode[] = nodes.map(node => ({
		...node,
		x: GRAPH_PADDING + node.col * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
		y: GRAPH_PADDING_TOP + node.row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
	}))
	const byKey = new Map(placed.map(node => [node.key, node]))
	const lanes = new Map<string, number>()
	const routed: GraphRoutedEdge[] = []
	edges.forEach((edge, index) => {
		const source = byKey.get(edge.from)
		if (!source) return
		const target = byKey.get(edge.to)
		const pair = `${edge.from}>${target ? edge.to : '?'}`
		const lane = lanes.get(pair) ?? 0
		lanes.set(pair, lane + 1)
		const route = routeGraphEdge(source, target, lane)
		routed.push({ ...edge, index, path: route.path, labelX: route.label.x, labelY: route.label.y, dangling: route.dangling })
	})
	const columns = Math.max(1, ...placed.map(node => node.col + 1))
	const bottom = Math.max(GRAPH_PADDING_TOP + GRAPH_NODE_HEIGHT, ...placed.map(node => node.y + GRAPH_NODE_HEIGHT))
	return {
		width: GRAPH_PADDING * 2 + columns * GRAPH_NODE_WIDTH + (columns - 1) * GRAPH_COLUMN_GAP,
		// Room below the lowest row for routed back edges and their labels.
		height: bottom + GRAPH_PADDING + 56,
		nodes: placed,
		edges: routed,
	}
}

export interface GraphCanvasInterfaces {
	config: {
		raw: ({
			label?: string
			labelKey?: string
			entryLabel?: string
			entryLabelKey?: string
			endLabel?: string
			endLabelKey?: string
			unreachableLabel?: string
			unreachableLabelKey?: string
			baseLabel?: string
			baseLabelKey?: string
			problemsLabel?: string
			problemsLabelKey?: string
			nodes?: GraphNodeRaw[]
			edges?: GraphEdgeRaw[]
			selection?: string
			/** The canvas grows to fill the space its parent leaves and centers the graph in it, dot ground included. */
			fill?: boolean
		}) | null
		resolved: {
			label: string
			labelKey: string | null
			entryLabel: string
			entryLabelKey: string | null
			endLabel: string
			endLabelKey: string | null
			unreachableLabel: string
			unreachableLabelKey: string | null
			baseLabel: string
			baseLabelKey: string | null
			problemsLabel: string
			problemsLabelKey: string | null
			nodes: GraphNodeConfig[]
			edges: GraphEdgeConfig[]
			selection: string
			fill: boolean
		}
	}
	state: { selection: string }
	events: { select: readonly [] }
	properties: {
		labelResult: TranslationResult
		label: string
		entryLabelResult: TranslationResult
		entryLabel: string
		endLabelResult: TranslationResult
		endLabel: string
		unreachableLabelResult: TranslationResult
		unreachableLabel: string
		baseLabelResult: TranslationResult
		baseLabel: string
		problemsLabelResult: TranslationResult
		problemsLabel: string
		graph: GraphLayout
		fill: boolean
		theme: string
	}
}

type GraphResolved = GraphCanvasInterfaces['config']['resolved']

export const graphCanvasPlugin = createWidgetPlugin('GraphCanvas')
	.description('A static projection of a node-and-edge graph on the canvas ground, drawn like the Workbench\'s UX Flow graph: nodes on an explicit column and row grid with an entry flag, a variant chip, a problem count and an end or unreachable mark, and routed edges with mono trigger labels. A node or an edge label writes the `selection` state and fires `select`; arrow keys travel along edges.')
	.interfaces<GraphCanvasInterfaces>()
	.config({
		description: 'GraphCanvas configuration. `nodes` are `{ key, label, variantName, entry, terminal, unreachable, problems, col, row }` (literal; `row` may be fractional), `edges` are `{ from, to, trigger, tone }` over node keys (`tone` is `default` or `problem`). The chrome words `label`, `entryLabel`, `endLabel`, `unreachableLabel`, `baseLabel` and `problemsLabel` accept `$i18n` bindings (lowered to `<field>Key`). `selection` is a node key, or `edge:<index>` for an edge.',
		schema: configSchema({
			label: { type: 'string' }, labelKey: { type: 'string' },
			entryLabel: { type: 'string' }, entryLabelKey: { type: 'string' },
			endLabel: { type: 'string' }, endLabelKey: { type: 'string' },
			unreachableLabel: { type: 'string' }, unreachableLabelKey: { type: 'string' },
			baseLabel: { type: 'string' }, baseLabelKey: { type: 'string' },
			problemsLabel: { type: 'string' }, problemsLabelKey: { type: 'string' },
			nodes: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						key: { type: 'string' },
						label: { type: 'string' },
						variantName: { type: 'string' },
						entry: { type: 'boolean' },
						terminal: { type: 'boolean' },
						unreachable: { type: 'boolean' },
						problems: { type: 'number' },
						col: { type: 'number' },
						row: { type: 'number' },
					},
				},
			},
			edges: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						from: { type: 'string' },
						to: { type: 'string' },
						trigger: { type: 'string' },
						tone: { enum: ['default', 'problem'] },
					},
				},
			},
			selection: { type: 'string' },
			fill: { type: 'boolean' },
		}),
		validate: (c): c is GraphCanvasInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			label: stringOr(raw?.label, ''),
			labelKey: optionalString(raw?.labelKey),
			entryLabel: stringOr(raw?.entryLabel, 'Entry'),
			entryLabelKey: optionalString(raw?.entryLabelKey),
			endLabel: stringOr(raw?.endLabel, 'End'),
			endLabelKey: optionalString(raw?.endLabelKey),
			unreachableLabel: stringOr(raw?.unreachableLabel, 'Unreachable'),
			unreachableLabelKey: optionalString(raw?.unreachableLabelKey),
			baseLabel: stringOr(raw?.baseLabel, 'Base'),
			baseLabelKey: optionalString(raw?.baseLabelKey),
			problemsLabel: stringOr(raw?.problemsLabel, 'Problems'),
			problemsLabelKey: optionalString(raw?.problemsLabelKey),
			nodes: graphNodes(raw?.nodes),
			edges: graphEdges(raw?.edges),
			selection: stringOr(raw?.selection, ''),
			fill: Boolean(raw?.fill),
		}),
	})
	.state(state => state.selection({ authorWritable: true, validate: (v): v is string => typeof v === 'string', default: ({ config }) => config.selection }))
	.properties(p => p
		.labelResult(translatedResult<GraphResolved>(c => ({ key: c.labelKey, literal: c.label })))
		.label(translatedText<GraphResolved>(c => ({ key: c.labelKey, literal: c.label })))
		.entryLabelResult(translatedResult<GraphResolved>(c => ({ key: c.entryLabelKey, literal: c.entryLabel })))
		.entryLabel(translatedText<GraphResolved>(c => ({ key: c.entryLabelKey, literal: c.entryLabel })))
		.endLabelResult(translatedResult<GraphResolved>(c => ({ key: c.endLabelKey, literal: c.endLabel })))
		.endLabel(translatedText<GraphResolved>(c => ({ key: c.endLabelKey, literal: c.endLabel })))
		.unreachableLabelResult(translatedResult<GraphResolved>(c => ({ key: c.unreachableLabelKey, literal: c.unreachableLabel })))
		.unreachableLabel(translatedText<GraphResolved>(c => ({ key: c.unreachableLabelKey, literal: c.unreachableLabel })))
		.baseLabelResult(translatedResult<GraphResolved>(c => ({ key: c.baseLabelKey, literal: c.baseLabel })))
		.baseLabel(translatedText<GraphResolved>(c => ({ key: c.baseLabelKey, literal: c.baseLabel })))
		.problemsLabelResult(translatedResult<GraphResolved>(c => ({ key: c.problemsLabelKey, literal: c.problemsLabel })))
		.problemsLabel(translatedText<GraphResolved>(c => ({ key: c.problemsLabelKey, literal: c.problemsLabel })))
		.graph({ compute: ({ config }) => layoutGraph(config.nodes, config.edges) })
		.fill({ compute: ({ config }) => config.fill })
		.theme(themeProperty()),
	)
	.events(events => events.select({ description: 'Fired when a node or an edge label is chosen' }))
	.done()

export const GraphCanvasRenderer = defineComponent({
	name: 'GraphCanvasRenderer',
	setup() {
		const { widgetId, useState, useProperties, emit } = useWidget(graphCanvasPlugin)
		const state = useState()
		const props = useProperties()

		function choose(selection: string): void {
			state.selection.value = selection
			emit.select()
		}

		/** The connected node for keyboard travel along edges, or the node above or below in the same column. */
		function neighbour(graph: GraphLayout, key: string, direction: 'next' | 'previous' | 'up' | 'down'): string | undefined {
			const node = graph.nodes.find(item => item.key === key)
			if (!node) return undefined
			if (direction === 'next') return graph.edges.find(edge => edge.from === key && !edge.dangling && edge.to !== key)?.to
			if (direction === 'previous') return graph.edges.find(edge => edge.to === key && edge.from !== key)?.from
			const column = graph.nodes.filter(item => item.col === node.col).sort((a, b) => a.row - b.row)
			return column[column.findIndex(item => item.key === key) + (direction === 'down' ? 1 : -1)]?.key
		}

		function onNodeKeydown(event: KeyboardEvent, graph: GraphLayout, key: string): void {
			if (event.altKey || event.metaKey || event.ctrlKey) return
			let next: string | undefined
			switch (event.key) {
				case 'ArrowRight': next = neighbour(graph, key, 'next'); break
				case 'ArrowLeft': next = neighbour(graph, key, 'previous'); break
				case 'ArrowDown': next = neighbour(graph, key, 'down'); break
				case 'ArrowUp': next = neighbour(graph, key, 'up'); break
				case 'Home': next = graph.nodes[0]?.key; break
				case 'End': next = graph.nodes[graph.nodes.length - 1]?.key; break
				case 'Escape':
					if (!state.selection.value) return
					event.preventDefault()
					state.selection.value = ''
					emit.select()
					return
				default: return
			}
			event.preventDefault()
			if (next === undefined) return
			const surface = (event.currentTarget as HTMLElement).parentElement
			const target = next
			choose(target)
			// The newly chosen node takes the one tab stop and the focus once it has rendered.
			setTimeout(() => Array.from(surface?.querySelectorAll<HTMLElement>('[data-graph-node]') ?? []).find(button => button.getAttribute('data-graph-node') === target)?.focus())
		}

		return (): VNode => {
			const graph = props.graph.value ?? { width: 0, height: 0, nodes: [], edges: [] }
			const selection = state.selection.value ?? ''
			const nodeByKey = new Map(graph.nodes.map(node => [node.key, node]))
			const tabStop = nodeByKey.has(selection) ? selection : graph.nodes[0]?.key
			const arrow = (tone: string) => `${widgetId}-arrow-${tone}`
			const edgeTone = (edge: GraphRoutedEdge) => selection === `edge:${edge.index}` ? 'selected' : edge.tone === 'problem' ? 'problem' : 'rest'

			const nodeLabel = (node: GraphPlacedNode): string => {
				const parts = [node.label, node.variantName || (props.baseLabel.value ?? '')]
				if (node.entry) parts.push(props.entryLabel.value ?? '')
				if (node.unreachable) parts.push(props.unreachableLabel.value ?? '')
				else if (node.terminal) parts.push(props.endLabel.value ?? '')
				if (node.problems) parts.push(`${props.problemsLabel.value ?? ''} ${node.problems}`.trim())
				return parts.filter(Boolean).join(', ')
			}
			const edgeLabel = (edge: GraphRoutedEdge): string => {
				const target = nodeByKey.get(edge.to)
				return `${edge.trigger} → ${target ? target.label : edge.to}`
			}

			return h('div', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: ['uiux-ref-scope', 'uiux-ref-graph', props.theme.value, props.fill.value ? 'is-fill' : ''],
			}, [
				h('div', {
					class: 'uiux-ref-graph-surface',
					role: 'group',
					'aria-label': props.label.value || undefined,
					style: { width: `${graph.width}px`, height: `${graph.height}px` },
				}, [
					h('svg', { class: 'uiux-ref-graph-edges', width: graph.width, height: graph.height, 'aria-hidden': 'true' }, [
						h('defs', ['rest', 'selected', 'problem'].map(tone => h('marker', {
							id: arrow(tone),
							viewBox: '0 0 10 10',
							refX: 9,
							refY: 5,
							markerWidth: 7,
							markerHeight: 7,
							orient: 'auto-start-reverse',
						}, [h('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `arrow-${tone}` })]))),
						...graph.edges.map(edge => h('path', {
							key: `edge-${edge.index}`,
							d: edge.path,
							class: ['uiux-ref-graph-edge', `is-${edgeTone(edge)}`],
							'marker-end': edge.dangling ? undefined : `url(#${arrow(edgeTone(edge))})`,
						})),
					]),
					...graph.edges.map(edge => h('button', {
						key: `label-${edge.index}`,
						type: 'button',
						tabindex: -1,
						class: ['uiux-ref-graph-edge-label', `is-${edgeTone(edge)}`],
						style: { left: `${edge.labelX}px`, top: `${edge.labelY}px` },
						title: edgeLabel(edge),
						'aria-label': edgeLabel(edge),
						'aria-pressed': String(selection === `edge:${edge.index}`),
						'data-graph-edge': String(edge.index),
						onClick: () => choose(`edge:${edge.index}`),
					}, edge.trigger)),
					...graph.nodes.map((node) => {
						const selected = selection === node.key
						return h('button', {
							key: `node-${node.key}`,
							type: 'button',
							class: ['uiux-ref-graph-node', selected ? 'is-selected' : '', node.unreachable ? 'is-unreachable' : ''],
							style: { left: `${node.x}px`, top: `${node.y}px`, width: `${GRAPH_NODE_WIDTH}px`, height: `${GRAPH_NODE_HEIGHT}px` },
							tabindex: tabStop === node.key ? 0 : -1,
							title: node.label,
							'aria-label': nodeLabel(node),
							'aria-pressed': String(selected),
							'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End',
							'data-graph-node': node.key,
							onClick: () => choose(node.key),
							onKeydown: (event: KeyboardEvent) => onNodeKeydown(event, graph, node.key),
						}, [
							h('span', { class: 'uiux-ref-graph-node-top' }, [
								node.entry ? iconNode('flag', 14) : null,
								h('span', { class: 'uiux-ref-graph-node-name' }, node.label),
								node.problems ? h(KitBadge, { tone: 'danger', variant: 'subtle', icon: 'circle-alert', label: String(node.problems) }) : null,
							]),
							h('span', { class: 'uiux-ref-graph-node-bottom' }, [
								node.variantName
									? h(KitBadge, { variant: 'mono', label: node.variantName })
									: h('span', { class: 'uiux-ref-graph-node-base' }, props.baseLabel.value ?? ''),
								node.unreachable
									? h('span', { class: 'uiux-ref-graph-node-mark is-unreachable' }, props.unreachableLabel.value ?? '')
									: node.terminal ? h('span', { class: 'uiux-ref-graph-node-mark' }, props.endLabel.value ?? '') : null,
							]),
						])
					}),
				]),
			])
		}
	},
})

// ---------------------------------------------------------------------------
// 33. Image — an Asset-bound picture
// ---------------------------------------------------------------------------
// Adapter only. `source` is an asset-capable Config field (Catalog `assetFields`): the author binds an image
// Asset with `{ "$asset": "<assetId>" }` and UIUX lowers it to `{ url, mediaType, contentDigest }` before the
// Widget sees it (Clause 01a167f4-3e4e-7af1-b328-30fb52f7f4c5).
const IMAGE_FITS = ['contain', 'cover', 'fill', 'none'] as const

export interface ImageInterfaces {
	config: {
		raw: ({
			source?: AdapterAssetValue
			alt?: string
			altKey?: string
			width?: number | string
			height?: number | string
			fit?: typeof IMAGE_FITS[number]
			radius?: number | string
		}) | null
		resolved: {
			source: AdapterAssetValue | null
			alt: string
			altKey: string | null
			width: number | string | undefined
			height: number | string | undefined
			fit: typeof IMAGE_FITS[number]
			radius: number | string | undefined
		}
	}
	properties: {
		altResult: TranslationResult
		alt: string
		source: AdapterAssetValue | null
		look: { width: number | string | undefined; height: number | string | undefined; fit: string; radius: number | string | undefined }
		theme: string
	}
}

function assetValueOf(value: unknown): AdapterAssetValue | null {
	if (!isRecord(value) || typeof value.url !== 'string' || value.url === '') return null
	return { url: value.url, mediaType: stringOr(value.mediaType, ''), contentDigest: stringOr(value.contentDigest, '') }
}

export const imagePlugin = createWidgetPlugin('Image')
	.description('A picture from an image Asset: `source` is an Asset-bound field, so the author binds an Asset and the Workspace resolves it. Translatable alternative text (empty for a decorative image), a size, a fit and a radius. Without a resolved source it shows a dashed placeholder.')
	.interfaces<ImageInterfaces>()
	.config({
		description: 'Image configuration. `source` takes `{ "$asset": "<assetId>" }` (an image Asset). `alt` accepts an `$i18n` binding (lowered to `altKey`). `width` and `height` are px as a number or any CSS length.',
		schema: configSchema({
			source: {
				type: 'object',
				properties: { url: { type: 'string' }, mediaType: { type: 'string' }, contentDigest: { type: 'string' } },
				required: ['url', 'mediaType', 'contentDigest'],
			},
			alt: { type: 'string' }, altKey: { type: 'string' },
			width: { type: ['number', 'string'] },
			height: { type: ['number', 'string'] },
			fit: { enum: [...IMAGE_FITS] },
			radius: { type: ['number', 'string'] },
		}),
		validate: (c): c is ImageInterfaces['config']['raw'] => isConfigOrOmitted(c),
		resolve: raw => ({
			source: assetValueOf(raw?.source),
			alt: stringOr(raw?.alt, ''),
			altKey: optionalString(raw?.altKey),
			width: lengthOr(raw?.width),
			height: lengthOr(raw?.height),
			fit: oneOf(raw?.fit, IMAGE_FITS, 'contain'),
			radius: lengthOr(raw?.radius),
		}),
	})
	.properties(p => p
		.altResult(translatedResult<ImageInterfaces['config']['resolved']>(c => ({ key: c.altKey, literal: c.alt })))
		.alt(translatedText<ImageInterfaces['config']['resolved']>(c => ({ key: c.altKey, literal: c.alt })))
		.source({ compute: ({ config }) => config.source })
		.look({ compute: ({ config }) => ({ width: config.width, height: config.height, fit: config.fit, radius: config.radius }) })
		.theme(themeProperty()),
	)
	.done()

export const ImageRenderer = defineComponent({
	name: 'ImageRenderer',
	setup() {
		const { widgetId, useProperties } = useWidget(imagePlugin)
		const props = useProperties()
		return (): VNode => {
			const look = props.look.value
			const source = props.source.value
			const alt = props.alt.value ?? ''
			const style: CssStyle = {
				...(look?.width !== undefined ? { width: px(look.width, '') } : {}),
				...(look?.height !== undefined ? { height: px(look.height, '') } : {}),
				...(look?.radius !== undefined ? { borderRadius: px(look.radius, '') } : {}),
			}
			if (!source) {
				return h('span', {
					[WIDGET_ID_ATTRIBUTE]: widgetId,
					role: alt ? 'img' : undefined,
					'aria-label': alt || undefined,
					'aria-hidden': alt ? undefined : 'true',
					class: ['uiux-ref-scope', 'uiux-ref-image', 'is-empty', props.theme.value],
					style,
				})
			}
			return h('img', {
				[WIDGET_ID_ATTRIBUTE]: widgetId,
				class: ['uiux-ref-scope', 'uiux-ref-image', props.theme.value],
				style: { ...style, objectFit: look?.fit ?? 'contain' },
				src: source.url,
				alt,
				'data-media-type': source.mediaType,
				'data-content-digest': source.contentDigest,
			})
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

/** The interpolation parameters of Text, Button, Alert, Panel and Disclosure: each maps to the Widget's Property of its Config value. */
const VALUE_PARAMS = { value: 'valueText', value2: 'value2Text', value3: 'value3Text' } as const

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
	Panel: { i18n: { fields: { title: i18nField('title', VALUE_PARAMS), description: i18nField('description', VALUE_PARAMS), closeLabel: i18nField('closeLabel') } } },
	Text: { i18n: { fields: { text: i18nField('text', VALUE_PARAMS) } } },
	Button: { i18n: { fields: { label: i18nField('label', VALUE_PARAMS) } } },
	Badge: { i18n: { fields: { label: i18nField('label', { value: 'valueText', ...RENDER_CONTEXT_PARAMS }) } } },
	TextInput: i18nFields('value', 'placeholder', 'label', 'help', 'error'),
	NavItem: i18nFields('label', 'meta', 'badge'),
	Divider: {},
	Avatar: i18nFields('label'),
	Kbd: {},
	Pin: i18nFields('label'),
	Bubble: i18nFields('title', 'statusLabel', 'context', 'closeLabel'),
	CanvasStage: i18nFields('label'),
	SegmentedControl: i18nFields('label'),
	Segment: i18nFields('label', 'badge'),
	TabBar: i18nFields('label'),
	TabBarItem: i18nFields('label'),
	Rail: i18nFields('label'),
	ContextBar: i18nFields('label'),
	ContextChip: { i18n: { fields: { label: i18nField('label'), value: i18nField('value', RENDER_CONTEXT_PARAMS) } } },
	TimelineItem: i18nFields('role', 'time', 'body'),
	ThreadRow: i18nFields('title', 'meta', 'time'),
	Alert: { i18n: { fields: { title: i18nField('title', VALUE_PARAMS), description: i18nField('description', VALUE_PARAMS), dismissLabel: i18nField('dismissLabel') } } },
	EmptyState: i18nFields('title', 'description'),
	Icon: i18nFields('label'),
	Skeleton: i18nFields('label'),
	ListItem: {},
	Checkbox: i18nFields('label', 'description'),
	Select: i18nFields('label', 'help', 'placeholder', 'value'),
	SelectOption: i18nFields('label', 'description'),
	Disclosure: { i18n: { fields: { label: i18nField('label', VALUE_PARAMS) } } },
	CodeBlock: i18nFields('label'),
	Table: i18nFields('label'),
	TableRow: {},
	DiffItem: i18nFields('opLabel', 'field'),
	Breadcrumb: i18nFields('label'),
	BreadcrumbItem: i18nFields('label', 'variant', 'trailing'),
	GraphCanvas: i18nFields('label', 'entryLabel', 'endLabel', 'unreachableLabel', 'baseLabel', 'problemsLabel'),
	Image: { ...i18nFields('alt'), assetFields: { source: { acceptedCategories: ['image'] } } },
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
		iconPlugin,
		skeletonPlugin,
		listItemPlugin,
		checkboxPlugin,
		selectPlugin,
		selectOptionPlugin,
		disclosurePlugin,
		codeBlockPlugin,
		tablePlugin,
		tableRowPlugin,
		diffItemPlugin,
		breadcrumbPlugin,
		breadcrumbItemPlugin,
		graphCanvasPlugin,
		imagePlugin,
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
		{ type: 'Icon', component: IconRenderer },
		{ type: 'Skeleton', component: SkeletonRenderer },
		{ type: 'ListItem', component: ListItemRenderer },
		{ type: 'Checkbox', component: CheckboxRenderer },
		{ type: 'Select', component: SelectRenderer },
		{ type: 'SelectOption', component: SelectOptionRenderer },
		{ type: 'Disclosure', component: DisclosureRenderer },
		{ type: 'CodeBlock', component: CodeBlockRenderer },
		{ type: 'Table', component: TableRenderer },
		{ type: 'TableRow', component: TableRowRenderer },
		{ type: 'DiffItem', component: DiffItemRenderer },
		{ type: 'Breadcrumb', component: BreadcrumbRenderer },
		{ type: 'BreadcrumbItem', component: BreadcrumbItemRenderer },
		{ type: 'GraphCanvas', component: GraphCanvasRenderer },
		{ type: 'Image', component: ImageRenderer },
	],
	providers: [],
	// The reference CSS styles exactly the Workspace themes `light` and `dark`; UIUX diagnoses any other
	// theme instead of rendering it (Clause 01a11a5a-448c-76ba-94d4-6766435b9e2b, Rule 01a115cd-c27d-78ba-b95d-bf1aa50adec7).
	themeSupport: {
		supports: themeId => REFERENCE_THEME_IDS.has(themeId),
	},
}

export default manifest
