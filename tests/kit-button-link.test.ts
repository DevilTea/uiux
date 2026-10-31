// @vitest-environment happy-dom
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, h, type Component } from 'vue'

import { extractProductAdapterManifest } from '../src/adapters/product-integration'
import { ICONS } from '../.uiux/kit/src/ui/icons'

/**
 * The Kit batch of issue #435 (Refs #380, #379): the Button link form (`href`, `target`, `rel`, `download` render an
 * `<a>`; no router; a disabled or loading link drops `href` and is `aria-disabled` and out of the tab order; no
 * `aria-pressed` on a link), the `warning` and `warning-soft` Button variants with their `--kit-warning-hover` token, and
 * the `chevron-left` icon. The Kit components are `.vue` files that only a Kit build compiles, so the test runs the
 * real `kit/build.mjs` over a copy of `kit/src` with `src/ui/Button.vue` as the one entry, and mounts that bundle
 * with Vue in happy-dom. Styles are asserted as rules of the built stylesheet, which happy-dom does not apply.
 */

const KIT = join(process.cwd(), '.uiux', 'kit')
let work = ''
let Button: Component
let css = ''

beforeAll(async () => {
	await mkdir(join(process.cwd(), 'node_modules', '.cache'), { recursive: true })
	work = await mkdtemp(join(process.cwd(), 'node_modules', '.cache', 'uiux-kit-button-'))
	await cp(join(KIT, 'src'), join(work, 'src'), { recursive: true })
	const build = (await readFile(join(KIT, 'build.mjs'), 'utf8')).replace(`entryPoints: { uiux: 'adapters/reference.ts' }`, `entryPoints: { uiux: 'src/ui/Button.vue' }`)
	expect(build).toContain(`'src/ui/Button.vue'`)
	await writeFile(join(work, 'build.mjs'), build)
	await promisify(execFile)(process.execPath, ['build.mjs'], { cwd: work })
	css = await readFile(join(work, 'dist', 'uiux.css'), 'utf8')
	// Node cannot load the `import "./uiux.css"` banner (the Preview bundler does); the stylesheet is read above.
	await writeFile(join(work, 'dist', 'button.mjs'), (await readFile(join(work, 'dist', 'uiux.js'), 'utf8')).replace('import "./uiux.css";', ''))
	Button = (await import(pathToFileURL(join(work, 'dist', 'button.mjs')).href) as { default: Component }).default
}, 120_000)

afterAll(async () => {
	if (work) await rm(work, { recursive: true, force: true })
})

/** Mounts the Kit Button with `props` and `attrs` (listeners are attrs such as `onClick`) and returns its root element. */
function mount(props: Record<string, unknown>, slot?: string): HTMLElement {
	const host = document.createElement('div')
	document.body.appendChild(host)
	createApp({ render: () => h(Button, props, slot ? { default: () => slot } : undefined) }).mount(host)
	return host.firstElementChild as HTMLElement
}

