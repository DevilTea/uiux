import { chromium, type Browser, type Page } from 'playwright'

import { locateKitProject, type KitProject } from '../../adapters/kit-registry'
import { readKitSourceFile } from '../../adapters/kit-source-files'
import { declaredInterface, INTERFACE_SCRIPT_EXTENSIONS } from '../../domain/product-kit/component-interface'
import { validateProductKit, type ProductKit } from '../../domain/product-kit/schema'
import type { ResolvedRenderContext } from '../../domain/render-context/schema'
import type { Diagnostic } from '../../domain/validation'
import type { ViewResource } from '../../domain/views/schema'
import type { FileNativePersistence } from '../../persistence'
import { CAPTURE_HARNESS_GLOBAL, type CaptureHarnessHooks } from '../../preview/capture-harness-hooks'
import { resolveDefaultLocale, resolveDefaultThemeId, resolveDefaultViewport } from '../../preview/render-context-options'
import { deriveWidgetTree, flattenWidgetTree } from '../../preview/widget-tree'
import type { KitBuildStatus } from '../ports/kit-build'
import { ASSET_LOAD_FAILED_DIAGNOSTIC, captureHarnessScreenshot, HARNESS_LOAD_TIMEOUT_MS, openHarnessPreview, withStepTimeout, type HarnessCookie } from './capture-harness'
import { missingDefaultLocaleError } from './default-locale-gate'
import type { ProductKitRead } from './product-kit-authoring'

/**
 * The Product Kit Checks (Discussion #139 decision 7, issue #141 Part 14), run only when Run Checks
 * asks for them, never on the capture path, and always non-blocking (Rule
 * 01a11bb1-a88c-7d78-8633-1c3b55588910): their findings never gate Preview, capture, authoring or
 * the Handoff readiness claim.
 *
 * - `registry`: the Product Kit read's own problems, `kit.component_invalid` among them (Clause
 *   01a11bb1-8d03-7751-9173-b3c3f1ab7156).
 * - `repeat_capture` (C1, Rule 01a11bb1-a75d-7138-a5b9-8618c9c6c78c): each render context is
 *   captured twice, each time in a fresh browser context; screenshots that differ in any byte are
 *   `kit.nondeterministic_render`.
 * - `live_versus_fresh` (C2, Rule 01a11bb1-a7bf-74ae-9639-b39f246fa117): a Variant's State is written
 *   into a live Preview of the base state through the capture-harness hook, and its capture is
 *   compared with a fresh Runtime of the Variant (C1's first capture); a difference is
 *   `kit.state_not_controlled`, a component that does not follow its props (Clause
 *   01a11bb1-8980-7212-acad-4145928e5dc7).
 * - `props_emits` (C4, Rule 01a11bb1-a827-75e3-b05f-4099146cff2a): each registry component whose
 *   script files declare neither props nor emits, by a bounded source scan; Discussion #139 gives
 *   this finding no code.
 *
 * A capture difference is attributed to the Widgets whose own markup differs (each Widget element's
 * markup with its nested Widget elements left out), and through the Product Kit's `widgets` table to
 * the registry component that renders that Widget type. A difference with no Widget markup to show
 * for it is reported for the render context alone.
 *
 * Bounds: one run at a time per Workspace session (`busy` otherwise); at most
 * {@link MAX_CHECKED_CONTEXTS} render contexts, three page loads each, in one browser; each load
 * under the formal capture timeouts, and each in-page step (the font and image waits, the live
 * State write, the markup snapshot) under the same step timeout; and {@link RUN_DEADLINE_MS} for
 * the capture checks, at which the browser is closed and whatever is in flight is abandoned. A
 * context left out by a bound makes its check `incomplete`, never clean. No finding or diagnostic
 * carries a host path.
 *
 * The props and emits check reads kit sources, so it runs only for a caller holding
 * `product-kit.source.read`; without it the check is `incomplete` (owner ruling 1 of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18945630).
 */

