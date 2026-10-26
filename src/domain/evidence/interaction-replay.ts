import { validateResolvedRenderContext } from '../render-context/schema'
import {
	isJsonValue,
	jsonPointer,
	rejectUnknownKeys,
	validateDigest,
	validateUuid,
	Validator,
	type Diagnostic,
	type JsonValue,
} from '../validation'

/**
 * The interaction replay Evidence record (Clauses 01a17762-b293-7157-aa2f-39a9c2ffbab5,
 * 01a17762-b467-7da6-9a61-59c1af1ba6af and 01a17762-b631-7681-965d-80e97eb92809, owner ruling 1 of
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19191424): a formal Evidence
 * record of `kind` `interaction_replay`. Its `data.steps` and `data.assertions` are the replay
 * recipe, which belongs to the record and is immutable with it (Rules 01a11544-66ad-73e5-8fcd-9e24bfcb3313
 * and 01a11544-6707-70a7-b544-590b4f1e8a91); the replay engine executes it against the Preview.
 */
export const INTERACTION_REPLAY_KIND = 'interaction_replay'

export const INTERACTION_ACTIONS = ['click', 'hover', 'type', 'press'] as const
export type InteractionAction = typeof INTERACTION_ACTIONS[number]

/** The bounds of Clauses 01a17762-b467-… and 01a17762-b631-…. */
export const MAX_INTERACTION_STEPS = 50
export const MAX_INTERACTION_ASSERTIONS = 50
export const MAX_INTERACTION_TEXT_LENGTH = 1000
export const MAX_INTERACTION_KEY_LENGTH = 64
export const MAX_INTERACTION_IDENTIFIER_LENGTH = 200
export const MAX_INTERACTION_JSON_BYTES = 8192
/** `steps` and `assertions` together, so a record stays within the 524288 bytes a reader of stored JSON artifacts reads. */
export const MAX_INTERACTION_RECIPE_BYTES = 262_144

export type InteractionStepTarget = Readonly<{ viewId: string; variant?: string; widgetId: string }>
export type InteractionStep = Readonly<{
	action: InteractionAction
	target: InteractionStepTarget
	/** The text a `type` step enters. */
	text?: string
	/** The key a `press` step presses, as Playwright names it. */
	key?: string
}>

export type InteractionExpectation =
	| Readonly<{ widgetEvent: Readonly<{ widgetId: string; name: string; payload?: readonly JsonValue[]; count?: number }> }>
	| Readonly<{ state: Readonly<{ widgetId: string; key: string; value: JsonValue }> }>
export type InteractionAssertionInput = Readonly<{ expect: InteractionExpectation }>
export type InteractionResult = 'pass' | 'fail'
export type InteractionAssertion = Readonly<{ expect: InteractionExpectation; result: InteractionResult }>

/** The `{ steps, assertions }` a caller gives, before the replay has decided any `result`. */
export type InteractionRecipeInput = Readonly<{ steps: readonly InteractionStep[]; assertions: readonly InteractionAssertionInput[] }>

type Codes = Readonly<{ shape: string; mismatch: string }>
/** The codes of an input the caller gave: non-normative (Clause 01a17762-b85b-77d6-a399-e26843475501). */
export const INTERACTION_INPUT_CODES: Codes = { shape: 'interaction.invalid_recipe', mismatch: 'interaction.recipe_mismatch' }
/** The codes of a stored record (Clause 01a17762-b631-7681-965d-80e97eb92809). */
export const INTERACTION_RECORD_CODES: Codes = { shape: 'evidence.invalid_interaction_replay', mismatch: 'evidence.interaction_replay_mismatch' }

function byteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length
}

/** The Widget an assertion is about: its own `widgetId`, required on every expectation (owner ruling 2 of #89 follow-up). */
export function assertionWidgetId(expect: InteractionExpectation): string {
	return 'widgetEvent' in expect ? expect.widgetEvent.widgetId : expect.state.widgetId
}

