import {
	createWidgetPlugin,
	createWidgetValueContract,
	type UnknownTargetDependencyOperations,
	type WidgetConfigJsonSchema,
} from '@deviltea/widget-core'
import { defineComponent, h, type VNode } from 'vue'
import { useWidget } from '@deviltea/widget-vue'
import type { AdapterManifest, AdapterWidgetCatalogEntry } from '../../src/domain/adapters/schema'

// ---------------------------------------------------------------------------
// Render-context helpers (theme, viewport tier, locale) shared by every Widget
// ---------------------------------------------------------------------------

/**
 * UIUX TranslationResult and string value-contract identities. The reference adapter declares
 * them locally (instead of importing UIUX runtime values) so it stays a self-contained module,
 * exactly like a third-party adapter would.
 */
type I18nWarning = Readonly<{ code: string; key: string; requestedLocale: string; [key: string]: string }>
type TranslationResult = Readonly<{ text: string; warnings: readonly I18nWarning[] }>
const TRANSLATION_RESULT = createWidgetValueContract<TranslationResult>('deviltea.uiux/translation-result@1')
const STRING = createWidgetValueContract<string>('deviltea.uiux/string@1')

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

/** Theme ids are opaque Workspace keys; `light` and `dark` are styled explicitly, anything else follows the OS scheme. */
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

const isConfigObject = (input: unknown): boolean => typeof input === 'object' && input !== null && !Array.isArray(input)