export const PRODUCT_KIT_CHECKS = Object.freeze(['registry', 'repeat_capture', 'live_versus_fresh', 'props_emits'] as const)
export type ProductKitCheck = typeof PRODUCT_KIT_CHECKS[number]

export const KIT_NONDETERMINISTIC_RENDER = 'kit.nondeterministic_render'
export const KIT_STATE_NOT_CONTROLLED = 'kit.state_not_controlled'

/** The most render contexts (a View's base state or one of its Variants) one run captures. */
export const MAX_CHECKED_CONTEXTS = 12
/** No render context starts after this long into a run. */
export const RUN_DEADLINE_MS = 120_000
/** The most Widgets one capture difference is attributed to. */
export const MAX_WIDGETS_PER_DIFFERENCE = 20
/** The most Widget elements one capture's markup snapshot reads. */
export const MAX_SNAPSHOT_WIDGETS = 2000
/** The most registry components the props and emits check reads. */
export const MAX_SCANNED_COMPONENTS = 500
/** The largest component file the props and emits check reads, and the most it reads in all. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024
export const MAX_SCANNED_TOTAL_BYTES = 16 * 1024 * 1024

export type ProductKitCheckFinding = Readonly<{
	check: ProductKitCheck
	/** Absent for the props and emits check, which has no code. */
	code?: string
	path: string
	message: string
	component?: string
	viewId?: string
	variantName?: string
	widgetId?: string
	widgetType?: string
}>

export type ProductKitCheckSummary = Readonly<{
	state: 'completed' | 'incomplete' | 'failed'
	/** Render contexts (capture checks) or components (props and emits) checked. */
	checked: number
	/** Those a bound or a problem left unchecked. */
	unchecked: number
	/** Why the check failed or is incomplete. */
	diagnostics: readonly Diagnostic[]
}>

export type ProductKitChecksResult =
	| Readonly<{
		status: 'completed' | 'incomplete'
		checks: Readonly<Record<ProductKitCheck, ProductKitCheckSummary>>
		findings: readonly ProductKitCheckFinding[]
		executedAt: string
	}>
	/** The Workspace has no readable Product Kit file. */
	| Readonly<{ status: 'not_applicable'; diagnostics: readonly Diagnostic[]; executedAt: string }>
	/** Another run is in progress for this Workspace. */
	| Readonly<{ status: 'busy'; diagnostics: readonly Diagnostic[] }>

export type ProductKitChecksCommand = Readonly<{
	baseUrl?: string
	/** Whether the caller may read kit sources (`product-kit.source.read`); the props and emits check needs it. Default true. */
	readSource?: boolean
}>

export type ProductKitChecksService = Readonly<{
	run(command?: ProductKitChecksCommand): Promise<ProductKitChecksResult>
}>

/** The capture checks' run deadline passed while a render context was in flight. */
class RunDeadlineError extends Error {
	override name = 'RunDeadlineError'
}

type CheckContext = Readonly<{ view: ViewResource; context: ResolvedRenderContext; types: ReadonlyMap<string, string> }>
type Capture = Readonly<{ bytes: Uint8Array; widgets: Readonly<Record<string, string>> }>
type Tally = { checked: number; unchecked: number; failed: boolean; diagnostics: Diagnostic[] }

const tally = (): Tally => ({ checked: 0, unchecked: 0, failed: false, diagnostics: [] })

function summary(t: Tally): ProductKitCheckSummary {
	return { state: t.failed ? 'failed' : t.unchecked > 0 ? 'incomplete' : 'completed', checked: t.checked, unchecked: t.unchecked, diagnostics: t.diagnostics }
}

function escapePointer(value: string): string {
	return value.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false
	for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false
	return true
}

/** The Widget ids whose own markup differs between two captures, in the first capture's order. */
function differingWidgets(a: Capture, b: Capture): string[] {
	const ids = [...new Set([...Object.keys(a.widgets), ...Object.keys(b.widgets)])]
	return ids.filter(id => a.widgets[id] !== b.widgets[id])
}