/** One observed Widget Event, as the Preview reports it. */
export type ObservedWidgetEvent = Readonly<{ widgetId: string; name: string; args: readonly JsonValue[] }>

/**
 * Whether a `widgetEvent` expectation holds (owner ruling 1 of the #89 follow-up): the occurrences of the named
 * Event of the Widget whose arguments equal `payload` (every occurrence when there is none) number `count` when
 * it is given, else at least one.
 */
export function widgetEventHolds(expectation: Readonly<{ widgetId: string; name: string; payload?: readonly JsonValue[]; count?: number }>, occurrences: readonly ObservedWidgetEvent[]): boolean {
	const wanted = expectation.payload === undefined ? undefined : JSON.stringify(canonicalize(expectation.payload))
	const matching = occurrences.filter(occurrence => occurrence.widgetId === expectation.widgetId && occurrence.name === expectation.name
		&& (wanted === undefined || JSON.stringify(canonicalize(occurrence.args)) === wanted)).length
	return expectation.count === undefined ? matching >= 1 : matching === expectation.count
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]))
	return value
}

function identifier(v: Validator, value: unknown, path: string, code: string, limit = MAX_INTERACTION_IDENTIFIER_LENGTH): void {
	if (typeof value !== 'string' || value === '' || value.length > limit) v.issue(code, path, `A non-empty string of at most ${limit} characters.`)
}

function validateJsonBound(v: Validator, value: unknown, path: string, code: string): void {
	if (!isJsonValue(value)) return v.issue(code, path, 'A JSON value is expected.')
	if (byteLength(value) > MAX_INTERACTION_JSON_BYTES) v.issue(code, path, `At most ${MAX_INTERACTION_JSON_BYTES} bytes of JSON.`)
}

/**
 * The browser action of a step, and of a Flow recipe's trigger `perform` (Clause 01a172cc-d6f0-714d-b2fb-bd66e13c73a5):
 * an `action`, the `text` of a `type` and the `key` of a `press`, each only where it belongs.
 */
export function validateInteractionAction(value: Readonly<Record<string, unknown>>, path: string, code: string, v: Validator): void {
	const action = typeof value.action === 'string' && (INTERACTION_ACTIONS as readonly string[]).includes(value.action) ? value.action : undefined
	if (!action) v.issue(code, `${path}/action`, `An action is one of ${INTERACTION_ACTIONS.join(', ')}.`)
	if (action === 'type') {
		if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_INTERACTION_TEXT_LENGTH)
			v.issue(code, `${path}/text`, `A type action has text of 1 to ${MAX_INTERACTION_TEXT_LENGTH} characters.`)
	}
	else if (Object.hasOwn(value, 'text')) v.issue(code, `${path}/text`, 'Only a type action has text.')
	if (action === 'press') identifier(v, value.key, `${path}/key`, code, MAX_INTERACTION_KEY_LENGTH)
	else if (Object.hasOwn(value, 'key')) v.issue(code, `${path}/key`, 'Only a press action has a key.')
}

/**
 * Checks the shape of `steps` and `assertions`: the one recipe format a record stores and a caller gives
 * (`requireResult` is true for the record, false for an input, which carries no `result`). A step's
 * target View and Variant are what `context` names; a mismatch is `codes.mismatch`.
 */