// ---------------------------------------------------------------------------
// Self-contained CSS injection for deterministic rendering
// ---------------------------------------------------------------------------
const STYLES_ID = 'uiux-reference-adapter-styles'
const LIGHT_TOKENS = `
  --ref-bg-app: #f8fafc;
  --ref-bg-surface: #ffffff;
  --ref-bg-surface-elevated: #f1f5f9;
  --ref-bg-canvas: #e2e8f0;
  --ref-border: #cbd5e1;
  --ref-border-subtle: #e2e8f0;
  --ref-text: #0f172a;
  --ref-text-muted: #475569;
  --ref-text-subtle: #64748b;
  --ref-primary: #2563eb;
  --ref-primary-hover: #1d4ed8;
  --ref-primary-subtle: rgba(37, 99, 235, 0.10);
  --ref-primary-border: rgba(37, 99, 235, 0.35);
  --ref-on-primary: #ffffff;
  --ref-success: #047857;
  --ref-success-subtle: rgba(4, 120, 87, 0.10);
  --ref-success-border: rgba(4, 120, 87, 0.35);
  --ref-warning: #b45309;
  --ref-warning-subtle: rgba(180, 83, 9, 0.10);
  --ref-warning-border: rgba(180, 83, 9, 0.35);
  --ref-danger: #b91c1c;
  --ref-danger-subtle: rgba(185, 28, 28, 0.10);
  --ref-danger-border: rgba(185, 28, 28, 0.35);
  --ref-info: #0e7490;
  --ref-info-subtle: rgba(14, 116, 144, 0.10);
  --ref-info-border: rgba(14, 116, 144, 0.35);
  --ref-ring: rgba(37, 99, 235, 0.4);
  --ref-input-bg: #ffffff;
  --ref-hover-bg: rgba(15, 23, 42, 0.05);
  --ref-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.06);
  color-scheme: light;
`
const DARK_TOKENS = `
  --ref-bg-app: #0b0d13;
  --ref-bg-surface: #131722;
  --ref-bg-surface-elevated: #1a202c;
  --ref-bg-canvas: #080a0f;
  --ref-border: #2a3140;
  --ref-border-subtle: #1a202c;
  --ref-text: #f1f5f9;
  --ref-text-muted: #94a3b8;
  --ref-text-subtle: #7c8aa0;
  --ref-primary: #60a5fa;
  --ref-primary-hover: #3b82f6;
  --ref-primary-subtle: rgba(96, 165, 250, 0.14);
  --ref-primary-border: rgba(96, 165, 250, 0.35);
  --ref-on-primary: #0b1220;
  --ref-success: #34d399;
  --ref-success-subtle: rgba(52, 211, 153, 0.14);
  --ref-success-border: rgba(52, 211, 153, 0.35);
  --ref-warning: #fbbf24;
  --ref-warning-subtle: rgba(251, 191, 36, 0.14);
  --ref-warning-border: rgba(251, 191, 36, 0.35);
  --ref-danger: #f87171;
  --ref-danger-subtle: rgba(248, 113, 113, 0.14);
  --ref-danger-border: rgba(248, 113, 113, 0.35);
  --ref-info: #22d3ee;
  --ref-info-subtle: rgba(34, 211, 238, 0.14);
  --ref-info-border: rgba(34, 211, 238, 0.35);
  --ref-ring: rgba(96, 165, 250, 0.5);
  --ref-input-bg: #090b10;
  --ref-hover-bg: rgba(255, 255, 255, 0.06);
  --ref-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  color-scheme: dark;
`
const CSS_RULES = `
.uiux-ref-scope {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", Helvetica, Arial, sans-serif;
  color: var(--ref-text);
  box-sizing: border-box;
  min-width: 0;
}
.uiux-ref-scope *, .uiux-ref-scope *::before, .uiux-ref-scope *::after {
  box-sizing: border-box;
}

/* Theme tokens: explicit light/dark themes, and an OS-following fallback for other theme ids. */
.uiux-theme-light, .uiux-theme-auto {${LIGHT_TOKENS}}
.uiux-theme-dark {${DARK_TOKENS}}
@media (prefers-color-scheme: dark) {
  .uiux-theme-auto {${DARK_TOKENS}}
}

.uiux-ref-hidden { display: none !important; }

/* Stack */
.uiux-ref-stack { display: flex; }
.uiux-ref-stack.surface-app { background-color: var(--ref-bg-app); color: var(--ref-text); }
.uiux-ref-stack.surface-surface { background-color: var(--ref-bg-surface); color: var(--ref-text); }
.uiux-ref-stack.surface-canvas { background-color: var(--ref-bg-canvas); color: var(--ref-text); }

/* Panel */
.uiux-ref-panel {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  background-color: var(--ref-bg-surface);
  color: var(--ref-text);
  overflow: hidden;
}
.uiux-ref-panel.is-bordered { border: 1px solid var(--ref-border); }
.uiux-ref-panel.variant-canvas {
  background-color: var(--ref-bg-canvas);
  border-color: var(--ref-border-subtle);
  border-radius: 0;
}
.uiux-ref-panel.variant-surface { border-radius: 0; }
.uiux-ref-panel.variant-sidebar {
  background-color: var(--ref-bg-surface);
  border-color: var(--ref-border);
  border-radius: 0;
}
.uiux-ref-panel.variant-card {
  background-color: var(--ref-bg-surface-elevated);
  box-shadow: var(--ref-shadow);
}
.uiux-ref-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ref-border);
  min-height: 36px;
  gap: 8px;
}
.uiux-ref-panel-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ref-text-muted);
}
.uiux-ref-panel-body { flex: 1 1 auto; min-width: 0; }

/* Text */
.uiux-ref-text { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
.uiux-ref-text.variant-h1 { font-size: 22px; font-weight: 700; }
.uiux-ref-text.variant-h2 { font-size: 17px; font-weight: 600; }
.uiux-ref-text.variant-h3 { font-size: 14px; font-weight: 600; }
.uiux-ref-text.variant-h4 { font-size: 12px; font-weight: 600; }
.uiux-ref-text.variant-body { font-size: 13px; }
.uiux-ref-text.variant-caption { font-size: 11px; }
.uiux-ref-text.variant-code { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.uiux-ref-text.weight-normal { font-weight: 400; }
.uiux-ref-text.weight-medium { font-weight: 500; }
.uiux-ref-text.weight-semibold { font-weight: 600; }
.uiux-ref-text.weight-bold { font-weight: 700; }
.uiux-ref-text.tone-default { color: var(--ref-text); }
.uiux-ref-text.tone-muted { color: var(--ref-text-muted); }
.uiux-ref-text.tone-subtle { color: var(--ref-text-subtle); }
.uiux-ref-text.tone-primary { color: var(--ref-primary); }
.uiux-ref-text.tone-success { color: var(--ref-success); }
.uiux-ref-text.tone-warning { color: var(--ref-warning); }
.uiux-ref-text.tone-danger { color: var(--ref-danger); }
.uiux-ref-text.tone-info { color: var(--ref-info); }
.uiux-ref-text.is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.uiux-ref-text.is-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Button */
.uiux-ref-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  white-space: nowrap;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
}
.uiux-ref-btn:focus-visible { outline: 2px solid var(--ref-primary); outline-offset: 2px; }
.uiux-ref-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.uiux-ref-btn.size-sm { padding: 4px 8px; font-size: 11px; height: 24px; }
.uiux-ref-btn.size-md { padding: 6px 12px; font-size: 12px; height: 30px; }
.uiux-ref-btn.size-lg { padding: 8px 16px; font-size: 14px; height: 36px; }
.uiux-ref-btn.is-icon-only.size-sm { width: 24px; padding: 0; }
.uiux-ref-btn.is-icon-only.size-md { width: 30px; padding: 0; }
.uiux-ref-btn.is-icon-only.size-lg { width: 36px; padding: 0; }
.uiux-ref-btn.is-full-width { width: 100%; }
.uiux-ref-btn.variant-primary { background-color: var(--ref-primary); color: var(--ref-on-primary); border-color: var(--ref-primary); }
.uiux-ref-btn.variant-primary:hover:not(:disabled) { background-color: var(--ref-primary-hover); }
.uiux-ref-btn.variant-secondary { background-color: var(--ref-bg-surface-elevated); color: var(--ref-text); border-color: var(--ref-border); }
.uiux-ref-btn.variant-secondary:hover:not(:disabled) { background-color: var(--ref-hover-bg); border-color: var(--ref-text-subtle); }
.uiux-ref-btn.variant-ghost { background-color: transparent; color: var(--ref-text-muted); border-color: transparent; }
.uiux-ref-btn.variant-ghost:hover:not(:disabled) { background-color: var(--ref-hover-bg); color: var(--ref-text); }
.uiux-ref-btn.variant-outline { background-color: transparent; color: var(--ref-text); border-color: var(--ref-border); }
.uiux-ref-btn.variant-outline:hover:not(:disabled) { background-color: var(--ref-hover-bg); }
.uiux-ref-btn.variant-danger { background-color: var(--ref-danger); color: var(--ref-on-primary); border-color: var(--ref-danger); }

/* Badge */
.uiux-ref-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 9999px;
  line-height: 1.3;
  letter-spacing: 0.02em;
  white-space: nowrap;
  border: 1px solid transparent;
  flex-shrink: 0;
}
.uiux-ref-badge.tone-neutral { --ref-badge-fg: var(--ref-text-muted); --ref-badge-bg: var(--ref-hover-bg); --ref-badge-border: var(--ref-border); --ref-badge-solid: var(--ref-text-muted); }
.uiux-ref-badge.tone-primary { --ref-badge-fg: var(--ref-primary); --ref-badge-bg: var(--ref-primary-subtle); --ref-badge-border: var(--ref-primary-border); --ref-badge-solid: var(--ref-primary); }
.uiux-ref-badge.tone-success { --ref-badge-fg: var(--ref-success); --ref-badge-bg: var(--ref-success-subtle); --ref-badge-border: var(--ref-success-border); --ref-badge-solid: var(--ref-success); }
.uiux-ref-badge.tone-warning { --ref-badge-fg: var(--ref-warning); --ref-badge-bg: var(--ref-warning-subtle); --ref-badge-border: var(--ref-warning-border); --ref-badge-solid: var(--ref-warning); }
.uiux-ref-badge.tone-danger { --ref-badge-fg: var(--ref-danger); --ref-badge-bg: var(--ref-danger-subtle); --ref-badge-border: var(--ref-danger-border); --ref-badge-solid: var(--ref-danger); }
.uiux-ref-badge.tone-info { --ref-badge-fg: var(--ref-info); --ref-badge-bg: var(--ref-info-subtle); --ref-badge-border: var(--ref-info-border); --ref-badge-solid: var(--ref-info); }
.uiux-ref-badge.variant-subtle { color: var(--ref-badge-fg); background-color: var(--ref-badge-bg); border-color: var(--ref-badge-border); }
.uiux-ref-badge.variant-outline { color: var(--ref-badge-fg); background-color: transparent; border-color: var(--ref-badge-border); }
.uiux-ref-badge.variant-solid { color: var(--ref-bg-surface); background-color: var(--ref-badge-solid); border-color: var(--ref-badge-solid); }

/* TextInput */
.uiux-ref-input-group { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.uiux-ref-input-label { font-size: 11px; font-weight: 500; color: var(--ref-text-muted); }
.uiux-ref-input {
  width: 100%;
  height: 28px;
  padding: 4px 8px;
  font-size: 12px;
  background-color: var(--ref-input-bg);
  color: var(--ref-text);
  border: 1px solid var(--ref-border);
  border-radius: 4px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s ease;
}
.uiux-ref-input:focus { border-color: var(--ref-primary); box-shadow: 0 0 0 2px var(--ref-ring); }
.uiux-ref-input::placeholder { color: var(--ref-text-subtle); }
.uiux-ref-input[readonly] { background-color: var(--ref-bg-surface-elevated); }

/* NavItem */
.uiux-ref-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--ref-text-muted);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease;
  gap: 8px;
  min-width: 0;
}
.uiux-ref-nav-item:hover { background-color: var(--ref-hover-bg); color: var(--ref-text); }
.uiux-ref-nav-item:focus-visible { outline: 2px solid var(--ref-primary); outline-offset: 1px; }
.uiux-ref-nav-item.is-selected { background-color: var(--ref-primary-subtle); color: var(--ref-primary); font-weight: 600; }
.uiux-ref-nav-item.is-icon-only { padding: 6px 8px; }
.uiux-ref-nav-item-content { display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.uiux-ref-nav-item-label { overflow: hidden; text-overflow: ellipsis; }
.uiux-ref-nav-item-icon { font-size: 13px; flex-shrink: 0; }
.uiux-ref-nav-item-meta { font-size: 10px; color: var(--ref-text-subtle); margin-left: auto; white-space: nowrap; }
.uiux-ref-nav-item.is-selected .uiux-ref-nav-item-meta { color: var(--ref-primary); opacity: 0.8; }

/* Divider */
.uiux-ref-divider { border: 0; margin: 0; flex-shrink: 0; }
.uiux-ref-divider.is-horizontal { width: 100%; border-top: 1px solid var(--ref-border); }
.uiux-ref-divider.is-vertical { align-self: stretch; min-height: 16px; border-left: 1px solid var(--ref-border); }
`