/**
 * Runs in the Preview page: a hash of each Widget element's own markup, with nested Widget elements
 * replaced by a marker, keyed by Widget id (repeated ids are hashed together).
 */
function snapshotWidgetMarkup(input: Readonly<{ limit: number }>): Record<string, string> {
	const hash = (text: string): string => {
		let value = 0x811C9DC5
		for (let index = 0; index < text.length; index += 1) {
			value ^= text.charCodeAt(index)
			value = Math.imul(value, 0x01000193) >>> 0
		}
		return value.toString(16).padStart(8, '0')
	}
	const ready = document.querySelector('[data-preview-status="ready"]')
	const elements = ready ? Array.from(ready.querySelectorAll('[data-widget-id]')).slice(0, input.limit) : []
	const markup = new Map<string, string>()
	for (const element of elements) {
		const id = element.getAttribute('data-widget-id') ?? ''
		const clone = element.cloneNode(true) as Element
		for (const nested of Array.from(clone.querySelectorAll('[data-widget-id]')))
			nested.replaceWith(document.createComment(`widget:${nested.getAttribute('data-widget-id') ?? ''}`))
		markup.set(id, `${markup.get(id) ?? ''}${clone.outerHTML}`)
	}
	const result: Record<string, string> = {}
	for (const [id, text] of markup) result[id] = hash(text)
	return result
}

/**
 * Runs in the Preview page: waits until every `<img>` has loaded and decoded, or failed, but no
 * longer than `timeoutMs`, so an image loaded after the View mounts does not make two captures differ.
 */
async function settleImages(input: Readonly<{ timeoutMs: number }>): Promise<void> {
	const pending = Array.from(document.images, image => image.complete ? undefined : image.decode().catch(() => undefined))
	await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, input.timeoutMs))])
}