export function validateInteractionRecipe(
	steps: unknown,
	assertions: unknown,
	options: Readonly<{ context: Readonly<{ viewId?: string; variant?: string }>; requireResult: boolean; codes: Codes; stepsPath: string; assertionsPath: string }>,
	v: Validator,
): void {
	const { codes } = options
	const stepList = v.array(steps, options.stepsPath)
	if (stepList) {
		if (stepList.length === 0 || stepList.length > MAX_INTERACTION_STEPS)
			v.issue(codes.shape, options.stepsPath, `A recipe has 1 to ${MAX_INTERACTION_STEPS} steps.`)
		stepList.slice(0, MAX_INTERACTION_STEPS).forEach((value, index) => {
			const path = jsonPointer(options.stepsPath, index)
			const step = v.object(value, path)
			if (!step) return
			rejectUnknownKeys(step, ['action', 'target', 'text', 'key'], path, v)
			validateInteractionAction(step, path, codes.shape, v)
			const target = v.object(step.target, `${path}/target`)
			if (!target) return
			rejectUnknownKeys(target, ['viewId', 'variant', 'widgetId'], `${path}/target`, v)
			validateUuid(target.viewId, `${path}/target/viewId`, v, 'View identity')
			if (Object.hasOwn(target, 'variant')) identifier(v, target.variant, `${path}/target/variant`, codes.shape)
			identifier(v, target.widgetId, `${path}/target/widgetId`, codes.shape)
			if (options.context.viewId !== undefined && target.viewId !== options.context.viewId)
				v.issue(codes.mismatch, `${path}/target/viewId`, 'A step targets the View of the render context.')
			if (target.variant !== options.context.variant)
				v.issue(codes.mismatch, `${path}/target/variant`, 'A step targets the Variant of the render context, or the base state when it has none.')
		})
	}
	const assertionList = v.array(assertions, options.assertionsPath)
	if (!assertionList) return
	if (stepList && isJsonValue(stepList) && isJsonValue(assertionList) && byteLength([stepList, assertionList]) > MAX_INTERACTION_RECIPE_BYTES)
		v.issue(codes.shape, options.stepsPath, `Steps and assertions together have at most ${MAX_INTERACTION_RECIPE_BYTES} bytes of JSON.`)
	if (assertionList.length === 0 || assertionList.length > MAX_INTERACTION_ASSERTIONS)
		v.issue(codes.shape, options.assertionsPath, `A recipe has 1 to ${MAX_INTERACTION_ASSERTIONS} assertions.`)
	assertionList.slice(0, MAX_INTERACTION_ASSERTIONS).forEach((value, index) => {
		const path = jsonPointer(options.assertionsPath, index)
		const assertion = v.object(value, path)
		if (!assertion) return
		rejectUnknownKeys(assertion, options.requireResult ? ['expect', 'result'] : ['expect'], path, v)
		if (options.requireResult && assertion.result !== 'pass' && assertion.result !== 'fail')
			v.issue(codes.shape, `${path}/result`, 'A result is pass or fail.')
		const expect = v.object(assertion.expect, `${path}/expect`)
		if (!expect) return
		const kinds = ['widgetEvent', 'state'].filter(kind => Object.hasOwn(expect, kind))
		rejectUnknownKeys(expect, ['widgetEvent', 'state'], `${path}/expect`, v)
		if (kinds.length !== 1) return v.issue(codes.shape, `${path}/expect`, 'An expectation is exactly one of widgetEvent and state.')
		const body = v.object(expect[kinds[0]!], `${path}/expect/${kinds[0]}`)
		if (!body) return
		const bodyPath = `${path}/expect/${kinds[0]}`
		if (kinds[0] === 'widgetEvent') {
			rejectUnknownKeys(body, ['widgetId', 'name', 'payload', 'count'], bodyPath, v)
			identifier(v, body.name, `${bodyPath}/name`, codes.shape)
			if (Object.hasOwn(body, 'count') && (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 0 || body.count > 1000))
				v.issue(codes.shape, `${bodyPath}/count`, 'A count is an integer from 0 to 1000.')
			if (Object.hasOwn(body, 'payload')) {
				if (!Array.isArray(body.payload)) v.issue(codes.shape, `${bodyPath}/payload`, 'A payload is the JSON array of the Event\'s arguments.')
				else validateJsonBound(v, body.payload, `${bodyPath}/payload`, codes.shape)
			}
		}
		else {
			rejectUnknownKeys(body, ['widgetId', 'key', 'value'], bodyPath, v)
			identifier(v, body.key, `${bodyPath}/key`, codes.shape)
			if (!Object.hasOwn(body, 'value')) v.issue(codes.shape, `${bodyPath}/value`, 'A state assertion names the expected value.')
			else validateJsonBound(v, body.value, `${bodyPath}/value`, codes.shape)
		}
		identifier(v, body.widgetId, `${bodyPath}/widgetId`, codes.shape)
	})
}