/** The declarations of the rule of the built stylesheet whose selector list holds `selector` (split at top-level commas). */
function declarations(selector: string): string {
	for (const [, list, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const entries: string[] = []
		let depth = 0
		let current = ''
		for (const char of list!) {
			if (char === '(') depth++
			if (char === ')') depth--
			if (char === ',' && depth === 0) { entries.push(current.trim()); current = '' }
			else current += char
		}
		entries.push(current.trim())
		if (entries.includes(selector)) return body!.replace(/\s+/g, ' ').trim()
	}
	throw new Error(`the built stylesheet has no rule for ${selector}`)
}

const INERT = ':is(:disabled, [aria-disabled=true])'

describe('Button link form', () => {
	it('renders an anchor with the same classes when `href` is given, and a button without it', () => {
		const link = mount({ href: '/workspace', label: 'Open', variant: 'outline', size: 'sm' })
		expect(link.tagName).toBe('A')
		expect(link.getAttribute('href')).toBe('/workspace')
		expect(link.classList.contains('kit-btn')).toBe(true)
		expect(link.classList.contains('kit-btn--outline')).toBe(true)
		expect(link.classList.contains('kit-btn--sm')).toBe(true)
		expect(link.textContent).toContain('Open')
		const button = mount({ label: 'Open', variant: 'outline', size: 'sm' })
		expect(button.tagName).toBe('BUTTON')
		expect(button.getAttribute('type')).toBe('button')
		expect(button.hasAttribute('href')).toBe(false)
		expect([...link.classList].sort()).toEqual([...button.classList].sort())
	})

	it('carries `target`, `rel` and `download`, and a `_blank` target defaults `rel` to noopener', () => {
		const blank = mount({ href: 'https://example.com', target: '_blank', label: 'Docs' })
		expect(blank.getAttribute('target')).toBe('_blank')
		expect(blank.getAttribute('rel')).toBe('noopener')
		expect(mount({ href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer', label: 'Docs' }).getAttribute('rel')).toBe('noopener noreferrer')
		expect(mount({ href: '/a', label: 'Same tab' }).hasAttribute('rel')).toBe(false)
		expect(mount({ href: '/a/file.bin', download: 'report.bin', label: 'Save' }).getAttribute('download')).toBe('report.bin')
		expect(mount({ href: '/a/file.bin', download: true, label: 'Save' }).hasAttribute('download')).toBe(true)
		expect(mount({ href: '/a/file.bin', label: 'Plain' }).hasAttribute('download')).toBe(false)
	})

	it('keeps `aria-label` and `title` for an icon-only link, and never emits type, disabled or aria-pressed on a link', () => {
		const link = mount({ href: '/x', label: 'Close', icon: 'x', iconOnly: true, pressed: true, type: 'submit' })
		expect(link.getAttribute('aria-label')).toBe('Close')
		expect(link.getAttribute('title')).toBe('Close')
		expect(link.hasAttribute('aria-pressed')).toBe(false)
		expect(link.classList.contains('is-pressed')).toBe(false)
		expect(link.hasAttribute('type')).toBe(false)
		expect(link.hasAttribute('disabled')).toBe(false)
		expect(mount({ label: 'Toggle', pressed: true }).getAttribute('aria-pressed')).toBe('true')
	})

	it.each([['disabled'], ['loading']])('a %s link drops `href`, is aria-disabled and leaves the tab order', (flag) => {
		const link = mount({ href: '/workspace', target: '_blank', download: 'a.bin', label: 'Open', [flag]: true })
		expect(link.tagName).toBe('A')
		expect(link.hasAttribute('href')).toBe(false)
		expect(link.hasAttribute('download')).toBe(false)
		expect(link.getAttribute('aria-disabled')).toBe('true')
		expect(link.getAttribute('tabindex')).toBe('-1')
		expect(link.hasAttribute('disabled')).toBe(false)
		if (flag === 'loading') expect(link.getAttribute('aria-busy')).toBe('true')
		const live = mount({ href: '/workspace', label: 'Open' })
		expect(live.hasAttribute('aria-disabled')).toBe(false)
		expect(live.hasAttribute('tabindex')).toBe(false)
	})

	it('hands a click on an enabled link to the parent, and swallows the click of a disabled link before the parent sees it', () => {
		let live = 0
		let inert = 0
		const enabled = mount({ href: '/a', label: 'Go', onClick: () => { live++ } })
		enabled.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
		expect(live).toBe(1)
		const disabled = mount({ href: '/a', label: 'Go', disabled: true, onClick: () => { inert++ } })
		const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
		disabled.dispatchEvent(event)
		expect(inert).toBe(0)
		expect(event.defaultPrevented).toBe(true)
		// A disabled button stays the platform's: `disabled` attribute, no aria-disabled.
		const button = mount({ label: 'Go', disabled: true })
		expect(button.hasAttribute('disabled')).toBe(true)
		expect(button.hasAttribute('aria-disabled')).toBe(false)
	})

	it('draws a disabled link like a disabled button, and an anchor without an underline unless it is a link variant', () => {
		expect(declarations(`.kit-btn${INERT}`)).toMatch(/cursor: not-allowed/)
		expect(declarations(`.kit-btn.kit-btn--primary${INERT}`)).toMatch(/opacity: 0\.6/)
		expect(declarations(`.kit-btn.kit-btn--soft:not(${INERT})`)).toMatch(/--kit-bg-surface-elevated/)
		expect(declarations('a.kit-btn')).toMatch(/text-decoration: none/)
		expect(declarations('.kit-btn.kit-btn--link')).toMatch(/text-decoration: underline/)
	})
})

describe('Button warning variants', () => {
	it('adds `warning` (solid) and `warning-soft` to the variant classes', () => {
		expect(mount({ variant: 'warning', label: 'Acknowledge' }).classList.contains('kit-btn--warning')).toBe(true)
		expect(mount({ variant: 'warning-soft', label: 'Unplaced' }).classList.contains('kit-btn--warning-soft')).toBe(true)
	})

	it('draws solid warning as the warning fill with inverted text, dimming on hover to 75% like Nuxt UI', () => {
		const solid = declarations('.kit-btn.kit-btn--warning')
		expect(solid).toMatch(/background-color: var\(--kit-warning\)/)
		expect(solid).toMatch(/color: var\(--kit-text-inverted\)/)
		expect(declarations(`.kit-btn.kit-btn--warning:hover:not(${INERT})`)).toMatch(/color-mix\(in oklab, var\(--kit-warning\) 75%, transparent\)/)
		expect(declarations(`.kit-btn.kit-btn--warning${INERT}`)).toMatch(/opacity: 0\.6/)
	})

	it('draws warning-soft as the subtle warning fill with warning text and no border, deepening on hover', () => {
		const soft = declarations('.kit-btn.kit-btn--warning-soft')
		expect(soft).toMatch(/background-color: var\(--kit-warning-subtle\)/)
		expect(soft).toMatch(/color: var\(--kit-warning\)/)
		expect(soft).toMatch(/border-color: transparent/)
		expect(declarations(`.kit-btn.kit-btn--warning-soft:hover:not(${INERT})`)).toMatch(/background-color: var\(--kit-warning-hover\)/)
		expect(declarations(`.kit-btn.kit-btn--warning-soft${INERT}`)).toMatch(/opacity: 0\.6/)
	})

	it('defines --kit-warning-hover in the light, dark and automatic dark token blocks', async () => {
		const tokens = await readFile(join(KIT, 'src', 'tokens', 'tokens.css'), 'utf8')
		expect(tokens.match(/--kit-warning-hover:/g)).toHaveLength(3)
		expect(tokens).toMatch(/--kit-warning-hover: color-mix\(in oklch, var\(--color-caution-yellow-800\) 18%, transparent\)/)
		expect(tokens.match(/--kit-warning-hover: color-mix\(in oklch, var\(--color-caution-yellow-400\) 24%, transparent\)/g)).toHaveLength(2)
	})

	it('offers both variants to authors through the reference Adapter Button Widget', async () => {
		const namespace = await import(pathToFileURL(join(KIT, 'dist', 'uiux.js')).href) as Record<string, unknown>
		const manifest = extractProductAdapterManifest(namespace)
		const button = (manifest.widgetPlugins as unknown as ReadonlyArray<{ type: string; config: { schema: { properties: Record<string, { enum?: string[] }> } } }>).find(plugin => plugin.type === 'Button')!
		expect(button.config.schema.properties.variant?.enum).toEqual(expect.arrayContaining(['warning', 'warning-soft']))
	})
})

describe('the chevron-left icon', () => {
	it('is in the Kit icon table, as a Lucide stroke path that points left', () => {
		expect(ICONS['chevron-left']).toContain('d="m15 18l-6-6l6-6"')
		expect(ICONS['chevron-left']).toContain('stroke="currentColor"')
		expect(ICONS['chevron-right']).toBeDefined()
	})
})