export function createProductKitChecksService(
	persistence: FileNativePersistence,
	options: Readonly<{
		readProductKit: () => Promise<ProductKitRead | undefined>
		serverOrigin?: string
		captureCookie?: () => HarnessCookie | undefined
		kitBuild?: () => KitBuildStatus
		/** Test seam: the clock the run deadline reads before each render context. */
		now?: () => number
		/** Test seam: {@link RUN_DEADLINE_MS}. */
		runDeadlineMs?: number
		/** Test seam: the in-page step timeout, {@link HARNESS_LOAD_TIMEOUT_MS} by default. */
		stepTimeoutMs?: number
		/** Test seam: {@link MAX_CHECKED_CONTEXTS}. */
		maxCheckedContexts?: number
		/** Test seam: how a render context's Preview is opened. */
		openPreview?: typeof openHarnessPreview
	}>,
): ProductKitChecksService {
	let running = false
	const now = options.now ?? Date.now
	const runDeadlineMs = options.runDeadlineMs ?? RUN_DEADLINE_MS
	const stepTimeoutMs = options.stepTimeoutMs ?? HARNESS_LOAD_TIMEOUT_MS
	const maxCheckedContexts = options.maxCheckedContexts ?? MAX_CHECKED_CONTEXTS
	const openPreview = options.openPreview ?? openHarnessPreview

	function baseUrlFor(command?: ProductKitChecksCommand): string {
		const port = process.env.PORT || process.env.NITRO_PORT || '3000'
		const host = process.env.HOST || process.env.NITRO_HOST || '127.0.0.1'
		const normalizedHost = (host === '0.0.0.0' || host === '::' || host === '') ? '127.0.0.1' : host
		return command?.baseUrl || options.serverOrigin || process.env.UIUX_SERVER_ORIGIN || process.env.UIUX_SERVER_URL || `http://${normalizedHost}:${port}`
	}

	/** The props and emits check over the registry, by a bounded scan of each component's script files. */
	async function checkPropsAndEmits(kit: ProductKit, project: KitProject, findings: ProductKitCheckFinding[]): Promise<Tally> {
		const t = tally()
		const names = Object.keys(kit.components).sort()
		let budget = MAX_SCANNED_TOTAL_BYTES
		for (const [position, name] of names.entries()) {
			if (position >= MAX_SCANNED_COMPONENTS || budget <= 0) {
				t.unchecked += names.length - position
				t.diagnostics.push({ code: 'checks.limit_reached', path: '/components', message: `The props and emits check reads at most ${MAX_SCANNED_COMPONENTS} components and ${MAX_SCANNED_TOTAL_BYTES} bytes per run; ${names.length - position} components were not checked.` })
				break
			}
			const scripts = kit.components[name]!.files.filter(file => INTERFACE_SCRIPT_EXTENSIONS.some(extension => file.endsWith(extension)))
			let props = false
			let emits = false
			let complete = scripts.length > 0
			for (const file of scripts) {
				const read = await readKitSourceFile(project, file, { maxBytes: Math.min(MAX_SCANNED_FILE_BYTES, budget) })
				if (read.status !== 'found') {
					complete = false
					continue
				}
				budget -= read.bytes.byteLength
				const declared = declaredInterface(file, new TextDecoder().decode(read.bytes))
				props ||= declared.props
				emits ||= declared.emits
				complete &&= declared.complete
				if (props || emits) break
			}
			if (props || emits) {
				t.checked += 1
				continue
			}
			if (!complete) {
				t.unchecked += 1
				t.diagnostics.push({ code: 'checks.component_unread', path: `/components/${escapePointer(name)}`, message: `Component ${name} has no script file the props and emits check could read in full.` })
				continue
			}
			t.checked += 1
			findings.push({ check: 'props_emits', path: `/components/${escapePointer(name)}`, component: name, message: `Component ${name} declares neither props nor emits in its source, so its rendering state and its changes have no declared interface.` })
		}
		return t
	}

	/** Every View's base state and Variants, in View key and Variant name order, at the default locale, viewport and theme. */
	async function renderContexts(): Promise<CheckContext[]> {
		const manifest = (await persistence.workspace.readInspected()).resource ?? undefined
		const locale = resolveDefaultLocale(manifest)
		const themeId = resolveDefaultThemeId(manifest)
		const viewport = resolveDefaultViewport(manifest)
		const contexts: CheckContext[] = []
		for (const viewId of [...await persistence.views.discoverKeys()].sort()) {
			const read = await persistence.views.readInspected(viewId)
			const view = read?.resource
			if (!view) continue
			const tree = deriveWidgetTree(view.ir)
			const types = new Map(tree.status === 'valid' ? flattenWidgetTree(tree.root).map(widget => [widget.id, widget.type] as const) : [])
			const base: ResolvedRenderContext = { viewId, locale, viewportId: viewport.id, viewport: { width: viewport.width, height: viewport.height }, themeId }
			contexts.push({ view, context: base, types })
			for (const variantName of Object.keys(view.variants ?? {}).sort())
				contexts.push({ view, context: { ...base, variantName }, types })
		}
		return contexts
	}

	function locationOf(target: CheckContext): string {
		return target.context.variantName
			? `View ${target.view.name || target.view.id}, Variant ${target.context.variantName}`
			: `View ${target.view.name || target.view.id}, base state`
	}

	/** The findings of one capture difference, one per differing Widget, or one for the context. */
	function attribute(check: 'repeat_capture' | 'live_versus_fresh', target: CheckContext, widgets: readonly string[], kit: ProductKit): ProductKitCheckFinding[] {
		const code = check === 'repeat_capture' ? KIT_NONDETERMINISTIC_RENDER : KIT_STATE_NOT_CONTROLLED
		const where = locationOf(target)
		const lead = check === 'repeat_capture'
			? `Two captures of the same render context (${where}) differ`
			: `A live Preview of ${where} with its State written in place differs from a fresh Runtime of it`
		const location = { viewId: target.context.viewId, ...(target.context.variantName ? { variantName: target.context.variantName } : {}) }
		if (widgets.length === 0) {
			return [{ check, code, path: `/views/${escapePointer(target.context.viewId)}`, ...location, message: `${lead}, though no Widget's markup does.` }]
		}
		return widgets.slice(0, MAX_WIDGETS_PER_DIFFERENCE).map((widgetId) => {
			const widgetType = target.types.get(widgetId)
			const mapping = widgetType ? kit.widgets[widgetType] : undefined
			const component = mapping && 'component' in mapping ? mapping.component : undefined
			const subject = `Widget ${widgetId}${widgetType ? ` (${widgetType}${component ? `, component ${component}` : ''})` : ''}`
			const tail = check === 'repeat_capture'
				? `${subject} renders different markup each time.`
				: `${subject} does not follow the State its props come from.`
			return {
				check,
				code,
				path: component ? `/components/${escapePointer(component)}` : widgetType ? `/widgets/${escapePointer(widgetType)}` : `/views/${escapePointer(target.context.viewId)}`,
				...location,
				widgetId,
				...(widgetType ? { widgetType } : {}),
				...(component ? { component } : {}),
				message: `${lead}: ${tail}`,
			}
		})
	}

	async function captureOnce(browser: Browser, baseUrl: string, context: ResolvedRenderContext, live?: string): Promise<Capture | Readonly<{ unavailable: Diagnostic }>> {
		const preview = await openPreview(browser, { baseUrl, context, cookie: options.captureCookie?.(), fontsTimeoutMs: stepTimeoutMs })
		try {
			const variant = context.variantName ?? live
			const path = `/views/${escapePointer(context.viewId)}${variant ? `/variants/${escapePointer(variant)}` : ''}`
			if (preview.status !== 'ready')
				return { unavailable: { code: 'preview.runtime_failed', path, message: `The Preview of this render context reported '${preview.previewStatus}', so it was not checked.` } }
			if (live !== undefined) {
				const diagnostics = await withStepTimeout(preview.page.evaluate(async ({ global, name }) => {
					const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global]
					return hooks ? await hooks.applyVariantStateLive(name) : [{ code: 'preview.runtime_failed', path: '/preview', message: 'The capture harness hooks are missing.' }]
				}, { global: CAPTURE_HARNESS_GLOBAL, name: live }), stepTimeoutMs, 'The live State write')
				if (diagnostics.length > 0)
					return { unavailable: { code: diagnostics[0]!.code, path, message: `The Variant's State could not be written into a live Preview, so it was not checked: ${diagnostics.map(d => d.message).join(' ')}` } }
			}
			const page: Page = preview.page
			// The in-page wait gives up after the step timeout; the outer bound only catches a stuck page.
			await withStepTimeout(page.evaluate(settleImages, { timeoutMs: stepTimeoutMs }), stepTimeoutMs * 2, 'The image wait')
			const bytes = await captureHarnessScreenshot(page)
			if (preview.assetLoadFailures() > 0)
				return { unavailable: { code: ASSET_LOAD_FAILED_DIAGNOSTIC.code, path, message: 'A bound Asset did not load in the Preview, so this render context was not checked.' } }
			const widgets = await withStepTimeout(page.evaluate(snapshotWidgetMarkup, { limit: MAX_SNAPSHOT_WIDGETS }), stepTimeoutMs, 'The markup snapshot')
			return { bytes, widgets }
		}
		finally {
			await preview.close()
		}
	}

	/** `task`, raced against the run deadline; a failure, a step timeout or the deadline leaves the render context unchecked. */
	async function guarded<T>(task: () => Promise<T>, path: string, deadline: Promise<never>): Promise<T | Readonly<{ unavailable: Diagnostic }>> {
		try {
			return await Promise.race([task(), deadline])
		}
		catch (cause) {
			if (cause instanceof RunDeadlineError)
				return { unavailable: { code: 'checks.limit_reached', path, message: `The run reached its ${runDeadlineMs / 1000} s limit while checking this render context, so it was not checked.` } }
			const timeout = cause instanceof Error && cause.name === 'TimeoutError'
			return { unavailable: { code: 'capture.execution_failed', path, message: timeout ? 'The Preview did not finish loading or a capture step within the capture timeout, so this render context was not checked.' : 'The capture browser failed while loading this render context, so it was not checked.' } }
		}
	}

	async function checkCaptures(kit: ProductKit, baseUrl: string, findings: ProductKitCheckFinding[], c1: Tally, c2: Tally): Promise<void> {
		const build = options.kitBuild?.()
		if (build && (build.state === 'building' || build.state === 'failed')) {
			const diagnostic: Diagnostic = { code: 'capture.kit_build_not_ready', path: '/product-kit/build', message: build.state === 'building' ? 'The capture checks wait for the kit build: a build is running. Run Checks again once the build is ready.' : 'The capture checks do not run while the last kit build has failed.' }
			for (const t of [c1, c2]) {
				t.failed = true
				t.diagnostics.push(diagnostic)
			}
			return
		}
		// Rule 01a115cd-b30b-706e-b8a2-46e62259156e: no Locale-dependent capture while the default
		// Locale has no Locale file.
		const localeError = await missingDefaultLocaleError(persistence)
		if (localeError) {
			for (const t of [c1, c2]) {
				t.failed = true
				t.diagnostics.push(localeError)
			}
			return
		}
		const contexts = await renderContexts()
		if (contexts.length === 0) return
		let browser: Browser
		try {
			browser = await chromium.launch({ headless: true })
		}
		catch {
			const diagnostic: Diagnostic = { code: 'capture.browser_launch_failed', path: '/capture', message: 'The capture browser could not be launched.' }
			for (const t of [c1, c2]) {
				t.failed = true
				t.diagnostics.push(diagnostic)
			}
			return
		}
		const started = now()
		// The run deadline: it closes the browser, which ends every page step in flight, and rejects
		// whatever the run is waiting on, so no hung step can keep the run (and its lock) forever.
		let expired = false
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(() => {
				expired = true
				reject(new RunDeadlineError())
				void browser.close().catch(() => undefined)
			}, runDeadlineMs)
		})
		deadline.catch(() => undefined)
		/** The Views whose base state C1 flagged: their Variants are not compared live. */
		const flaggedBases = new Set<string>()
		try {
			for (const [position, target] of contexts.entries()) {
				if (position >= maxCheckedContexts || expired || now() - started > runDeadlineMs) {
					const left = contexts.slice(position)
					c1.unchecked += left.length
					const leftVariants = left.filter(entry => entry.context.variantName !== undefined).length
					c2.unchecked += leftVariants
					const message = position >= maxCheckedContexts
						? `One run checks at most ${maxCheckedContexts} render contexts; ${left.length} were not checked.`
						: `The run reached its ${runDeadlineMs / 1000} s limit; ${left.length} render contexts were not checked.`
					c1.diagnostics.push({ code: 'checks.limit_reached', path: '/views', message })
					if (leftVariants > 0) c2.diagnostics.push({ code: 'checks.limit_reached', path: '/views', message })
					break
				}
				const variantName = target.context.variantName
				const path = `/views/${escapePointer(target.context.viewId)}${variantName ? `/variants/${escapePointer(variantName)}` : ''}`
				const first = await guarded(() => captureOnce(browser, baseUrl, target.context), path, deadline)
				const second = 'unavailable' in first ? first : await guarded(() => captureOnce(browser, baseUrl, target.context), path, deadline)
				if ('unavailable' in first || 'unavailable' in second) {
					const diagnostic = 'unavailable' in first ? first.unavailable : (second as { unavailable: Diagnostic }).unavailable
					c1.unchecked += 1
					c1.diagnostics.push(diagnostic)
					if (variantName) {
						c2.unchecked += 1
						c2.diagnostics.push(diagnostic)
					}
					continue
				}
				c1.checked += 1
				const nondeterministic = !sameBytes(first.bytes, second.bytes)
				if (nondeterministic) {
					findings.push(...attribute('repeat_capture', target, differingWidgets(first, second), kit))
					if (!variantName) flaggedBases.add(target.context.viewId)
				}
				if (!variantName) continue
				if (nondeterministic || flaggedBases.has(target.context.viewId)) {
					c2.unchecked += 1
					c2.diagnostics.push({ code: 'checks.nondeterministic_context', path, message: 'This render context does not capture the same way twice, so a live Preview of it was not compared with a fresh Runtime.' })
					continue
				}
				const base: ResolvedRenderContext = { ...target.context }
				delete (base as { variantName?: string }).variantName
				const live = await guarded(() => captureOnce(browser, baseUrl, base, variantName), path, deadline)
				if ('unavailable' in live) {
					c2.unchecked += 1
					c2.diagnostics.push(live.unavailable)
					continue
				}
				c2.checked += 1
				if (!sameBytes(first.bytes, live.bytes))
					findings.push(...attribute('live_versus_fresh', target, differingWidgets(first, live), kit))
			}
		}
		finally {
			clearTimeout(deadlineTimer)
			await browser.close().catch(() => undefined)
		}
	}

	async function run(command?: ProductKitChecksCommand): Promise<ProductKitChecksResult> {
		if (running) return { status: 'busy', diagnostics: [{ code: 'checks.busy', path: '/checks', message: 'The Product Kit Checks are already running for this Workspace; wait for that run to finish.' }] }
		running = true
		try {
			const read = await options.readProductKit()
			const codeDirectory = persistence.layout.codeDir
			if (!read || !codeDirectory) {
				return { status: 'not_applicable', executedAt: new Date().toISOString(), diagnostics: [{ code: 'checks.no_product_kit', path: '/product-kit', message: 'This Workspace has no Product Kit, so there is nothing for the Product Kit Checks to check.' }] }
			}
			const findings: ProductKitCheckFinding[] = []
			const registry = tally()
			for (const diagnostic of [...read.diagnostics, ...read.findings])
				findings.push({ check: 'registry', code: diagnostic.code, path: diagnostic.path, message: diagnostic.message })
			registry.checked = Object.keys(read.resource.components ?? {}).length

			const propsEmits = tally()
			const c1 = tally()
			const c2 = tally()
			const validation = validateProductKit(read.resource)
			if (!validation.ok) {
				const diagnostic: Diagnostic = { code: 'checks.product_kit_invalid', path: '/product-kit', message: 'The Product Kit file does not validate, so its components and Widget table were not checked.' }
				for (const t of [propsEmits, c1, c2]) {
					t.failed = true
					t.diagnostics.push(diagnostic)
				}
			}
			else {
				if (command?.readSource === false) {
					propsEmits.unchecked = Object.keys(validation.value.components).length
					propsEmits.diagnostics.push({ code: 'auth.scope_denied', path: '/components', message: 'The props and emits check reads kit sources, which needs product-kit.source.read, so no component was checked.' })
				}
				else {
					const project = await locateKitProject(persistence.root, codeDirectory)
					Object.assign(propsEmits, await checkPropsAndEmits(validation.value, project, findings))
				}
				await checkCaptures(validation.value, baseUrlFor(command), findings, c1, c2)
			}
			const checks = {
				registry: summary(registry),
				repeat_capture: summary(c1),
				live_versus_fresh: summary(c2),
				props_emits: summary(propsEmits),
			}
			const status = Object.values(checks).every(check => check.state === 'completed') ? 'completed' : 'incomplete'
			return { status, checks, findings, executedAt: new Date().toISOString() }
		}
		finally {
			running = false
		}
	}

	return { run }
}
