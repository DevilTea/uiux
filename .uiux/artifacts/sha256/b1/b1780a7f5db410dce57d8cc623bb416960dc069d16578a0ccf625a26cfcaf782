import { createWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h, type VNode } from 'vue'
import { useWidget } from '@deviltea/widget-vue'
import type { AdapterManifest } from '../../src/domain/adapters/schema'

// ---------------------------------------------------------------------------
// Self-contained CSS injection for deterministic rendering
// ---------------------------------------------------------------------------
const STYLES_ID = 'uiux-reference-adapter-styles'
const CSS_RULES = `
.uiux-ref-scope {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ref-text, #f1f5f9);
  box-sizing: border-box;
}
.uiux-ref-scope *, .uiux-ref-scope *::before, .uiux-ref-scope *::after {
  box-sizing: border-box;
}

/* Theme variables */
.uiux-theme-dark, [data-theme="dark"] {
  --ref-bg-app: #0b0d13;
  --ref-bg-surface: #131722;
  --ref-bg-surface-elevated: #1a202c;
  --ref-bg-canvas: #080a0f;
  --ref-border: #232936;
  --ref-border-subtle: #1a202c;
  --ref-text: #f1f5f9;
  --ref-text-muted: #94a3b8;
  --ref-text-subtle: #64748b;
  --ref-primary: #3b82f6;
  --ref-primary-hover: #2563eb;
  --ref-primary-subtle: rgba(59, 130, 246, 0.15);
  --ref-success: #10b981;
  --ref-success-subtle: rgba(16, 185, 129, 0.15);
  --ref-warning: #f59e0b;
  --ref-warning-subtle: rgba(245, 158, 11, 0.15);
  --ref-danger: #ef4444;
  --ref-danger-subtle: rgba(239, 68, 68, 0.15);
  --ref-info: #06b6d4;
  --ref-info-subtle: rgba(6, 182, 212, 0.15);
  --ref-ring: rgba(59, 130, 246, 0.5);
  --ref-input-bg: #090b10;
  --ref-hover-bg: rgba(255, 255, 255, 0.05);
}

.uiux-theme-light, [data-theme="light"] {
  --ref-bg-app: #f8fafc;
  --ref-bg-surface: #ffffff;
  --ref-bg-surface-elevated: #f1f5f9;
  --ref-bg-canvas: #e2e8f0;
  --ref-border: #cbd5e1;
  --ref-border-subtle: #e2e8f0;
  --ref-text: #0f172a;
  --ref-text-muted: #475569;
  --ref-text-subtle: #94a3b8;
  --ref-primary: #2563eb;
  --ref-primary-hover: #1d4ed8;
  --ref-primary-subtle: rgba(37, 99, 235, 0.12);
  --ref-success: #059669;
  --ref-success-subtle: rgba(5, 150, 105, 0.12);
  --ref-warning: #d97706;
  --ref-warning-subtle: rgba(217, 119, 6, 0.12);
  --ref-danger: #dc2626;
  --ref-danger-subtle: rgba(220, 38, 38, 0.12);
  --ref-info: #0891b2;
  --ref-info-subtle: rgba(8, 145, 178, 0.12);
  --ref-ring: rgba(37, 99, 235, 0.4);
  --ref-input-bg: #ffffff;
  --ref-hover-bg: rgba(0, 0, 0, 0.04);
}

/* Stack */
.uiux-ref-stack {
  box-sizing: border-box;
}

/* Panel */
.uiux-ref-panel {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  background-color: var(--ref-bg-surface);
  color: var(--ref-text);
  overflow: hidden;
  box-sizing: border-box;
}
.uiux-ref-panel.is-bordered {
  border: 1px solid var(--ref-border);
}
.uiux-ref-panel.variant-canvas {
  background-color: var(--ref-bg-canvas);
  border-color: var(--ref-border-subtle);
}
.uiux-ref-panel.variant-sidebar {
  background-color: var(--ref-bg-surface);
  border-color: var(--ref-border);
}
.uiux-ref-panel.variant-card {
  background-color: var(--ref-bg-surface-elevated);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.uiux-ref-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.uiux-ref-panel-body {
  flex: 1 1 auto;
  box-sizing: border-box;
}
.uiux-ref-panel-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--ref-border);
}

/* Text */
.uiux-ref-text {
  margin: 0;
  line-height: 1.4;
}
.uiux-ref-text.variant-h1 { font-size: 20px; font-weight: 700; }
.uiux-ref-text.variant-h2 { font-size: 16px; font-weight: 600; }
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
.uiux-ref-text.is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.uiux-ref-text.is-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Button */
.uiux-ref-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  white-space: nowrap;
  user-select: none;
  line-height: 1;
}
.uiux-ref-btn:focus-visible {
  outline: 2px solid var(--ref-primary);
  outline-offset: 2px;
}
.uiux-ref-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.uiux-ref-btn.size-sm { padding: 4px 8px; font-size: 11px; height: 24px; }
.uiux-ref-btn.size-md { padding: 6px 12px; font-size: 12px; height: 30px; }
.uiux-ref-btn.size-lg { padding: 8px 16px; font-size: 14px; height: 36px; }

.uiux-ref-btn.variant-primary {
  background-color: var(--ref-primary);
  color: #ffffff;
  border-color: var(--ref-primary);
}
.uiux-ref-btn.variant-primary:hover:not(:disabled) {
  background-color: var(--ref-primary-hover);
}

.uiux-ref-btn.variant-secondary {
  background-color: var(--ref-bg-surface-elevated);
  color: var(--ref-text);
  border-color: var(--ref-border);
}
.uiux-ref-btn.variant-secondary:hover:not(:disabled) {
  background-color: var(--ref-hover-bg);
  border-color: var(--ref-text-subtle);
}

.uiux-ref-btn.variant-ghost {
  background-color: transparent;
  color: var(--ref-text-muted);
  border-color: transparent;
}
.uiux-ref-btn.variant-ghost:hover:not(:disabled) {
  background-color: var(--ref-hover-bg);
  color: var(--ref-text);
}

.uiux-ref-btn.variant-outline {
  background-color: transparent;
  color: var(--ref-text);
  border-color: var(--ref-border);
}
.uiux-ref-btn.variant-outline:hover:not(:disabled) {
  background-color: var(--ref-hover-bg);
}

.uiux-ref-btn.variant-danger {
  background-color: var(--ref-danger);
  color: #ffffff;
}

/* Badge */
.uiux-ref-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 9999px;
  line-height: 1.2;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.uiux-ref-badge.tone-neutral {
  background-color: var(--ref-hover-bg);
  color: var(--ref-text-muted);
  border: 1px solid var(--ref-border);
}
.uiux-ref-badge.tone-primary {
  background-color: var(--ref-primary-subtle);
  color: var(--ref-primary);
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.uiux-ref-badge.tone-success {
  background-color: var(--ref-success-subtle);
  color: var(--ref-success);
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.uiux-ref-badge.tone-warning {
  background-color: var(--ref-warning-subtle);
  color: var(--ref-warning);
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.uiux-ref-badge.tone-danger {
  background-color: var(--ref-danger-subtle);
  color: var(--ref-danger);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.uiux-ref-badge.tone-info {
  background-color: var(--ref-info-subtle);
  color: var(--ref-info);
  border: 1px solid rgba(6, 182, 212, 0.3);
}

/* TextInput */
.uiux-ref-input-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.uiux-ref-input-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--ref-text-muted);
}
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
.uiux-ref-input:focus {
  border-color: var(--ref-primary);
  box-shadow: 0 0 0 2px var(--ref-ring);
}
.uiux-ref-input::placeholder {
  color: var(--ref-text-subtle);
}

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
}
.uiux-ref-nav-item:hover {
  background-color: var(--ref-hover-bg);
  color: var(--ref-text);
}
.uiux-ref-nav-item.is-selected {
  background-color: var(--ref-primary-subtle);
  color: var(--ref-primary);
  font-weight: 600;
}
.uiux-ref-nav-item-content {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uiux-ref-nav-item-icon {
  font-size: 13px;
  flex-shrink: 0;
}
.uiux-ref-nav-item-meta {
  font-size: 10px;
  color: var(--ref-text-subtle);
  margin-left: auto;
}

/* Divider */
.uiux-ref-divider {
  border: 0;
  margin: 0;
  box-sizing: border-box;
}
.uiux-ref-divider.is-horizontal {
  width: 100%;
  border-top: 1px solid var(--ref-border);
}
.uiux-ref-divider.is-vertical {
  height: 100%;
  border-left: 1px solid var(--ref-border);
}
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

// ---------------------------------------------------------------------------
// 1. Stack Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface StackInterfaces {
  config: {
    raw: {
      direction?: 'horizontal' | 'vertical'
      gap?: number | string
      align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline'
      justify?: 'start' | 'center' | 'end' | 'between' | 'around'
      padding?: number | string
      wrap?: boolean
      flex?: string | number
      width?: string
      height?: string
      grow?: boolean
    }
    resolved: {
      direction: 'horizontal' | 'vertical'
      gap: string
      align: string
      justify: string
      padding: string
      wrap: boolean
      flex: string
      width?: string
      height?: string
      grow?: boolean
    }
  }
  slots: 'content'
  properties: {
    direction: 'horizontal' | 'vertical'
    gap: string
    align: string
    justify: string
    padding: string
    wrap: boolean
    flex: string
    width?: string
    height?: string
    theme: string
  }
}

export const stackPlugin = createWidgetPlugin('Stack')
  .description('Layout container for horizontal and vertical stacking with gap and alignment.')
  .interfaces<StackInterfaces>()
  .config({
    description: 'Stack configuration',
    validate: (c): c is StackInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      direction: raw?.direction === 'horizontal' ? 'horizontal' : 'vertical',
      gap: typeof raw?.gap === 'number' ? `${raw.gap}px` : (raw?.gap ?? '8px'),
      align: raw?.align === 'start' ? 'flex-start' : (raw?.align === 'end' ? 'flex-end' : (raw?.align === 'center' ? 'center' : (raw?.align === 'baseline' ? 'baseline' : 'stretch'))),
      justify: raw?.justify === 'center' ? 'center' : (raw?.justify === 'end' ? 'flex-end' : (raw?.justify === 'between' ? 'space-between' : (raw?.justify === 'around' ? 'space-around' : 'flex-start'))),
      padding: typeof raw?.padding === 'number' ? `${raw.padding}px` : (raw?.padding ?? '0px'),
      wrap: Boolean(raw?.wrap),
      flex: raw?.flex !== undefined ? String(raw.flex) : (raw?.grow ? '1 1 auto' : 'none'),
      ...(raw?.width ? { width: String(raw.width) } : {}),
      ...(raw?.height ? { height: String(raw.height) } : {}),
    }),
  })
  .slots({ content: { description: 'Nested child widgets' } })
  .properties(p => p
    .direction({ compute: ({ config }) => config.direction })
    .gap({ compute: ({ config }) => config.gap })
    .align({ compute: ({ config }) => config.align })
    .justify({ compute: ({ config }) => config.justify })
    .padding({ compute: ({ config }) => config.padding })
    .wrap({ compute: ({ config }) => config.wrap })
    .flex({ compute: ({ config }) => config.flex })
    .width({ compute: ({ config }) => config.width })
    .height({ compute: ({ config }) => config.height })
    .theme({
      registerDeps: ({ dep }) => ({ themeId: dep.root.state.get('themeId') }),
      compute: ({ deps }) => {
        const t = deps.themeId()
        return t.ok && typeof t.value === 'string' ? t.value : 'dark'
      },
    }),
  )
  .done()

export const StackRenderer = defineComponent({
  name: 'StackRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, WidgetSlot, useProperties } = useWidget(stackPlugin)
    const props = useProperties()

    return (): VNode => {
      const isHorizontal = props.direction.value === 'horizontal'
      const themeClass = props.theme.value === 'light' ? 'uiux-theme-light' : 'uiux-theme-dark'
      return h('div', {
        'data-widget-id': widgetId,
        'data-theme': props.theme.value,
        class: ['uiux-ref-scope', 'uiux-ref-stack', themeClass],
        style: {
          display: 'flex',
          flexDirection: isHorizontal ? 'row' : 'column',
          gap: props.gap.value,
          alignItems: props.align.value,
          justifyContent: props.justify.value,
          padding: props.padding.value,
          flexWrap: props.wrap.value ? 'wrap' : 'nowrap',
          flex: props.flex.value !== 'none' ? props.flex.value : undefined,
          width: props.width.value,
          height: props.height.value,
        },
      }, [
        h(WidgetSlot, { name: 'content' }),
      ])
    }
  },
})

// ---------------------------------------------------------------------------
// 2. Panel Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface PanelInterfaces {
  config: {
    raw: {
      title?: string
      variant?: 'default' | 'surface' | 'sidebar' | 'canvas' | 'card'
      padding?: number | string
      border?: boolean
      width?: string
      height?: string
      flex?: string | number
      scrollable?: boolean
    }
    resolved: {
      title?: string
      variant: 'default' | 'surface' | 'sidebar' | 'canvas' | 'card'
      padding: string
      border: boolean
      width?: string
      height?: string
      flex: string
      scrollable: boolean
    }
  }
  slots: 'header' | 'content' | 'footer'
  properties: {
    title?: string
    variant: string
    padding: string
    border: boolean
    width?: string
    height?: string
    flex: string
    scrollable: boolean
  }
}

export const panelPlugin = createWidgetPlugin('Panel')
  .description('Surface container with optional header, footer, and styling variants.')
  .interfaces<PanelInterfaces>()
  .config({
    description: 'Panel configuration',
    validate: (c): c is PanelInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      ...(raw?.title ? { title: String(raw.title) } : {}),
      variant: raw?.variant ?? 'default',
      padding: typeof raw?.padding === 'number' ? `${raw.padding}px` : (raw?.padding ?? '12px'),
      border: raw?.border ?? true,
      ...(raw?.width ? { width: String(raw.width) } : {}),
      ...(raw?.height ? { height: String(raw.height) } : {}),
      flex: raw?.flex !== undefined ? String(raw.flex) : 'none',
      scrollable: Boolean(raw?.scrollable),
    }),
  })
  .slots({
    header: { description: 'Custom header widgets' },
    content: { description: 'Main panel body' },
    footer: { description: 'Bottom actions or status' },
  })
  .properties(p => p
    .title({ compute: ({ config }) => config.title })
    .variant({ compute: ({ config }) => config.variant })
    .padding({ compute: ({ config }) => config.padding })
    .border({ compute: ({ config }) => config.border })
    .width({ compute: ({ config }) => config.width })
    .height({ compute: ({ config }) => config.height })
    .flex({ compute: ({ config }) => config.flex })
    .scrollable({ compute: ({ config }) => config.scrollable })
  )
  .done()

export const PanelRenderer = defineComponent({
  name: 'PanelRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, WidgetSlot, useProperties } = useWidget(panelPlugin)
    const props = useProperties()

    return (): VNode => {
      const hasTitle = Boolean(props.title.value)
      return h('div', {
        'data-widget-id': widgetId,
        class: [
          'uiux-ref-scope',
          'uiux-ref-panel',
          `variant-${props.variant.value}`,
          props.border.value ? 'is-bordered' : '',
        ],
        style: {
          width: props.width.value,
          height: props.height.value,
          flex: props.flex.value !== 'none' ? props.flex.value : undefined,
        },
      }, [
        hasTitle ? h('div', { class: 'uiux-ref-panel-header' }, [
          h('span', { class: 'uiux-ref-panel-title' }, props.title.value),
          h(WidgetSlot, { name: 'header' }),
        ]) : h(WidgetSlot, { name: 'header' }),
        h('div', {
          class: 'uiux-ref-panel-body',
          style: {
            padding: props.padding.value,
            overflow: props.scrollable.value ? 'auto' : 'visible',
          },
        }, [
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
export interface TextInterfaces {
  config: {
    raw: {
      text?: string
      variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'caption' | 'code'
      weight?: 'normal' | 'medium' | 'semibold' | 'bold'
      tone?: 'default' | 'muted' | 'subtle' | 'primary' | 'success' | 'warning' | 'danger'
      mono?: boolean
      truncate?: boolean
    }
    resolved: {
      text: string
      variant: 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'caption' | 'code'
      weight: 'normal' | 'medium' | 'semibold' | 'bold'
      tone: 'default' | 'muted' | 'subtle' | 'primary' | 'success' | 'warning' | 'danger'
      mono: boolean
      truncate: boolean
    }
  }
  properties: {
    text: string
    variant: string
    weight: string
    tone: string
    mono: boolean
    truncate: boolean
  }
}

export const textPlugin = createWidgetPlugin('Text')
  .description('Typography element supporting headings, body, code, and tonal accents.')
  .interfaces<TextInterfaces>()
  .config({
    description: 'Text configuration',
    validate: (c): c is TextInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      text: raw?.text ?? '',
      variant: raw?.variant ?? 'body',
      weight: raw?.weight ?? 'normal',
      tone: raw?.tone ?? 'default',
      mono: Boolean(raw?.mono),
      truncate: Boolean(raw?.truncate),
    }),
  })
  .properties(p => p
    .text({ compute: ({ config }) => config.text })
    .variant({ compute: ({ config }) => config.variant })
    .weight({ compute: ({ config }) => config.weight })
    .tone({ compute: ({ config }) => config.tone })
    .mono({ compute: ({ config }) => config.mono })
    .truncate({ compute: ({ config }) => config.truncate })
  )
  .done()

export const TextRenderer = defineComponent({
  name: 'TextRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, useProperties } = useWidget(textPlugin)
    const props = useProperties()

    return (): VNode => {
      const variant = props.variant.value
      const tag = variant === 'h1' ? 'h1'
        : variant === 'h2' ? 'h2'
        : variant === 'h3' ? 'h3'
        : variant === 'h4' ? 'h4'
        : variant === 'code' ? 'code'
        : variant === 'caption' ? 'span'
        : 'p'

      return h(tag, {
        'data-widget-id': widgetId,
        class: [
          'uiux-ref-scope',
          'uiux-ref-text',
          `variant-${variant}`,
          `weight-${props.weight.value}`,
          `tone-${props.tone.value}`,
          props.mono.value ? 'is-mono' : '',
          props.truncate.value ? 'is-truncate' : '',
        ],
      }, props.text.value)
    }
  },
})

// ---------------------------------------------------------------------------
// 4. Button Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface ButtonInterfaces {
  config: {
    raw: {
      label?: string
      variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
      size?: 'sm' | 'md' | 'lg'
      disabled?: boolean
      icon?: string
    }
    resolved: {
      label: string
      variant: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
      size: 'sm' | 'md' | 'lg'
      disabled: boolean
      icon?: string
    }
  }
  state: {
    disabled: boolean
  }
  events: {
    click: readonly []
  }
  properties: {
    label: string
    variant: string
    size: string
    icon?: string
  }
}

export const buttonPlugin = createWidgetPlugin('Button')
  .description('Interactive button with size variants and accessible keyboard focus.')
  .interfaces<ButtonInterfaces>()
  .config({
    description: 'Button configuration',
    validate: (c): c is ButtonInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      label: raw?.label ?? 'Button',
      variant: raw?.variant ?? 'secondary',
      size: raw?.size ?? 'md',
      disabled: Boolean(raw?.disabled),
      ...(raw?.icon ? { icon: String(raw.icon) } : {}),
    }),
  })
  .state(state => state.disabled({
    authorWritable: true,
    validate: (v): v is boolean => typeof v === 'boolean',
    default: ({ config }) => config.disabled,
  }))
  .events(events => events.click({ description: 'Fired on user button click' }))
  .properties(p => p
    .label({ compute: ({ config }) => config.label })
    .variant({ compute: ({ config }) => config.variant })
    .size({ compute: ({ config }) => config.size })
    .icon({ compute: ({ config }) => config.icon })
  )
  .done()

export const ButtonRenderer = defineComponent({
  name: 'ButtonRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, useState, useProperties, emit } = useWidget(buttonPlugin)
    const state = useState()
    const props = useProperties()

    return (): VNode => {
      const children: unknown[] = []
      if (props.icon.value) {
        children.push(h('span', { class: 'uiux-ref-btn-icon' }, props.icon.value))
      }
      children.push(h('span', props.label.value))

      return h('button', {
        'data-widget-id': widgetId,
        type: 'button',
        disabled: state.disabled.value,
        class: [
          'uiux-ref-scope',
          'uiux-ref-btn',
          `variant-${props.variant.value}`,
          `size-${props.size.value}`,
        ],
        onClick: () => {
          if (!state.disabled.value) {
            emit.click()
          }
        },
      }, children)
    }
  },
})

// ---------------------------------------------------------------------------
// 5. Badge Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface BadgeInterfaces {
  config: {
    raw: {
      label?: string
      tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
      variant?: 'subtle' | 'solid' | 'outline'
    }
    resolved: {
      label: string
      tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
      variant: 'subtle' | 'solid' | 'outline'
    }
  }
  properties: {
    label: string
    tone: string
    variant: string
  }
}

export const badgePlugin = createWidgetPlugin('Badge')
  .description('Compact status indicator and count tag.')
  .interfaces<BadgeInterfaces>()
  .config({
    description: 'Badge configuration',
    validate: (c): c is BadgeInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      label: raw?.label ?? '',
      tone: raw?.tone ?? 'neutral',
      variant: raw?.variant ?? 'subtle',
    }),
  })
  .properties(p => p
    .label({ compute: ({ config }) => config.label })
    .tone({ compute: ({ config }) => config.tone })
    .variant({ compute: ({ config }) => config.variant })
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
        `tone-${props.tone.value}`,
        `variant-${props.variant.value}`,
      ],
    }, props.label.value)
  },
})

// ---------------------------------------------------------------------------
// 6. TextInput Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface TextInputInterfaces {
  config: {
    raw: {
      value?: string
      placeholder?: string
      readOnly?: boolean
      label?: string
    }
    resolved: {
      value: string
      placeholder: string
      readOnly: boolean
      label?: string
    }
  }
  state: {
    value: string
  }
  properties: {
    placeholder: string
    readOnly: boolean
    label?: string
  }
}

export const textInputPlugin = createWidgetPlugin('TextInput')
  .description('Text input field supporting authored value, placeholder, and read-only presentation.')
  .interfaces<TextInputInterfaces>()
  .config({
    description: 'TextInput configuration',
    validate: (c): c is TextInputInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      value: raw?.value ?? '',
      placeholder: raw?.placeholder ?? '',
      readOnly: Boolean(raw?.readOnly),
      ...(raw?.label ? { label: String(raw.label) } : {}),
    }),
  })
  .state(state => state.value({
    authorWritable: true,
    validate: (v): v is string => typeof v === 'string',
    default: ({ config }) => config.value,
  }))
  .properties(p => p
    .placeholder({ compute: ({ config }) => config.placeholder })
    .readOnly({ compute: ({ config }) => config.readOnly })
    .label({ compute: ({ config }) => config.label })
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
      if (props.label.value) {
        elements.push(h('label', { class: 'uiux-ref-input-label' }, props.label.value))
      }
      elements.push(h('input', {
        class: 'uiux-ref-input',
        type: 'text',
        value: state.value.value,
        placeholder: props.placeholder.value,
        readOnly: props.readOnly.value,
        onInput: (event: Event) => {
          if (!props.readOnly.value) {
            state.value.value = (event.target as HTMLInputElement).value
          }
        },
      }))

      return h('div', {
        'data-widget-id': widgetId,
        class: ['uiux-ref-scope', 'uiux-ref-input-group'],
      }, elements)
    }
  },
})

// ---------------------------------------------------------------------------
// 7. NavItem Widget Plugin & Renderer
// ---------------------------------------------------------------------------
export interface NavItemInterfaces {
  config: {
    raw: {
      label?: string
      icon?: string
      meta?: string
      badge?: string
      selected?: boolean
    }
    resolved: {
      label: string
      icon?: string
      meta?: string
      badge?: string
      selected: boolean
    }
  }
  state: {
    selected: boolean
  }
  events: {
    click: readonly []
  }
  properties: {
    label: string
    icon?: string
    meta?: string
    badge?: string
  }
}

export const navItemPlugin = createWidgetPlugin('NavItem')
  .description('Navigation list item with selection state, icon, badge, and metadata tag.')
  .interfaces<NavItemInterfaces>()
  .config({
    description: 'NavItem configuration',
    validate: (c): c is NavItemInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      label: raw?.label ?? 'Item',
      ...(raw?.icon ? { icon: String(raw.icon) } : {}),
      ...(raw?.meta ? { meta: String(raw.meta) } : {}),
      ...(raw?.badge ? { badge: String(raw.badge) } : {}),
      selected: Boolean(raw?.selected),
    }),
  })
  .state(state => state.selected({
    authorWritable: true,
    validate: (v): v is boolean => typeof v === 'boolean',
    default: ({ config }) => config.selected,
  }))
  .events(events => events.click({ description: 'Fired when nav item is selected' }))
  .properties(p => p
    .label({ compute: ({ config }) => config.label })
    .icon({ compute: ({ config }) => config.icon })
    .meta({ compute: ({ config }) => config.meta })
    .badge({ compute: ({ config }) => config.badge })
  )
  .done()

export const NavItemRenderer = defineComponent({
  name: 'NavItemRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, useState, useProperties, emit } = useWidget(navItemPlugin)
    const state = useState()
    const props = useProperties()

    return (): VNode => {
      const leftChildren: VNode[] = []
      if (props.icon.value) {
        leftChildren.push(h('span', { class: 'uiux-ref-nav-item-icon' }, props.icon.value))
      }
      leftChildren.push(h('span', props.label.value))

      const rightChildren: VNode[] = []
      if (props.meta.value) {
        rightChildren.push(h('span', { class: 'uiux-ref-nav-item-meta' }, props.meta.value))
      }
      if (props.badge.value) {
        rightChildren.push(h('span', { class: 'uiux-ref-badge tone-neutral' }, props.badge.value))
      }

      return h('div', {
        'data-widget-id': widgetId,
        role: 'button',
        tabindex: 0,
        class: [
          'uiux-ref-scope',
          'uiux-ref-nav-item',
          state.selected.value ? 'is-selected' : '',
        ],
        onClick: () => {
          state.selected.value = true
          emit.click()
        },
        onKeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            state.selected.value = true
            emit.click()
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
export interface DividerInterfaces {
  config: {
    raw: {
      orientation?: 'horizontal' | 'vertical'
      spacing?: number | string
    }
    resolved: {
      orientation: 'horizontal' | 'vertical'
      spacing: string
    }
  }
  properties: {
    orientation: 'horizontal' | 'vertical'
    spacing: string
  }
}

export const dividerPlugin = createWidgetPlugin('Divider')
  .description('Visual separator line for dividing layout sections.')
  .interfaces<DividerInterfaces>()
  .config({
    description: 'Divider configuration',
    validate: (c): c is DividerInterfaces['config']['raw'] => typeof c === 'object' && c !== null,
    resolve: raw => ({
      orientation: raw?.orientation === 'vertical' ? 'vertical' : 'horizontal',
      spacing: typeof raw?.spacing === 'number' ? `${raw.spacing}px` : (raw?.spacing ?? '8px'),
    }),
  })
  .properties(p => p
    .orientation({ compute: ({ config }) => config.orientation })
    .spacing({ compute: ({ config }) => config.spacing })
  )
  .done()

export const DividerRenderer = defineComponent({
  name: 'DividerRenderer',
  setup() {
    ensureReferenceStyles()
    const { widgetId, useProperties } = useWidget(dividerPlugin)
    const props = useProperties()

    return (): VNode => {
      const isHorizontal = props.orientation.value === 'horizontal'
      return h('div', {
        'data-widget-id': widgetId,
        role: 'separator',
        class: [
          'uiux-ref-scope',
          'uiux-ref-divider',
          isHorizontal ? 'is-horizontal' : 'is-vertical',
        ],
        style: isHorizontal
          ? { margin: `${props.spacing.value} 0` }
          : { margin: `0 ${props.spacing.value}` },
      })
    }
  },
})

// ---------------------------------------------------------------------------
// Canonical Adapter Manifest
// ---------------------------------------------------------------------------
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
    widgets: {
      Stack: {},
      Panel: {},
      Text: {},
      Button: {},
      Badge: {},
      TextInput: {},
      NavItem: {},
      Divider: {},
    },
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
