import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { canonicalJsonBytes } from '../src/persistence'
import { FileNativePersistence } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createProductKitAuthoringService } from '../src/application/services/product-kit-authoring'
import { createProductKitChecksService, RUN_DEADLINE_MS, type ProductKitChecksResult, type ProductKitCheckFinding } from '../src/application/services/product-kit-checks'
import type { ViewResource } from '../src/domain/views/schema'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Product Kit Checks (issue #141 Part 14, Discussion #139 decision 7) against a private copy of
 * the fixture Workspace whose kit adds a wrapper Adapter for four small registry components:
 *
 * - `label` renders its prop: the same twice (C1, Rule 01a11bb1-a75d-7138-a5b9-8618c9c6c78c) and the
 *   same live as fresh (C2, Rule 01a11bb1-a7bf-74ae-9639-b39f246fa117);
 * - `dice` renders `Math.random()` and `clock` renders `Date.now()`: C1 reports
 *   `kit.nondeterministic_render` (Clause 01a11bb1-8d03-7751-9173-b3c3f1ab7156);
 * - `sticky` copies its prop into local state when it mounts: C2 reports `kit.state_not_controlled`
 *   (Scenario 01a11bb1-c383-779a-9ce6-2ca1bf7448ee, Clause 01a11bb1-8980-7212-acad-4145928e5dc7);
 * - `bare`, a Vue file with neither `defineProps` nor `defineEmits`, is reported by C4 without a code
 *   (Rule 01a11bb1-a827-75e3-b05f-4099146cff2a), while `declared` is not.
 *
 * The findings are non-blocking (Rule 01a11bb1-a88c-7d78-8633-1c3b55588910): a formal capture of the
 * flagged render context still succeeds.
 */

const STABLE = '22222222-2222-4222-8222-222222222222'
const RANDOM = '33333333-3333-4333-8333-333333333333'
const STICKY = '44444444-4444-4444-8444-444444444444'

const ADAPTER = `
import { createWidgetPlugin } from '@deviltea/widget-core'
import { useWidget } from '@deviltea/widget-vue'
import { defineComponent, h } from 'vue'
import { Label } from '../src/label.ts'
import { Sticky } from '../src/sticky.ts'
import { Dice } from '../src/dice.ts'
import { Clock } from '../src/clock.ts'

const text = s => s.text({ authorWritable: true, validate: v => typeof v === 'string', default: () => 'base' })
const plugin = type => createWidgetPlugin(type).interfaces().state(text).done()
const plugins = { KitLabel: plugin('KitLabel'), KitSticky: plugin('KitSticky'), KitDice: plugin('KitDice'), KitClock: plugin('KitClock') }
const components = { KitLabel: Label, KitSticky: Sticky, KitDice: Dice, KitClock: Clock }

function wrapper(type) {
  return defineComponent({
    name: type + 'Wrapper',
    setup() {
      const widget = useWidget(plugins[type])
      const state = widget.useState()
      return () => h('div', { 'data-widget-id': widget.widgetId }, [h(components[type], { text: state.text.value })])
    },
  })
}

export const manifest = {
  id: 'kit-checks',
  apiVersion: '1',
  widgetPlugins: Object.values(plugins),
  catalog: { widgets: { KitLabel: {}, KitSticky: {}, KitDice: {}, KitClock: {} } },
  renderers: Object.keys(plugins).map(type => ({ type, component: wrapper(type) })),
  providers: [],
  styles: [],
  tokens: [],
}
`

const SOURCES: Readonly<Record<string, string>> = {
	'label.ts': `import { defineComponent, h } from 'vue'
export const Label = defineComponent({ name: 'Label', props: { text: { type: String, required: true } }, setup(props) { return () => h('span', { class: 'kit-label' }, props.text) } })
`,
	'sticky.ts': `import { defineComponent, h, ref } from 'vue'
export const Sticky = defineComponent({ name: 'Sticky', props: { text: { type: String, required: true } }, setup(props) { const local = ref(props.text); return () => h('span', { class: 'kit-sticky' }, local.value) } })
`,
	'dice.ts': `import { defineComponent, h } from 'vue'
export const Dice = defineComponent({ name: 'Dice', props: { text: { type: String, required: true } }, setup() { return () => h('span', { class: 'kit-dice' }, String(Math.random())) } })
`,
	'clock.ts': `import { defineComponent, h } from 'vue'
export const Clock = defineComponent({ name: 'Clock', props: { text: { type: String, required: true } }, setup() { return () => h('span', { class: 'kit-clock' }, String(Date.now())) } })
`,
	'Bare.vue': `<script setup lang="ts">
const label = 'bare'
</script>

<template>
  <span>{{ label }}</span>
</template>
`,
	'Declared.vue': `<script setup lang="ts">
defineProps<{ text: string }>()
</script>

<template>
  <span>{{ text }}</span>
</template>
`,
}

function view(id: string, name: string, widgets: readonly Readonly<{ id: string; type: string }>[], variants: ViewResource['variants'] = {}): ViewResource {
	return {
		id,
		name,
		feature: 'checks',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: { content: widgets.map(widget => ({ ...widget, props: {}, bindings: {}, events: {} })) },
		},
		variants,
		spec: { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	} as unknown as ViewResource
}

async function prepare(root: string): Promise<void> {
	const kit = join(root, 'kit')
	await mkdir(join(kit, 'src'), { recursive: true })
	await writeFile(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module' }))
	await writeFile(join(kit, 'adapters', 'checks.ts'), ADAPTER)
	for (const [file, source] of Object.entries(SOURCES)) await writeFile(join(kit, 'src', file), source)
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	const component = (file: string) => ({ files: [`src/${file}`], layer: 'product' })
	await writeFile(productKitPath, canonicalJsonBytes({
		...productKit,
		adapters: [...(productKit.adapters as unknown[]), { moduleSpecifier: './adapters/checks.ts' }],
		components: { label: component('label.ts'), sticky: component('sticky.ts'), dice: component('dice.ts'), clock: component('clock.ts'), bare: component('Bare.vue'), declared: component('Declared.vue') },
		widgets: { KitLabel: { component: 'label' }, KitSticky: { component: 'sticky' }, KitDice: { component: 'dice' }, KitClock: { component: 'clock' } },
	}))
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.views.create(STABLE, view(STABLE, 'Stable', [{ id: 'label', type: 'KitLabel' }], { alt: { description: 'Alt', state: { label: { text: 'alt' } } } }))
	await persistence.views.create(RANDOM, view(RANDOM, 'Random', [{ id: 'dice', type: 'KitDice' }, { id: 'clock', type: 'KitClock' }, { id: 'steady', type: 'KitLabel' }]))
	await persistence.views.create(STICKY, view(STICKY, 'Sticky', [{ id: 'sticky', type: 'KitSticky' }], { alt: { description: 'Alt', state: { sticky: { text: 'alt' } } } }))
}

let server: WorkbenchServer
let result: Extract<ProductKitChecksResult, { status: 'completed' | 'incomplete' }>

beforeAll(async () => {
	server = await startWorkbenchServer({ prepare })
	const response = await fetch(`${server.origin}/api/product-kit/checks`, { method: 'POST', headers: server.headers })
	expect(response.status).toBe(200)
	result = await response.json() as typeof result
}, 180_000)

afterAll(async () => {
	await server?.close()
})

const findingsOf = (predicate: (finding: ProductKitCheckFinding) => boolean) => result.findings.filter(predicate)

describe('Product Kit Checks', () => {
	it('runs every check to completion within its bounds', () => {
		expect(result.status, JSON.stringify(result.checks)).toBe('completed')
		// The fixture View's base state, Stable's base and Variant, Random's base, Sticky's base and Variant.
		expect(result.checks.repeat_capture).toMatchObject({ state: 'completed', checked: 6, unchecked: 0 })
		expect(result.checks.live_versus_fresh).toMatchObject({ state: 'completed', checked: 2, unchecked: 0 })
		expect(result.checks.props_emits).toMatchObject({ state: 'completed', checked: 6, unchecked: 0 })
	})

	it('passes a deterministic, controlled component in both capture checks', () => {
		expect(findingsOf(finding => finding.viewId === STABLE)).toEqual([])
		expect(findingsOf(finding => finding.component === 'label' || finding.widgetId === 'steady')).toEqual([])
	})

	it('reports a component that renders Math.random() or Date.now() as kit.nondeterministic_render', () => {
		const flagged = findingsOf(finding => finding.viewId === RANDOM)
		expect(flagged.map(finding => [finding.check, finding.code, finding.widgetId, finding.component]).sort()).toEqual([
			['repeat_capture', 'kit.nondeterministic_render', 'clock', 'clock'],
			['repeat_capture', 'kit.nondeterministic_render', 'dice', 'dice'],
		])
		expect(flagged[0]).toMatchObject({ widgetType: expect.stringMatching(/^Kit(Dice|Clock)$/), path: expect.stringMatching(/^\/components\/(dice|clock)$/) })
	})

	it('reports a component that copies a prop into local state as kit.state_not_controlled (Scenario c383)', () => {
		expect(findingsOf(finding => finding.viewId === STICKY)).toEqual([expect.objectContaining({
			check: 'live_versus_fresh',
			code: 'kit.state_not_controlled',
			viewId: STICKY,
			variantName: 'alt',
			widgetId: 'sticky',
			widgetType: 'KitSticky',
			component: 'sticky',
			path: '/components/sticky',
		})])
	})

	it('reports a registry component that declares neither props nor emits, without a code', () => {
		const flagged = findingsOf(finding => finding.check === 'props_emits')
		expect(flagged).toEqual([{ check: 'props_emits', path: '/components/bare', component: 'bare', message: expect.stringContaining('bare') }])
	})

	it('names no host path in any finding or check summary', () => {
		const text = JSON.stringify(result)
		expect(text).not.toContain(server.workspaceRoot)
		expect(text).not.toContain(process.cwd())
	})

	it('never blocks formal capture of a flagged render context', async () => {
		const response = await fetch(`${server.origin}/api/evidence/capture`, {
			method: 'POST',
			headers: { ...server.headers, 'content-type': 'application/json' },
			body: JSON.stringify({ contexts: [{ viewId: RANDOM, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId: 'dark' }] }),
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ status: 'ok', summary: { captured: 1 } })
	}, 60_000)

	it('stops starting render contexts at its deadline and reports the rest as not checked, never clean', async () => {
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		let calls = 0
		// The clock passes the deadline right after the run starts, before any render context.
		const service = createProductKitChecksService(persistence, {
			readProductKit: createProductKitAuthoringService(persistence).readProductKit,
			captureCookie: () => server.cookie,
			now: () => (calls++ === 0 ? 0 : RUN_DEADLINE_MS + 1),
		})
		const first = service.run({ baseUrl: server.origin })
		// One run at a time: a second request while it runs is answered busy.
		expect(await service.run({ baseUrl: server.origin })).toMatchObject({ status: 'busy', diagnostics: [{ code: 'checks.busy' }] })
		const outcome = await first
		expect(outcome).toMatchObject({
			status: 'incomplete',
			checks: {
				repeat_capture: { state: 'incomplete', checked: 0, unchecked: 6, diagnostics: [{ code: 'checks.limit_reached' }] },
				live_versus_fresh: { state: 'incomplete', checked: 0, unchecked: 2 },
				props_emits: { state: 'completed' },
			},
		})
		expect((outcome as typeof result).findings.filter(finding => finding.check === 'repeat_capture' || finding.check === 'live_versus_fresh')).toEqual([])
	}, 60_000)

	it('shows each check\'s state and the Product Kit findings in Overview › Checks after Run Checks', async () => {
		const browser = await chromium.launch({ headless: true })
		try {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'load' })
			await page.locator('[data-run-checks]').click()
			const live = page.locator('[data-kit-check="live_versus_fresh"]')
			await live.waitFor({ timeout: 15_000 })
			await expect.poll(() => live.getAttribute('data-kit-check-state'), { timeout: 60_000 }).toBe('completed')
			expect(await page.locator('[data-kit-check]').evaluateAll(rows => rows.map(row => [row.getAttribute('data-kit-check'), row.getAttribute('data-kit-check-state')])))
				.toEqual([['registry', 'completed'], ['repeat_capture', 'completed'], ['live_versus_fresh', 'completed'], ['props_emits', 'completed']])
			const tree = page.locator('[data-checks-tree]')
			await tree.waitFor()
			const text = await tree.textContent()
			expect(text).toContain('kit.state_not_controlled')
			expect(text).toContain('kit.nondeterministic_render')
			expect(text).toContain('Component declares no props or emits')
			expect(text).toContain('Variant alt · component sticky')
		}
		finally {
			await browser.close()
		}
	}, 120_000)

	it('runs for a Workbench session only, never for a bearer Token', async () => {
		const response = await fetch(`${server.origin}/api/product-kit/checks`, { method: 'POST', headers: { authorization: `Bearer ${server.token}` } })
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
	})
})