function ensureReferenceStyles(): void {
	if (typeof document === 'undefined') return
	if (!document.getElementById(STYLES_ID)) {
		const styleEl = document.createElement('style')
		styleEl.id = STYLES_ID
		styleEl.textContent = CSS_RULES
		document.head.appendChild(styleEl)
	}
}

type CssStyle = Record<string, string>

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
	maxWidth?: string
	/** Grow to at least the render-context viewport height (replaces `100vh` arithmetic). */
	fillViewport?: boolean
	/** Paints a themed background for top-level layout regions. */
	surface?: 'none' | 'app' | 'surface' | 'canvas'
	order?: number
	hidden?: boolean
	/** Horizontal overflow scrolls instead of wrapping (e.g. compact tab strips). */
	scrollX?: boolean
}

export interface StackInterfaces {
	config: {
		raw: StackLayout & { responsive?: Responsive<StackLayout> }
		resolved: { base: StackLayout; responsive?: Responsive<StackLayout> }
	}
	slots: 'content'
	properties: {
		layout: { style: CssStyle; surface: string; hidden: boolean }
		theme: string
	}
}

const ALIGN: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', baseline: 'baseline', stretch: 'stretch' }
const JUSTIFY: Record<string, string> = { center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', start: 'flex-start' }

function splitResponsive<T extends object>(raw: (T & { responsive?: Responsive<T> }) | null): { base: T; responsive?: Responsive<T> } {
	if (!raw) return { base: {} as T }
	const { responsive, ...base } = raw
	return responsive && typeof responsive === 'object' ? { base: base as T, responsive } : { base: base as T }
}

export const stackPlugin = createWidgetPlugin('Stack')
	.description('Responsive layout container for horizontal and vertical stacking with gap, alignment, and viewport-tier overrides.')
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
			maxWidth: { type: 'string' },
			fillViewport: { type: 'boolean' },
			surface: { enum: ['none', 'app', 'surface', 'canvas'] },
			order: { type: 'number' },
			hidden: { type: 'boolean' },
			scrollX: { type: 'boolean' },
		}),
		validate: (c): c is StackInterfaces['config']['raw'] => isConfigObject(c),
		resolve: raw => splitResponsive<StackLayout>(raw),
	})
	.slots({ content: { description: 'Nested child widgets' } })
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
					...(layout.order !== undefined ? { order: String(layout.order) } : {}),
					...(layout.scrollX ? { overflowX: 'auto' } : {}),
				}
				if (layout.fillViewport && viewport) style.minHeight = `${viewport.height}px`
				else if (layout.minHeight) style.minHeight = layout.minHeight
				return { style, surface: layout.surface ?? 'none', hidden: Boolean(layout.hidden) }
			},
		})
		.theme(themeProperty()),
	)
	.done()

