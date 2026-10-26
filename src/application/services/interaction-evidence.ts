import { canonicalJsonBytes } from '../../domain/canonical-json'
import {
	assertionWidgetId,
	INTERACTION_REPLAY_KIND,
	validateInteractionRecipeInput,
	type InteractionAssertion,
	type InteractionAssertionInput,
	type InteractionStep,
} from '../../domain/evidence/interaction-replay'
import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../../domain/evidence/schema'
import type { ResolvedRenderContext } from '../../domain/render-context/schema'
import { isFullUuid, isRecord, jsonPointer, type Diagnostic, type JsonObject, type JsonValue } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import type { CaptureFormalEvidenceCommand, CaptureFormalEvidenceResult, ReplayInteractionsCommand } from './formal-capture'
import { readViewReferenceTarget } from './flow-references'
import type { InteractionReplayOutcome } from './interaction-replay'

/** The render context an interaction record is captured in: the View and Variant is captured in it. */
export type InteractionRenderContext = Readonly<{ locale: string; viewportId: string; themeId: string }>

export type CaptureInteractionEvidenceCommand = Readonly<{
	viewId: string
	/** The Variant name; omitted for the base state. */
	variant?: string
	renderContext: InteractionRenderContext
	steps: readonly InteractionStep[]
	assertions: readonly InteractionAssertionInput[]
	baseUrl?: string
}>

/** The one formal capture a record references. */
export type InteractionCaptureSummary = Readonly<{ viewId: string; variantName?: string; evidenceDigest: string; screenshotDigest: string }>

export type CaptureInteractionEvidenceResult =
	| Readonly<{ status: 'captured'; viewId: string; evidenceDigest: string; evidence: FormalEvidenceRecord; captures: readonly InteractionCaptureSummary[] }>
	| Readonly<{ status: 'not_found'; viewId: string }>
	| Readonly<{ status: 'invalid'; viewId: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'failed'; viewId: string; diagnostics: readonly Diagnostic[] }>

export interface InteractionEvidenceService {
	capture(command: CaptureInteractionEvidenceCommand): Promise<CaptureInteractionEvidenceResult>
}

const invalid = (viewId: string, diagnostics: readonly Diagnostic[]): CaptureInteractionEvidenceResult => ({ status: 'invalid', viewId, diagnostics })

/**
 * Replayable interaction Evidence (Rules 01a115cd-c507-738d-abd7-7a4194761319 and 01a11544-55fa-7b7e-aec5-e71b1ba9a214,
 * Clauses 01a17762-b293-7157-aa2f-39a9c2ffbab5, 01a17762-b467-7da6-9a61-59c1af1ba6af, 01a17762-b631-7681-965d-80e97eb92809
 * and 01a17762-b85b-77d6-a399-e26843475501): the View and Variant is formally captured in the render context, the
 * recipe is replayed as real browser actions in its Preview, every assertion is decided, and the record that
 * references the capture is stored. An assertion that does not hold is recorded as `fail`; only an input the
 * Clauses refuse, or a replay that cannot run, records nothing.
 */