/** The diagnostics of a tool or route input: `{ steps, assertions }` against the Clauses, for the View and Variant named. */
export function validateInteractionRecipeInput(input: Readonly<{ viewId: string; variant?: string; steps: unknown; assertions: unknown }>): readonly Diagnostic[] {
	const v = new Validator()
	validateInteractionRecipe(input.steps, input.assertions, {
		context: { viewId: input.viewId, ...(input.variant !== undefined ? { variant: input.variant } : {}) },
		requireResult: false,
		codes: INTERACTION_INPUT_CODES,
		stepsPath: '/steps',
		assertionsPath: '/assertions',
	}, v)
	return v.diagnostics
}

/**
 * Clauses 01a17762-b293-… and 01a17762-b631-…: an `interaction_replay` record. Whether its Widgets
 * still exist is not judged here (the record is immutable and the View may have changed); only its own
 * shape and the agreement of its steps, capture reference and Evidence references.
 */
export function validateInteractionReplayEvidence(record: Readonly<Record<string, unknown>>, path: string, v: Validator): void {
	const codes = INTERACTION_RECORD_CODES
	if (record.schemaVersion !== 1) v.issue(codes.shape, `${path}/schemaVersion`, 'An interaction_replay record has schemaVersion 1.')
	let context: { viewId?: string; variant?: string } = {}
	if (record.executionContext && typeof record.executionContext === 'object' && !Array.isArray(record.executionContext)) {
		const result = validateResolvedRenderContext(record.executionContext, `${path}/executionContext`)
		v.diagnostics.push(...result.diagnostics)
		const executionContext = record.executionContext as Record<string, unknown>
		rejectUnknownKeys(executionContext, ['viewId', 'variantName', 'locale', 'viewportId', 'viewport', 'themeId'], `${path}/executionContext`, v)
		context = {
			...(typeof executionContext.viewId === 'string' ? { viewId: executionContext.viewId } : {}),
			...(typeof executionContext.variantName === 'string' ? { variant: executionContext.variantName } : {}),
		}
	}
	if (Array.isArray(record.artifactRefs) && record.artifactRefs.length > 0)
		v.issue(codes.shape, `${path}/artifactRefs`, 'An interaction_replay record references its capture through evidenceRefs, not artifactRefs.')
	const data = v.object(record.data, `${path}/data`)
	if (!data) return
	rejectUnknownKeys(data, ['steps', 'assertions', 'captures'], `${path}/data`, v)
	validateInteractionRecipe(data.steps, data.assertions, {
		context,
		requireResult: true,
		codes,
		stepsPath: `${path}/data/steps`,
		assertionsPath: `${path}/data/assertions`,
	}, v)
	const captures = v.array(data.captures, `${path}/data/captures`)
	if (!captures) return
	if (captures.length !== 1) v.issue(codes.shape, `${path}/data/captures`, 'A record references exactly one formal capture.')
	captures.forEach((digest, index) => validateDigest(digest, jsonPointer(`${path}/data/captures`, index), v))
	const refs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []
	const listed = refs.map(ref => (ref && typeof ref === 'object' && (ref as Record<string, unknown>).kind === 'formal_capture' ? (ref as Record<string, unknown>).evidence : undefined))
	if (listed.length !== captures.length || listed.some((evidence, index) => evidence !== captures[index]))
		v.issue(codes.mismatch, `${path}/evidenceRefs`, 'evidenceRefs lists each capture of data.captures as a formal_capture reference.')
}