export const StackRenderer = defineComponent({
	name: 'StackRenderer',
	setup() {
		ensureReferenceStyles()
		const { widgetId, WidgetSlot, useProperties } = useWidget(stackPlugin)
		const props = useProperties()

		return (): VNode => {
			const layout = props.layout.value
			return h('div', {
				'data-widget-id': widgetId,
				class: [
					'uiux-ref-scope',
					'uiux-ref-stack',
					props.theme.value,
					`surface-${layout?.surface ?? 'none'}`,
					layout?.hidden ? 'uiux-ref-hidden' : '',
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
}

export interface PanelInterfaces {
	config: {
		raw: PanelLayout & {
			title?: string
			titleKey?: string
			variant?: 'default' | 'surface' | 'sidebar' | 'canvas' | 'card'
			responsive?: Responsive<PanelLayout>
		}
		resolved: {
			title: string
			titleKey: string | null
			variant: 'default' | 'surface' | 'sidebar' | 'canvas' | 'card'
			base: PanelLayout
			responsive?: Responsive<PanelLayout>
		}
	}
	slots: 'header' | 'content' | 'footer'
	properties: {
		titleResult: TranslationResult
		title: string
		variant: string
		frame: { style: CssStyle; bodyStyle: CssStyle; bordered: boolean; hidden: boolean }
		theme: string
	}
}

export const panelPlugin = createWidgetPlugin('Panel')
	.description('Surface container with optional translatable title, header, footer, styling variants, and viewport-tier overrides.')
	.interfaces<PanelInterfaces>()
	.config({
		description: 'Panel configuration. `title` accepts an `$i18n` binding (lowered to `titleKey`).',
		schema: configSchema({
			title: { type: 'string' },
			titleKey: { type: 'string' },
			variant: { enum: ['default', 'surface', 'sidebar', 'canvas', 'card'] },
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
		}),
		validate: (c): c is PanelInterfaces['config']['raw'] => isConfigObject(c),
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
	.properties(p => p
		.titleResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.titleKey, config.title, (key, params) => deps.t(key, params)),
		})
		.title({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('titleResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
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
		ensureReferenceStyles()
		const { widgetId, WidgetSlot, useProperties } = useWidget(panelPlugin)
		const props = useProperties()

		return (): VNode => {
			const title = props.title.value ?? ''
			const frame = props.frame.value
			return h('section', {
				'data-widget-id': widgetId,
				'aria-label': title || undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-panel',
					props.theme.value,
					`variant-${props.variant.value}`,
					frame?.bordered ? 'is-bordered' : '',
					frame?.hidden ? 'uiux-ref-hidden' : '',
				],
				style: frame?.style,
			}, [
				title
					? h('div', { class: 'uiux-ref-panel-header' }, [
							h('span', { class: 'uiux-ref-panel-title' }, title),
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
type TextVariant = 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'caption' | 'code'
export interface TextPresentation {
	variant?: TextVariant
	truncate?: boolean
	align?: 'start' | 'center' | 'end'
	hidden?: boolean
}

export interface TextInterfaces {
	config: {
		raw: TextPresentation & {
			text?: string
			textKey?: string
			/** Interpolated into a translated template as `{value}`. */
			value?: string | number
			weight?: 'normal' | 'medium' | 'semibold' | 'bold'
			tone?: 'default' | 'muted' | 'subtle' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
			mono?: boolean
			responsive?: Responsive<TextPresentation>
		}
		resolved: {
			text: string
			textKey: string | null
			value: string
			weight: string
			tone: string
			mono: boolean
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
		presentation: { variant: TextVariant; truncate: boolean; align: string; hidden: boolean }
		theme: string
	}
}

export const textPlugin = createWidgetPlugin('Text')
	.description('Typography element supporting headings, body, code, tonal accents, and translatable text.')
	.interfaces<TextInterfaces>()
	.config({
		description: 'Text configuration. `text` accepts an `$i18n` binding (lowered to `textKey`); `{value}` interpolates `value`.',
		schema: configSchema({
			text: { type: 'string' },
			textKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			variant: { enum: ['h1', 'h2', 'h3', 'h4', 'body', 'caption', 'code'] },
			weight: { enum: ['normal', 'medium', 'semibold', 'bold'] },
			tone: { enum: ['default', 'muted', 'subtle', 'primary', 'success', 'warning', 'danger', 'info'] },
			mono: { type: 'boolean' },
			truncate: { type: 'boolean' },
			align: { enum: ['start', 'center', 'end'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is TextInterfaces['config']['raw'] => isConfigObject(c),
		resolve: (raw) => {
			const { text, textKey, value, weight, tone, mono, ...presentation } = raw ?? {}
			return {
				text: typeof text === 'string' ? text : '',
				textKey: optionalString(textKey),
				value: value === undefined ? '' : String(value),
				weight: weight ?? 'normal',
				tone: tone ?? 'default',
				mono: Boolean(mono),
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
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return {
					variant: presentation.variant ?? 'body',
					truncate: Boolean(presentation.truncate),
					align: presentation.align ?? 'start',
					hidden: Boolean(presentation.hidden),
				}
			},
		})
		.theme(themeProperty()),
	)
	.done()

const TEXT_TAGS: Record<TextVariant, string> = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', code: 'code', caption: 'span', body: 'p' }

export const TextRenderer = defineComponent({
	name: 'TextRenderer',
	setup() {
		ensureReferenceStyles()
		const { widgetId, useProperties } = useWidget(textPlugin)
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const variant = presentation?.variant ?? 'body'
			return h(TEXT_TAGS[variant], {
				'data-widget-id': widgetId,
				class: [
					'uiux-ref-scope',
					'uiux-ref-text',
					props.theme.value,
					`variant-${variant}`,
					`weight-${props.weight.value}`,
					`tone-${props.tone.value}`,
					props.mono.value ? 'is-mono' : '',
					presentation?.truncate ? 'is-truncate' : '',
					presentation?.hidden ? 'uiux-ref-hidden' : '',
				],
				style: presentation?.align && presentation.align !== 'start' ? { textAlign: presentation.align } : undefined,
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
}

export interface ButtonInterfaces {
	config: {
		raw: ButtonPresentation & {
			label?: string
			labelKey?: string
			variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
			disabled?: boolean
			icon?: string
			responsive?: Responsive<ButtonPresentation>
		}
		resolved: {
			label: string
			labelKey: string | null
			variant: string
			disabled: boolean
			icon: string
			base: ButtonPresentation
			responsive?: Responsive<ButtonPresentation>
		}
	}
	state: {
		disabled: boolean
	}
	events: {
		click: readonly []
	}
	properties: {
		labelResult: TranslationResult
		label: string
		variant: string
		icon: string
		presentation: { size: string; iconOnly: boolean; fullWidth: boolean; hidden: boolean }
		theme: string
	}
}

export const buttonPlugin = createWidgetPlugin('Button')
	.description('Interactive button with translatable label, size variants, icon-only mode, and accessible keyboard focus.')
	.interfaces<ButtonInterfaces>()
	.config({
		description: 'Button configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			variant: { enum: ['primary', 'secondary', 'ghost', 'outline', 'danger'] },
			size: { enum: ['sm', 'md', 'lg'] },
			disabled: { type: 'boolean' },
			icon: { type: 'string' },
			iconOnly: { type: 'boolean' },
			fullWidth: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is ButtonInterfaces['config']['raw'] => isConfigObject(c),
		resolve: (raw) => {
			const { label, labelKey, variant, disabled, icon, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : 'Button',
				labelKey: optionalString(labelKey),
				variant: variant ?? 'secondary',
				disabled: Boolean(disabled),
				icon: typeof icon === 'string' ? icon : '',
				...splitResponsive<ButtonPresentation>(presentation),
			}
		},
	})
	.state(state => state.disabled({
		authorWritable: true,
		validate: (v): v is boolean => typeof v === 'boolean',
		default: ({ config }) => config.disabled,
	}))
	.properties(p => p
		.labelResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.labelKey, config.label, (key, params) => deps.t(key, params)),
		})
		.label({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('labelResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.variant({ compute: ({ config }) => config.variant })
		.icon({ compute: ({ config }) => config.icon })
		.presentation({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => {
				const presentation = cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport())))
				return {
					size: presentation.size ?? 'md',
					iconOnly: Boolean(presentation.iconOnly && config.icon),
					fullWidth: Boolean(presentation.fullWidth),
					hidden: Boolean(presentation.hidden),
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
		ensureReferenceStyles()
		const { widgetId, useState, useProperties, emit } = useWidget(buttonPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const label = props.label.value ?? ''
			const children: VNode[] = []
			if (props.icon.value) children.push(h('span', { class: 'uiux-ref-btn-icon', 'aria-hidden': 'true' }, props.icon.value))
			if (!presentation?.iconOnly) children.push(h('span', label))

			return h('button', {
				'data-widget-id': widgetId,
				type: 'button',
				disabled: state.disabled.value,
				'aria-label': presentation?.iconOnly ? label : undefined,
				title: presentation?.iconOnly ? label : undefined,
				class: [
					'uiux-ref-scope',
					'uiux-ref-btn',
					props.theme.value,
					`variant-${props.variant.value}`,
					`size-${presentation?.size ?? 'md'}`,
					presentation?.iconOnly ? 'is-icon-only' : '',
					presentation?.fullWidth ? 'is-full-width' : '',
					presentation?.hidden ? 'uiux-ref-hidden' : '',
				],
				onClick: () => {
					if (!state.disabled.value) emit.click()
				},
			}, children)
		}
	},
})

// ---------------------------------------------------------------------------
// 5. Badge Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface BadgePresentation {
	hidden?: boolean
}

export interface BadgeInterfaces {
	config: {
		raw: BadgePresentation & {
			label?: string
			labelKey?: string
			/** Interpolated into a translated template as `{value}`. */
			value?: string | number
			tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
			variant?: 'subtle' | 'solid' | 'outline'
			responsive?: Responsive<BadgePresentation>
		}
		resolved: {
			label: string
			labelKey: string | null
			value: string
			tone: string
			variant: string
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
		hidden: boolean
		theme: string
	}
}

export const badgePlugin = createWidgetPlugin('Badge')
	.description('Compact status indicator and count tag; translated labels may interpolate {value} and the live render context ({viewportId}, {viewport}, {locale}, {theme}).')
	.interfaces<BadgeInterfaces>()
	.config({
		description: 'Badge configuration. `label` accepts an `$i18n` binding (lowered to `labelKey`).',
		schema: configSchema({
			label: { type: 'string' },
			labelKey: { type: 'string' },
			value: { type: ['string', 'number'] },
			tone: { enum: ['neutral', 'primary', 'success', 'warning', 'danger', 'info'] },
			variant: { enum: ['subtle', 'solid', 'outline'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is BadgeInterfaces['config']['raw'] => isConfigObject(c),
		resolve: (raw) => {
			const { label, labelKey, value, tone, variant, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : '',
				labelKey: optionalString(labelKey),
				value: value === undefined ? '' : String(value),
				tone: tone ?? 'neutral',
				variant: variant ?? 'subtle',
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
		ensureReferenceStyles()
		const { widgetId, useProperties } = useWidget(badgePlugin)
		const props = useProperties()

		return (): VNode => h('span', {
			'data-widget-id': widgetId,
			class: [
				'uiux-ref-scope',
				'uiux-ref-badge',
				props.theme.value,
				`tone-${props.tone.value}`,
				`variant-${props.variant.value}`,
				props.hidden.value ? 'uiux-ref-hidden' : '',
			],
		}, props.label.value ?? '')
	},
})

// ---------------------------------------------------------------------------
// 6. TextInput Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface TextInputPresentation {
	hidden?: boolean
}

export interface TextInputInterfaces {
	config: {
		raw: TextInputPresentation & {
			value?: string
			placeholder?: string
			placeholderKey?: string
			readOnly?: boolean
			label?: string
			labelKey?: string
			responsive?: Responsive<TextInputPresentation>
		}
		resolved: {
			value: string
			placeholder: string
			placeholderKey: string | null
			readOnly: boolean
			label: string
			labelKey: string | null
			base: TextInputPresentation
			responsive?: Responsive<TextInputPresentation>
		}
	}
	state: {
		value: string
	}
	properties: {
		placeholderResult: TranslationResult
		placeholder: string
		labelResult: TranslationResult
		label: string
		readOnly: boolean
		hidden: boolean
		theme: string
	}
}

export const textInputPlugin = createWidgetPlugin('TextInput')
	.description('Text input field supporting authored value, translatable placeholder and label, and read-only presentation.')
	.interfaces<TextInputInterfaces>()
	.config({
		description: 'TextInput configuration. `placeholder` and `label` accept `$i18n` bindings (lowered to `placeholderKey` / `labelKey`).',
		schema: configSchema({
			value: { type: 'string' },
			placeholder: { type: 'string' },
			placeholderKey: { type: 'string' },
			readOnly: { type: 'boolean' },
			label: { type: 'string' },
			labelKey: { type: 'string' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is TextInputInterfaces['config']['raw'] => isConfigObject(c),
		resolve: (raw) => {
			const { value, placeholder, placeholderKey, readOnly, label, labelKey, ...presentation } = raw ?? {}
			return {
				value: typeof value === 'string' ? value : '',
				placeholder: typeof placeholder === 'string' ? placeholder : '',
				placeholderKey: optionalString(placeholderKey),
				readOnly: Boolean(readOnly),
				label: typeof label === 'string' ? label : '',
				labelKey: optionalString(labelKey),
				...splitResponsive<TextInputPresentation>(presentation),
			}
		},
	})
	.state(state => state.value({
		authorWritable: true,
		validate: (v): v is string => typeof v === 'string',
		default: ({ config }) => config.value,
	}))
	.properties(p => p
		.placeholderResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.placeholderKey, config.placeholder, (key, params) => deps.t(key, params)),
		})
		.placeholder({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('placeholderResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.labelResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.labelKey, config.label, (key, params) => deps.t(key, params)),
		})
		.label({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('labelResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.readOnly({ compute: ({ config }) => config.readOnly })
		.hidden({
			registerDeps: viewportDeps,
			compute: ({ config, deps }) => Boolean(cascade(config.base, config.responsive, tierOf(readViewport(deps.viewport()))).hidden),
		})
		.theme(themeProperty()),
	)
	.done()

export const TextInputRenderer = defineComponent({
	name: 'TextInputRenderer',
	setup() {
		ensureReferenceStyles()
		const { widgetId, useState, useProperties } = useWidget(textInputPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const elements: VNode[] = []
			const label = props.label.value ?? ''
			if (label) elements.push(h('label', { class: 'uiux-ref-input-label' }, label))
			elements.push(h('input', {
				class: 'uiux-ref-input',
				type: 'text',
				value: state.value.value,
				placeholder: props.placeholder.value,
				'aria-label': label ? undefined : (props.placeholder.value || undefined),
				readOnly: props.readOnly.value,
				onInput: (event: Event) => {
					if (!props.readOnly.value) state.value.value = (event.target as HTMLInputElement).value
				},
			}))

			return h('div', {
				'data-widget-id': widgetId,
				class: ['uiux-ref-scope', 'uiux-ref-input-group', props.theme.value, props.hidden.value ? 'uiux-ref-hidden' : ''],
			}, elements)
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
		raw: NavItemPresentation & {
			label?: string
			labelKey?: string
			icon?: string
			meta?: string
			metaKey?: string
			badge?: string
			badgeKey?: string
			selected?: boolean
			responsive?: Responsive<NavItemPresentation>
		}
		resolved: {
			label: string
			labelKey: string | null
			icon: string
			meta: string
			metaKey: string | null
			badge: string
			badgeKey: string | null
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
		presentation: { iconOnly: boolean; hideMeta: boolean; hidden: boolean }
		theme: string
	}
}

export const navItemPlugin = createWidgetPlugin('NavItem')
	.description('Navigation list item with selection state, icon, translatable label, badge, and metadata tag.')
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
			selected: { type: 'boolean' },
			iconOnly: { type: 'boolean' },
			hideMeta: { type: 'boolean' },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is NavItemInterfaces['config']['raw'] => isConfigObject(c),
		resolve: (raw) => {
			const { label, labelKey, icon, meta, metaKey, badge, badgeKey, selected, ...presentation } = raw ?? {}
			return {
				label: typeof label === 'string' ? label : 'Item',
				labelKey: optionalString(labelKey),
				icon: typeof icon === 'string' ? icon : '',
				meta: typeof meta === 'string' ? meta : '',
				metaKey: optionalString(metaKey),
				badge: typeof badge === 'string' ? badge : '',
				badgeKey: optionalString(badgeKey),
				selected: Boolean(selected),
				...splitResponsive<NavItemPresentation>(presentation),
			}
		},
	})
	.state(state => state.selected({
		authorWritable: true,
		validate: (v): v is boolean => typeof v === 'boolean',
		default: ({ config }) => config.selected,
	}))
	.properties(p => p
		.labelResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.labelKey, config.label, (key, params) => deps.t(key, params)),
		})
		.label({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('labelResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.metaResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.metaKey, config.meta, (key, params) => deps.t(key, params)),
		})
		.meta({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('metaResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.badgeResult({
			valueContract: TRANSLATION_RESULT,
			registerDeps: translateDeps,
			compute: ({ config, deps }) => translateField(config.badgeKey, config.badge, (key, params) => deps.t(key, params)),
		})
		.badge({
			valueContract: STRING,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('badgeResult') }),
			compute: ({ deps }) => textOfResult(deps.result()),
		})
		.icon({ compute: ({ config }) => config.icon })
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
		ensureReferenceStyles()
		const { widgetId, useState, useProperties, emit } = useWidget(navItemPlugin)
		const state = useState()
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const label = props.label.value ?? ''
			const leftChildren: VNode[] = []
			if (props.icon.value) leftChildren.push(h('span', { class: 'uiux-ref-nav-item-icon', 'aria-hidden': 'true' }, props.icon.value))
			if (!presentation?.iconOnly) leftChildren.push(h('span', { class: 'uiux-ref-nav-item-label' }, label))

			const rightChildren: VNode[] = []
			if (props.meta.value && !presentation?.hideMeta && !presentation?.iconOnly)
				rightChildren.push(h('span', { class: 'uiux-ref-nav-item-meta' }, props.meta.value))
			if (props.badge.value)
				rightChildren.push(h('span', { class: 'uiux-ref-badge tone-neutral variant-subtle' }, props.badge.value))

			const select = () => {
				state.selected.value = true
				emit.click()
			}

			return h('div', {
				'data-widget-id': widgetId,
				role: 'button',
				tabindex: 0,
				'aria-current': state.selected.value ? 'page' : undefined,
				'aria-label': presentation?.iconOnly ? label : undefined,
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
		raw: DividerPresentation & { responsive?: Responsive<DividerPresentation> }
		resolved: { base: DividerPresentation; responsive?: Responsive<DividerPresentation> }
	}
	properties: {
		presentation: { orientation: 'horizontal' | 'vertical'; spacing: string; hidden: boolean }
		theme: string
	}
}

export const dividerPlugin = createWidgetPlugin('Divider')
	.description('Visual separator line for dividing layout sections, with viewport-tier overrides.')
	.interfaces<DividerInterfaces>()
	.config({
		description: 'Divider configuration',
		schema: configSchema({
			orientation: { enum: ['horizontal', 'vertical'] },
			spacing: { type: ['number', 'string'] },
			hidden: { type: 'boolean' },
		}),
		validate: (c): c is DividerInterfaces['config']['raw'] => isConfigObject(c),
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
		ensureReferenceStyles()
		const { widgetId, useProperties } = useWidget(dividerPlugin)
		const props = useProperties()

		return (): VNode => {
			const presentation = props.presentation.value
			const isHorizontal = presentation?.orientation !== 'vertical'
			const spacing = presentation?.spacing ?? '8px'
			return h('div', {
				'data-widget-id': widgetId,
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
// Canonical Adapter Manifest
// ---------------------------------------------------------------------------
function i18nField(field: string, params?: Readonly<Record<string, string>>) {
	return {
		configField: `${field}Key`,
		resultProperty: `${field}Result`,
		textProperty: field,
		...(params ? { params } : {}),
	}
}

const catalogWidgets: Readonly<Record<string, AdapterWidgetCatalogEntry>> = {
	Stack: {},
	Panel: { i18n: { fields: { title: i18nField('title') } } },
	Text: { i18n: { fields: { text: i18nField('text', { value: 'valueText' }) } } },
	Button: { i18n: { fields: { label: i18nField('label') } } },
	Badge: {
		i18n: {
			fields: {
				label: i18nField('label', {
					value: 'valueText',
					viewportId: 'contextViewportId',
					viewport: 'contextViewport',
					locale: 'contextLocale',
					theme: 'contextTheme',
				}),
			},
		},
	},
	TextInput: { i18n: { fields: { placeholder: i18nField('placeholder'), label: i18nField('label') } } },
	NavItem: { i18n: { fields: { label: i18nField('label'), meta: i18nField('meta'), badge: i18nField('badge') } } },
	Divider: {},
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
	],
	providers: [],
	styles: [],
	tokens: [],
}

export default manifest
