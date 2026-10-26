import type { Page } from 'playwright'

import { canonicalJsonStringify } from '../../domain/canonical-json'
import {
	assertionWidgetId,
	widgetEventHolds,
	type InteractionAssertionInput,
	type InteractionResult,
	type InteractionStep,
} from '../../domain/evidence/interaction-replay'
import type { Diagnostic, JsonValue } from '../../domain/validation'
import { CAPTURE_HARNESS_GLOBAL, type CaptureHarnessHooks } from '../../preview/capture-harness-hooks'
import type { ProbedState } from '../../preview/interaction-probe'
import { withStepTimeout } from './capture-harness'

/** How long one step's browser action may take, and then the whole replay. */
export const INTERACTION_STEP_TIMEOUT_MS = 5_000
export const INTERACTION_REPLAY_TIMEOUT_MS = 60_000

export type InteractionReplayOutcome =
	| Readonly<{ status: 'replayed'; results: readonly InteractionResult[] }>
	| Readonly<{ status: 'failed'; diagnostics: readonly Diagnostic[] }>

/** The selector of a Widget's rendered element (`data-widget-id` is set on every Widget the Preview renders). */
export function widgetSelector(widgetId: string): string {
	return `[data-widget-id="${widgetId.replace(/["\\]/g, '\\$&')}"]`
}

/** What takes keyboard focus: a `type` or `press` step goes to the Widget's element when it matches, else to its first descendant that does. */
const FOCUSABLE_SELECTOR = 'input:not([type="hidden"]), textarea, select, button, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

const failed = (code: string, path: string, message: string): InteractionReplayOutcome => ({ status: 'failed', diagnostics: [{ code, path, message }] })

/** The code of a replay that left the Preview document (Clause 01a17762-b467-7da6-9a61-59c1af1ba6af). */
export const PREVIEW_LEFT_CODE = 'interaction.preview_left'
const HOOKS_MISSING = 'interaction.hooks_missing'

function stateHeld(state: ProbedState, value: JsonValue): boolean {
	return state.found && canonicalJsonStringify(state.value) === canonicalJsonStringify(value)
}

type HookArgs = Readonly<{ global: string; widgetId: string; name: string }>
type Hooked<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; outcome: InteractionReplayOutcome }>

/**
 * The shared replay engine (Rules 01a11544-66d9-7fcd-8400-93516ddf2857 and 01a115cd-c507-738d-abd7-7a4194761319):
 * executes a recipe's steps as real browser actions on the rendered Widgets of a Preview already open in the
 * formal capture harness, then decides each assertion from what the Runtime observed. The Events of the
 * assertions are watched before the first step. A step that cannot be performed (no such element, not
 * actionable, a timeout) fails the replay, and so does leaving the Preview document (a navigation, or a page
 * the actions opened); an assertion that does not hold is `fail`, never a failed replay.
 */