export function createInteractionEvidenceService(
	persistence: FileNativePersistence,
	input: Readonly<{
		captureFormal(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
		replay(command: ReplayInteractionsCommand): Promise<InteractionReplayOutcome>
	}>,
): InteractionEvidenceService {
	async function capture(command: CaptureInteractionEvidenceCommand): Promise<CaptureInteractionEvidenceResult> {
		const viewId = command.viewId
		if (!isFullUuid(viewId)) return { status: 'not_found', viewId }
		const target = await readViewReferenceTarget(persistence, viewId)
		if (target === null) return { status: 'not_found', viewId }

		const rawContext: unknown = command.renderContext
		if (!isRecord(rawContext) || ['locale', 'viewportId', 'themeId'].some(key => typeof rawContext[key] !== 'string' || rawContext[key] === ''))
			return invalid(viewId, [{ code: 'interaction.invalid_render_context', path: '/renderContext', message: 'renderContext is { locale, viewportId, themeId }, each a non-empty string.' }])
		const context = rawContext as InteractionRenderContext
		const variant = command.variant
		if (variant !== undefined && (typeof variant !== 'string' || variant === ''))
			return invalid(viewId, [{ code: 'interaction.invalid_recipe', path: '/variant', message: 'variant is a non-empty Variant name, or omitted for the base state.' }])

		const diagnostics: Diagnostic[] = [...validateInteractionRecipeInput({ viewId, ...(variant !== undefined ? { variant } : {}), steps: command.steps, assertions: command.assertions })]
		if (diagnostics.length === 0) {
			if (variant !== undefined && target.variantNames && !target.variantNames.has(variant))
				diagnostics.push({ code: 'interaction.unknown_variant', path: '/variant', message: `The View has no Variant ${variant}.` })
			if (target.widgetIds) {
				const known = target.widgetIds
				command.steps.forEach((step, index) => {
					if (!known.has(step.target.widgetId)) diagnostics.push({ code: 'interaction.unknown_widget', path: `${jsonPointer('/steps', index)}/target/widgetId`, message: `The View has no Widget ${step.target.widgetId}.` })
				})
				command.assertions.forEach((assertion, index) => {
					const widgetId = assertionWidgetId(assertion.expect, command.steps)
					if (widgetId !== undefined && !known.has(widgetId)) diagnostics.push({ code: 'interaction.unknown_widget', path: `/assertions/${index}/expect`, message: `The View has no Widget ${widgetId}.` })
				})
			}
		}
		if (diagnostics.length > 0) return invalid(viewId, diagnostics)

		const workspace = await persistence.workspace.readInspected()
		if (!workspace.resource || !workspace.revision)
			return { status: 'failed', viewId, diagnostics: [{ code: 'workspace.manifest_missing', path: '/workspace', message: 'Selected workspace manifest is missing or unreadable.' }] }
		const preset = workspace.resource.viewports?.[context.viewportId]
		if (!preset?.dimensions)
			return invalid(viewId, [{ code: 'render_context.unknown_viewport', path: '/renderContext/viewportId', message: `Viewport ${context.viewportId} does not exist in the Workspace.` }])

		const resolved: ResolvedRenderContext = {
			viewId,
			...(variant !== undefined ? { variantName: variant } : {}),
			locale: context.locale,
			viewportId: context.viewportId,
			viewport: { width: preset.dimensions.width, height: preset.dimensions.height },
			themeId: context.themeId,
		}
		const captured = await input.captureFormal({ contexts: [resolved], ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}) })
		const capturedResult = captured.results[0]
		if (captured.results.length !== 1 || !capturedResult || capturedResult.status !== 'captured' || !capturedResult.evidenceDigest || !capturedResult.evidence || !capturedResult.screenshotDigest) {
			const failures = captured.results.flatMap(result => result.status === 'captured' ? [] : result.diagnostics ?? [{ code: 'capture.execution_failed', path: '/capture', message: result.error ?? 'The capture failed.' }])
			const diagnostics = failures.length > 0 ? failures : [{ code: 'capture.execution_failed', path: '/capture', message: 'The capture failed.' }]
			// A render context key the Workspace does not have is the caller's input, not a failed capture.
			return diagnostics.every(item => item.code.startsWith('render_context.')) ? invalid(viewId, diagnostics) : { status: 'failed', viewId, diagnostics }
		}

		const replayed = await input.replay({ context: resolved, steps: command.steps, assertions: command.assertions, ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}) })
		if (replayed.status !== 'replayed') return { status: 'failed', viewId, diagnostics: replayed.diagnostics }

		const formal = capturedResult.evidence
		const assertions: InteractionAssertion[] = command.assertions.map((assertion, index) => ({ expect: assertion.expect, result: replayed.results[index]! }))
		const record: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: INTERACTION_REPLAY_KIND,
			// The resolved render context, exactly as the formal capture it references recorded it.
			executionContext: formal.executionContext,
			coverage: { complete: formal.coverage.complete },
			// The provenance of the capture it references (Clause 01a17762-b293-7157-aa2f-39a9c2ffbab5).
			provenance: formal.provenance,
			artifactRefs: [],
			evidenceRefs: [{ kind: 'formal_capture', evidence: capturedResult.evidenceDigest }],
			data: {
				steps: command.steps as unknown as JsonValue[],
				assertions: assertions as unknown as JsonValue[],
				captures: [capturedResult.evidenceDigest],
			} as JsonObject,
		}
		const validation = validateFormalEvidenceRecord(record)
		if (!validation.ok) return { status: 'failed', viewId, diagnostics: validation.diagnostics }
		const { identity: evidenceDigest } = await persistence.artifacts.put(canonicalJsonBytes(record))
		return {
			status: 'captured',
			viewId,
			evidenceDigest,
			evidence: record,
			captures: [{
				viewId,
				...(variant !== undefined ? { variantName: variant } : {}),
				evidenceDigest: capturedResult.evidenceDigest,
				screenshotDigest: capturedResult.screenshotDigest,
			}],
		}
	}
	return { capture }
}
