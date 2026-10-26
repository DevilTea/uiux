import type { Page } from 'playwright'

import { canonicalJsonStringify } from '../../domain/canonical-json'
import {
	assertionWidgetId,
	type InteractionAssertionInput,
	type InteractionResult,
	type InteractionStep,
} from '../../domain/evidence/interaction-replay'
import type { Diagnostic, JsonValue } from '../../domain/validation'
import { CAPTURE_HARNESS_GLOBAL, type CaptureHarnessHooks } from '../../preview/capture-harness-hooks'
import type { ProbedState, ProbedWidgetEvent } from '../../preview/interaction-probe'
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

/** Whether the Event occurrences hold one of `widgetId`'s Event `name`, with `payload` as its arguments when given. */
function eventHeld(occurrences: readonly ProbedWidgetEvent[], widgetId: string, name: string, payload: readonly JsonValue[] | undefined): boolean {
	return occurrences.some(occurrence => occurrence.widgetId === widgetId && occurrence.name === name
		&& (payload === undefined || canonicalJsonStringify(occurrence.args) === canonicalJsonStringify(payload)))
}

function stateHeld(state: ProbedState, value: JsonValue): boolean {
	return state.found && canonicalJsonStringify(state.value) === canonicalJsonStringify(value)
}

/**
 * The shared replay engine (Rules 01a11544-66d9-7fcd-8400-93516ddf2857 and 01a115cd-c507-738d-abd7-7a4194761319):
 * executes a recipe's steps as real browser actions on the rendered Widgets of a Preview already open in the
 * formal capture harness, then decides each assertion from what the Runtime observed. The Events of the
 * assertions are watched before the first step. A step that cannot be performed (no such element, not
 * actionable, a timeout) fails the replay; an assertion that does not hold is `fail`, never a failed replay.
 */
export async function replayInteractions(
	page: Page,
	recipe: Readonly<{ steps: readonly InteractionStep[]; assertions: readonly InteractionAssertionInput[] }>,
	options: Readonly<{ stepTimeoutMs?: number; timeoutMs?: number }> = {},
): Promise<InteractionReplayOutcome> {
	const stepTimeout = options.stepTimeoutMs ?? INTERACTION_STEP_TIMEOUT_MS
	const run = async (): Promise<InteractionReplayOutcome> => {
		for (const assertion of recipe.assertions) {
			if (!('widgetEvent' in assertion.expect)) continue
			const widgetId = assertionWidgetId(assertion.expect, recipe.steps)!
			// An Event the Runtime does not declare cannot be watched: its assertion fails below.
			await page.evaluate(async ([global, id, name]) => {
				const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global!]
				if (!hooks?.watchWidgetEvent) throw new Error('The capture harness hooks are missing.')
				return await hooks.watchWidgetEvent(id!, name!)
			}, [CAPTURE_HARNESS_GLOBAL, widgetId, assertion.expect.widgetEvent.name])
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
				const reason = cause instanceof Error ? cause.message.split('\n')[0]! : String(cause)
				return failed('interaction.step_failed', `/steps/${index}`, `The ${step.action} on Widget ${step.target.widgetId} could not be performed: ${reason}`)
			}
			// Let what the action caused render and emit before the next one.
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
		}
		const occurrences = await page.evaluate(async (global) => {
			const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global]
			if (!hooks?.widgetEventOccurrences) throw new Error('The capture harness hooks are missing.')
			return await hooks.widgetEventOccurrences()
		}, CAPTURE_HARNESS_GLOBAL)
		const results: InteractionResult[] = []
		for (const assertion of recipe.assertions) {
			const widgetId = assertionWidgetId(assertion.expect, recipe.steps)!
			if ('widgetEvent' in assertion.expect) {
				results.push(eventHeld(occurrences, widgetId, assertion.expect.widgetEvent.name, assertion.expect.widgetEvent.payload) ? 'pass' : 'fail')
				continue
			}
			const state = await page.evaluate(async ([global, id, key]) => {
				const hooks = (window as unknown as Record<string, CaptureHarnessHooks | undefined>)[global!]
				if (!hooks?.readWidgetState) throw new Error('The capture harness hooks are missing.')
				return await hooks.readWidgetState(id!, key!)
			}, [CAPTURE_HARNESS_GLOBAL, widgetId, assertion.expect.state.key])
			results.push(stateHeld(state, assertion.expect.state.value) ? 'pass' : 'fail')
		}
		return { status: 'replayed', results }
	}
	try {
		return await withStepTimeout(run(), options.timeoutMs ?? INTERACTION_REPLAY_TIMEOUT_MS, 'The interaction replay')
	}
	catch (cause) {
		return failed('interaction.replay_failed', '/steps', cause instanceof Error ? cause.message.split('\n')[0]! : String(cause))
	}
}