export async function replayInteractions(
	page: Page,
	recipe: Readonly<{ steps: readonly InteractionStep[]; assertions: readonly InteractionAssertionInput[] }>,
	options: Readonly<{ stepTimeoutMs?: number; timeoutMs?: number }> = {},
): Promise<InteractionReplayOutcome> {
	const stepTimeout = options.stepTimeoutMs ?? INTERACTION_STEP_TIMEOUT_MS
	let left: string | undefined
	const onNavigated = (frame: { parentFrame(): unknown }) => { if (frame.parentFrame() === null) left ??= 'The replay navigated away from the Preview document.' }
	const onPopup = () => { left ??= 'The replay opened another page.' }
	page.on('framenavigated', onNavigated)
	page.context().on('page', onPopup)
	const leftOutcome = (path: string, reason?: string) => failed(PREVIEW_LEFT_CODE, path, `${left ?? reason ?? 'The replay left the Preview document.'} The run is not recorded.`)
	const isLeft = (cause: unknown) => {
		const message = cause instanceof Error ? cause.message : String(cause)
		return !!left || message.includes(HOOKS_MISSING) || /Execution context was destroyed|Target (page, context or browser )?has been closed/i.test(message)
	}
	/** Runs a function in the page; a document that is gone, or that has no harness hooks, is the replay having left the Preview. */
	const inPage = async <T>(path: string, fn: (args: HookArgs) => Promise<T>, args: HookArgs): Promise<Hooked<T>> => {
		try {
			return { ok: true, value: await page.evaluate(fn, args) }
		}
		catch (cause) {
			if (isLeft(cause)) return { ok: false, outcome: leftOutcome(path, 'The replay left the Preview document, so its harness hooks are gone.') }
			throw cause
		}
	}
	const base = { global: CAPTURE_HARNESS_GLOBAL, widgetId: '', name: '' }

	const run = async (): Promise<InteractionReplayOutcome> => {
		for (const [index, assertion] of recipe.assertions.entries()) {
			if (!('widgetEvent' in assertion.expect)) continue
			const { widgetId, name } = assertion.expect.widgetEvent
			// An Event the Runtime does not declare cannot be watched: its assertion fails below.
			const watched = await inPage(`/assertions/${index}`, async ({ global, widgetId: id, name: event }) => {
				const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global]
				if (!hooks) throw new Error('interaction.hooks_missing')
				return await hooks.watchWidgetEvent(id, event)
			}, { ...base, widgetId, name })
			if (!watched.ok) return watched.outcome
		}
		for (const [index, step] of recipe.steps.entries()) {
			const locator = page.locator(widgetSelector(step.target.widgetId)).first()
			try {
				if (step.action === 'click') await locator.click({ timeout: stepTimeout })
				else if (step.action === 'hover') await locator.hover({ timeout: stepTimeout })
				else {
					// Keys go to the focused element, which a Widget's own element (a wrapper) is often not.
					const own = await locator.evaluate((element, selector) => element.matches(selector), FOCUSABLE_SELECTOR, { timeout: stepTimeout })
					const target = own ? locator : locator.locator(FOCUSABLE_SELECTOR).first()
					if (step.action === 'type') await target.pressSequentially(step.text!, { timeout: stepTimeout })
					else await target.press(step.key!, { timeout: stepTimeout })
				}
			}
			catch (cause) {
				if (isLeft(cause)) return leftOutcome(`/steps/${index}`)
				const reason = cause instanceof Error ? cause.message.split('\n')[0]! : String(cause)
				return failed('interaction.step_failed', `/steps/${index}`, `The ${step.action} on Widget ${step.target.widgetId} could not be performed: ${reason}`)
			}
			// Let what the action caused render and emit before the next one.
			const settled = await inPage(`/steps/${index}`, () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), base)
			if (!settled.ok) return settled.outcome
			if (left) return leftOutcome(`/steps/${index}`)
		}
		const occurrences = await inPage('/assertions', async ({ global }) => {
			const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global]
			if (!hooks) throw new Error('interaction.hooks_missing')
			return await hooks.widgetEventOccurrences()
		}, base)
		if (!occurrences.ok) return occurrences.outcome
		const results: InteractionResult[] = []
		for (const [index, assertion] of recipe.assertions.entries()) {
			if ('widgetEvent' in assertion.expect) {
				results.push(widgetEventHolds(assertion.expect.widgetEvent, occurrences.value) ? 'pass' : 'fail')
				continue
			}
			const { state } = assertion.expect
			const read = await inPage(`/assertions/${index}`, async ({ global, widgetId: id, name: key }) => {
				const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global]
				if (!hooks) throw new Error('interaction.hooks_missing')
				return await hooks.readWidgetState(id, key)
			}, { ...base, widgetId: assertionWidgetId(assertion.expect), name: state.key })
			if (!read.ok) return read.outcome
			results.push(stateHeld(read.value, state.value) ? 'pass' : 'fail')
		}
		return { status: 'replayed', results }
	}
	try {
		return await withStepTimeout(run(), options.timeoutMs ?? INTERACTION_REPLAY_TIMEOUT_MS, 'The interaction replay')
	}
	catch (cause) {
		return failed('interaction.replay_failed', '/steps', cause instanceof Error ? cause.message.split('\n')[0]! : String(cause))
	}
	finally {
		page.off('framenavigated', onNavigated)
		page.context().off('page', onPopup)
	}
}
